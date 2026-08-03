import type { PosDatabase } from "./db.js";

export function applyHoldSchema(db: PosDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS holds (
      hold_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, business_session_id TEXT,
      business_date TEXT NOT NULL, session_no INTEGER NOT NULL CHECK(session_no BETWEEN 1 AND 999),
      public_reference TEXT NOT NULL, public_reference_display TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','claimed','released','carried')),
      created_by TEXT NOT NULL, terminal_id TEXT NOT NULL, created_at TEXT NOT NULL,
      claimed_draft_id TEXT, claimed_at TEXT, released_by TEXT, released_at TEXT, release_reason TEXT,
      carried_from_hold_id TEXT, UNIQUE(event_id, public_reference)
    );
    CREATE TABLE IF NOT EXISTS hold_lines (
      hold_line_id TEXT PRIMARY KEY, hold_id TEXT NOT NULL, product_id TEXT NOT NULL,
      product_code TEXT NOT NULL, product_name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
      created_at TEXT NOT NULL, FOREIGN KEY(hold_id) REFERENCES holds(hold_id),
      FOREIGN KEY(product_id) REFERENCES event_products(product_id)
    );
    CREATE INDEX IF NOT EXISTS ix_holds_event_state ON holds(event_id,state,created_at DESC);
  `);
  db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (10,?) ON CONFLICT(version) DO NOTHING").run(new Date().toISOString());
  db.prepare("INSERT INTO app_metadata(key,value) VALUES ('schema_version','10') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
}
