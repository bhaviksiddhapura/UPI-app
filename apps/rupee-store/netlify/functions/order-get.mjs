import { ORDER_ID_RE } from '../../src/product.js';
import { getSql, gatewayConfig, json, getOrder, syncOrder, publicOrder } from '../lib/store.mjs';

export default async (req, context) => {
  const orderId = context.params?.id || '';
  if (!ORDER_ID_RE.test(orderId)) return json(404, { error: 'Order not found' });

  const sql = getSql();
  let order = await getOrder(sql, orderId);
  if (!order) return json(404, { error: 'Order not found' });

  const { cfg, ready } = await gatewayConfig(sql);
  if (ready) order = await syncOrder(sql, cfg, order, { source: 'customer page' });
  return json(200, publicOrder(order));
};

export const config = { path: '/api/orders/:id', method: 'GET' };
