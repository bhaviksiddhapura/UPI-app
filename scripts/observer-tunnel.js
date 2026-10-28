#!/usr/bin/env node
/**
 * Gives the observer phone an HTTPS address for this gateway with a Cloudflare quick tunnel
 * (no Cloudflare account needed), then writes the pairing QR page for that address.
 * Keep this running while you take payments: the address changes every time it restarts,
 * and the phone must be paired again after that.
 *
 * Needs `cloudflared` on PATH (Windows: winget install --id Cloudflare.cloudflared).
 * Usage: npm run observer:tunnel
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = Number(process.env.PAYMENT_API_PORT || 6100);

const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${apiPort}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false
});

tunnel.on('error', err => {
  console.error(`Could not start cloudflared (${err.message}).`);
  console.error('Install it first. Windows: winget install --id Cloudflare.cloudflared   macOS: brew install cloudflared');
  process.exit(1);
});

let paired = false;
function onOutput(chunk) {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
  if (!match || paired) return;
  paired = true;
  console.log(`\n✔ Tunnel ready: ${match[0]} -> http://localhost:${apiPort}`);
  // Give Cloudflare's edge a few seconds to start routing the new hostname.
  setTimeout(() => {
    spawnSync(process.execPath, [path.join(rootDir, 'scripts', 'observer-pairing.js'), '--url', match[0]], { stdio: 'inherit', cwd: rootDir });
    console.log('\nKeep this window open while you accept payments. Press Ctrl+C to close the tunnel.');
  }, 5000);
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('exit', code => {
  console.log(`cloudflared exited (${code}).`);
  process.exit(code || 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    tunnel.kill();
    process.exit(0);
  });
}
