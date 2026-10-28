import { getSql, gatewayConfig, syncOpenOrders } from '../lib/store.mjs';

/**
 * Safety net: every minute, refresh orders that can still change from the gateway, so an order
 * settles correctly even if its webhook was lost and nobody has the page open.
 */
export default async () => {
  const sql = getSql();
  const link = await gatewayConfig(sql);
  if (!link.ready) return;
  const checked = await syncOpenOrders(sql, link.cfg, { limit: 25, budgetMs: 20000 });
  if (checked) console.log(`[sync-pending] refreshed ${checked} open order(s)`);
};

// Every minute (cron is UTC; the interval is the same in any time zone).
export const config = { schedule: '* * * * *' };
