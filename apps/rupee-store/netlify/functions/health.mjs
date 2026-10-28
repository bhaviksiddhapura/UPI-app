import { getSql, json, gatewayConfig } from '../lib/store.mjs';

export default async () => {
  try {
    const link = await gatewayConfig(getSql());
    return json(200, { status: 'UP', database: 'ok', gatewayLinked: link.ready });
  } catch (err) {
    console.error('[health]', err.message);
    return json(503, { status: 'DEGRADED', database: 'error' });
  }
};

export const config = { path: '/api/health', method: 'GET' };
