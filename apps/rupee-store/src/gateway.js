import crypto from 'node:crypto';
import { OrderStatus } from './orders.js';


export class GatewayClient {
  constructor(config) {
    this.config = config;
  }

  headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'X-Merchant-Id': this.config.merchantId,
      'X-Merchant-Key': this.config.merchantKey,
      ...extra
    };
  }

  async createPayment({ orderId, amountPaise, currency, returnUrl, metadata }) {
    const res = await fetch(`${this.config.gatewayApiUrl}/api/v1/payments`, {
      method: 'POST',
      headers: this.headers({ 'Idempotency-Key': orderId }),
      body: JSON.stringify({
        orderId,
        amount: (Number(amountPaise) / 100).toFixed(2),
        currency,
        returnUrl,
        metadata
      }),
      signal: AbortSignal.timeout(10000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Gateway returned HTTP ${res.status}`);
      err.status = res.status;
      err.code = body.code;
      throw err;
    }
    return body;
  }

  /** Authoritative read of a payment, authenticated with the merchant key. */
  async getPayment(paymentId) {
    const res = await fetch(`${this.config.gatewayApiUrl}/api/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error(`Gateway status read failed: HTTP ${res.status}`);
    return res.json();
  }
}

/**
 * Maps a gateway payment record onto a store order status, after checking that the record
 * really belongs to this order (same payment id, order id, amount and currency). Any mismatch
 * returns null and the order is left untouched.
 */
export function deriveOrderStatus(order, gw) {
  if (!gw || !order) return null;
  if (gw.paymentId !== order.paymentId) return null;
  if (gw.orderId !== order.id) return null;
  let gwPaise;
  try { gwPaise = BigInt(gw.amountPaise); } catch { return null; }
  if (gwPaise !== order.amountPaise) return null;
  if (String(gw.currency || '').toUpperCase() !== order.currency) return null;

  switch (gw.status) {
    case 'OBSERVED_SUCCESS':
    case 'RECONCILED':
      // Only a UPI credit is money received; COD / counter events never mark an order paid.
      if (gw.method !== 'UPI') return null;
      return { status: OrderStatus.PAID, settlementState: gw.settlementState || gw.status };
    case 'SUCCESS':
      // Cash on delivery / counter outcome: this store never offers those, so it is ignored.
      return null;
    case 'MANUAL_REVIEW':
      return { status: OrderStatus.REVIEW, settlementState: 'MANUAL_REVIEW' };
    case 'FAILED':
      return { status: OrderStatus.FAILED };
    case 'EXPIRED':
      return { status: OrderStatus.EXPIRED };
    case 'CANCELLED':
      return { status: OrderStatus.CANCELLED };
    default:
      return { status: OrderStatus.PENDING };
  }
}

/**
 * Verifies a gateway webhook. Uses the timestamped V2 signature (HMAC over "<timestamp>.<raw body>")
 * so the timestamp cannot be swapped, and rejects deliveries outside the tolerance window.
 * The tolerance covers the gateway's retry schedule; exact replays are caught by delivery-id dedupe.
 */
export function verifyWebhookSignature(rawBody, headers, secret, { toleranceMs = 2 * 60 * 60 * 1000, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'webhook secret not configured' };
  const sigHeader = String(headers['x-gateway-signature-v2'] || '');
  const timestamp = String(headers['x-gateway-timestamp'] || '');
  if (!sigHeader.startsWith('sha256=') || !/^\d{10,16}$/.test(timestamp)) {
    return { ok: false, reason: 'missing signature or timestamp' };
  }
  if (Math.abs(now - Number(timestamp)) > toleranceMs) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  let presented;
  try { presented = Buffer.from(sigHeader.slice('sha256='.length), 'hex'); } catch { presented = Buffer.alloc(0); }
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true };
}
