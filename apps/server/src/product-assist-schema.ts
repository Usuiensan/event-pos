import type { PosDatabase } from "./db.js";

export function applyProductAssistSchema(db: PosDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_lookup_cache (
      cache_key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      code TEXT NOT NULL,
      result_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_lookup_adoptions (
      adoption_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      product_code TEXT NOT NULL,
      field_name TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_product_lookup_adoptions_product ON product_lookup_adoptions(event_id, product_code, created_at);
  `);
}
