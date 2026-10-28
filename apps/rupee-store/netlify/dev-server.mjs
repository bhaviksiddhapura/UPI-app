#!/usr/bin/env node
/**
 * Minimal local runner for the Netlify site: serves src/public and routes /api/* to the functions
 * in netlify/functions using each function's `config.path` / `config.method`, with the same
 * web Request/Response handler shape Netlify uses. For local end-to-end testing only.
 *
 * Usage: DATABASE_URL=... STORE_ADMIN_TOKEN=... STORE_ENCRYPTION_KEY=... node netlify/dev-server.mjs [port]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../src/public');
const functionsDir = path.join(here, 'functions');
const port = Number(process.argv[2] || process.env.PORT || 8888);
process.env.URL ||= `http://localhost:${port}`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function compile(pattern) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  return pathname => {
    const m = re.exec(pathname);
    if (!m) return null;
    return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  };
}

const routes = [];
for (const file of fs.readdirSync(functionsDir).filter(f => f.endsWith('.mjs'))) {
  const mod = await import(pathToFileURL(path.join(functionsDir, file)).href);
  if (!mod.config?.path) continue;
  for (const p of [].concat(mod.config.path)) {
    routes.push({ match: compile(p), methods: [].concat(mod.config.method || []), handler: mod.default });
  }
}

http.createServer(async (req, res) => {
  // Like Netlify, the function sees the URL the client actually used.
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
  try {
    for (const route of routes) {
      const params = route.match(url.pathname);
      if (!params || (route.methods.length && !route.methods.includes(req.method))) continue;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
      });
      const context = { params, ip: req.socket.remoteAddress, site: { url: process.env.URL } };
      const response = await route.handler(request, context);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const full = path.resolve(publicDir, file);
    if (full.startsWith(publicDir + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(fs.readFileSync(full));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Not found"}');
  } catch (err) {
    console.error('[dev-server]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Internal error"}');
  }
}).listen(port, '127.0.0.1', () => console.log(`[dev-server] Netlify site emulation on http://localhost:${port}`));
