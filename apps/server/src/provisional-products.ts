import { randomUUID } from "node:crypto";
import type { PosDatabase } from "./db.js";

export type UnregisteredProductDto = {
  productCode: string;
  name: string;
  priceInclTax: number;
  taxRate: 0 | 8 | 10;
  scanCount: number;
  firstScannedAt: string;
  lastScannedAt: string;
  lastActorId: string;
};

export function recordProvisionalProductScan(db: PosDatabase, input: {
  eventId: string;
  productCode: string;
  name: string;
  priceInclTax: number;
  taxRate: 0 | 8 | 10;
  actorId: string;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  const productId = `${input.eventId}:${input.productCode}`;
  const taxRateBps = input.taxRate * 100;
  const taxCategory = input.taxRate === 0 ? "non_taxable" : `inclusive_${input.taxRate}`;
  const existing = db.prepare("SELECT product_id, provisional FROM event_products WHERE event_id=? AND product_code=?").get(input.eventId, input.productCode) as { product_id: string; provisional: number } | undefined;
  if (existing && Number(existing.provisional) !== 1) throw new Error("商品マスタに登録済みの商品です。通常の商品登録を使用してください");
  if (!existing) {
    db.prepare(`INSERT INTO event_products (product_id,event_id,product_code,name,price_incl_tax,price_excl_tax,tax_rate_bps,tax_category,age_requirement,inventory_tracked,sale_state,provisional,updated_at)
      VALUES (?,?,?,?,?,?,?, ?,0,0,'on_sale',1,?)`).run(productId, input.eventId, input.productCode, input.name, input.priceInclTax, null, taxRateBps, taxCategory, now);
  } else {
    db.prepare("UPDATE event_products SET name=?,price_incl_tax=?,price_excl_tax=NULL,tax_rate_bps=?,tax_category=?,sale_state='on_sale',updated_at=? WHERE event_id=? AND product_code=? AND provisional=1")
      .run(input.name, input.priceInclTax, taxRateBps, taxCategory, now, input.eventId, input.productCode);
  }
  db.prepare("INSERT INTO inventory_balances(event_id,product_id,on_hand,reserved,version) VALUES(?,?,0,0,1) ON CONFLICT(event_id,product_id) DO NOTHING").run(input.eventId, existing?.product_id ?? productId);
  db.prepare(`INSERT INTO unregistered_product_scans(event_id,product_code,scan_count,first_scanned_at,last_scanned_at,last_actor_id,status)
    VALUES(?,?,1,?,?,?,'pending')
    ON CONFLICT(event_id,product_code) DO UPDATE SET scan_count=scan_count+1,last_scanned_at=excluded.last_scanned_at,last_actor_id=excluded.last_actor_id,status='pending'`)
    .run(input.eventId, input.productCode, now, now, input.actorId);
  db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?, 'provisional_product_scanned', 'event_product', ?, ?, ?)")
    .run(input.eventId, input.productCode, JSON.stringify({ actorId: input.actorId, priceInclTax: input.priceInclTax, taxRate: input.taxRate, requestId: randomUUID() }), now);
  return db.prepare("SELECT * FROM event_products WHERE event_id=? AND product_code=?").get(input.eventId, input.productCode) as Record<string, unknown>;
}

export function listUnregisteredProducts(db: PosDatabase, eventId: string): UnregisteredProductDto[] {
  const rows = db.prepare(`SELECT p.product_code AS productCode,p.name,p.price_incl_tax AS priceInclTax,p.tax_rate_bps AS taxRateBps,
      s.scan_count AS scanCount,s.first_scanned_at AS firstScannedAt,s.last_scanned_at AS lastScannedAt,s.last_actor_id AS lastActorId
    FROM unregistered_product_scans s JOIN event_products p ON p.event_id=s.event_id AND p.product_code=s.product_code
    WHERE s.event_id=? AND s.status='pending' AND p.provisional=1 ORDER BY s.last_scanned_at DESC`).all(eventId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ productCode: String(row.productCode), name: String(row.name), priceInclTax: Number(row.priceInclTax), taxRate: (Number(row.taxRateBps) / 100) as 0 | 8 | 10, scanCount: Number(row.scanCount), firstScannedAt: String(row.firstScannedAt), lastScannedAt: String(row.lastScannedAt), lastActorId: String(row.lastActorId) }));
}
