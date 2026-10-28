import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Store-side order states. Only the gateway (verified server-side) can move an order to PAID. */
export const OrderStatus = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  REVIEW: 'REVIEW',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

const FINAL = new Set([OrderStatus.PAID, OrderStatus.FAILED, OrderStatus.EXPIRED, OrderStatus.CANCELLED]);

export class OrderStore {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        payment_id TEXT UNIQUE,
        sku TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        settlement_state TEXT,
        utr TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paid_at TEXT
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        order_id TEXT,
        event TEXT,
        received_at TEXT NOT NULL
      );
    `);
  }

  create({ id, sku, amountPaise, currency }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO orders (id, sku, amount_paise, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, sku, amountPaise, currency, OrderStatus.PENDING, now, now);
    return this.get(id);
  }

  attachPayment(id, paymentId) {
    this.db.prepare('UPDATE orders SET payment_id = ?, updated_at = ? WHERE id = ?')
      .run(paymentId, new Date().toISOString(), id);
  }

  remove(id) {
    this.db.prepare('DELETE FROM orders WHERE id = ? AND payment_id IS NULL').run(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      paymentId: row.payment_id,
      sku: row.sku,
      amountPaise: BigInt(row.amount_paise),
      currency: row.currency,
      status: row.status,
      settlementState: row.settlement_state,
      utr: row.utr,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      paidAt: row.paid_at
    };
  }

  /**
   * Moves an order to a new state. A final state is never left again, so a late or replayed
   * FAILED/EXPIRED event cannot undo a PAID order, and nothing can turn a FAILED order into PAID
   * except a fresh, verified gateway read (handled by the caller before calling this).
   */
  transition(id, status, { settlementState = null, utr = null } = {}) {
    const order = this.get(id);
    if (!order) return null;
    const now = new Date().toISOString();
    if (order.status === OrderStatus.PAID) {
      // Allow enriching a paid order (UTR arrives with the webhook, RECONCILED arrives later).
      this.db.prepare(`
        UPDATE orders SET utr = COALESCE(utr, ?), settlement_state = COALESCE(?, settlement_state), updated_at = ?
        WHERE id = ?
      `).run(utr, settlementState, now, id);
      return this.get(id);
    }
    if (FINAL.has(order.status) && status !== OrderStatus.PAID) return order;
    this.db.prepare(`
      UPDATE orders SET status = ?, settlement_state = COALESCE(?, settlement_state), utr = COALESCE(?, utr),
        paid_at = CASE WHEN ? = 'PAID' THEN ? ELSE paid_at END, updated_at = ?
      WHERE id = ?
    `).run(status, settlementState, utr, status, now, now, id);
    return this.get(id);
  }

  /** Returns false when this webhook delivery id was already processed (replay / retry). */
  recordDelivery(deliveryId, orderId, event) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_deliveries (delivery_id, order_id, event, received_at) VALUES (?, ?, ?, ?)
    `).run(deliveryId, orderId, event, new Date().toISOString());
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}
