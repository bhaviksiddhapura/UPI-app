#!/usr/bin/env node
/**
 * Gives this gateway a public HTTPS address with a Cloudflare quick tunnel (no Cloudflare account
 * needed). The tunnel points at the checkout portal, which serves the customer checkout pages and
 * forwards /api/* to the payment API, so one address serves customers, the observer phone and the
 * Netlify store. Then it:
 *   - tells the Netlify store the new address (when linked with store:configure --store-url), and
 *   - writes the pairing QR page for the observer phone.
 * Keep this running while you take payments: the address changes every time it restarts, so the
 * phone must be paired again after a restart (the store is updated automatically).
 *
 * Needs `cloudflared` on PATH (Windows: winget install --id Cloudflare.cloudflared).
 * Usage: npm run observer:tunnel
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portalPort = Number(process.env.CHECKOUT_PORTAL_PORT || 7000);

function readStoreLink() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', '.secrets', 'rupee_store.json'), 'utf8'));
    return creds.storeUrl && creds.storeAdminToken ? creds : null;
  } catch {
    return null;
  }
}

/** Retries for a while: a brand-new quick-tunnel hostname takes a few seconds to resolve everywhere. */
async function linkStore(gatewayUrl) {
  const link = readStoreLink();
  if (!link) {
    console.log('  (No Netlify store linked yet; skipping. Link one with store:configure --store-url ...)');
    return;
  }
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${link.storeUrl}/api/admin/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.storeAdminToken}` },
        body: JSON.stringify({ gatewayUrl }),
        signal: AbortSignal.timeout(25000)
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`✔ ${link.storeUrl} now sends customers to ${gatewayUrl}`);
        return;
      }
      console.warn(`  Store link attempt ${attempt} failed (HTTP ${res.status}): ${body.error || ''}`);
      if (res.status === 401 || res.status === 400) return;
    } catch (err) {
      console.warn(`  Store link attempt ${attempt} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.error('✖ Could not update the Netlify store. Customers cannot pay until this succeeds; restart this command.');
}

const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${portalPort}`], {
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
  console.log(`\n✔ Tunnel ready: ${match[0]} -> http://localhost:${portalPort}`);
  // Give Cloudflare's edge a few seconds to start routing the new hostname.
  setTimeout(async () => {
    await linkStore(match[0]);
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
