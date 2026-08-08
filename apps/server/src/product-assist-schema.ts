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
    CREATE TABLE IF NOT EXISTS product_lookup_feedback (
      feedback_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      product_code TEXT NOT NULL,
      token TEXT NOT NULL,
      feedback TEXT NOT NULL CHECK (feedback IN ('negative','positive')),
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_product_lookup_feedback_token ON product_lookup_feedback(event_id, token, feedback);
    CREATE TABLE IF NOT EXISTS brave_search_usage (
      request_id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL,
      code TEXT NOT NULL,
      outcome TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_brave_search_usage_requested_at ON brave_search_usage(requested_at);
    CREATE TABLE IF NOT EXISTS yahoo_search_usage (
      request_id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL,
      code TEXT NOT NULL,
      outcome TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_yahoo_search_usage_requested_at ON yahoo_search_usage(requested_at);
    CREATE TABLE IF NOT EXISTS unregistered_product_scans (
      event_id TEXT NOT NULL,
      product_code TEXT NOT NULL,
      scan_count INTEGER NOT NULL DEFAULT 1 CHECK(scan_count >= 1),
      first_scanned_at TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL,
      last_actor_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','registered')),
      PRIMARY KEY(event_id, product_code)
    );
  `);
}
