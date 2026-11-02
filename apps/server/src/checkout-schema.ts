import type { PosDatabase } from "./db.js";

function addColumn(db: PosDatabase, table: string, definition: string): void {
  const column = definition.trim().split(/\s+/, 1)[0]!;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function applyCheckoutSchema(db: PosDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_products (
      product_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      product_code TEXT NOT NULL,
      name TEXT NOT NULL,
      price_incl_tax INTEGER NOT NULL CHECK(price_incl_tax >= 0),
      price_excl_tax INTEGER,
      tax_rate_bps INTEGER NOT NULL CHECK(tax_rate_bps IN (0, 800, 1000)),
      tax_category TEXT NOT NULL CHECK(tax_category IN ('inclusive_10','inclusive_8','exclusive_10','exclusive_8','exempt','non_taxable')),
      cost_yen INTEGER NOT NULL DEFAULT 0 CHECK(cost_yen >= 0),
      age_requirement INTEGER NOT NULL DEFAULT 0 CHECK(age_requirement IN (0,18,20)),
      inventory_tracked INTEGER NOT NULL DEFAULT 1 CHECK(inventory_tracked IN (0,1)),
      sale_state TEXT NOT NULL CHECK(sale_state IN ('on_sale','off_sale')),
      provisional INTEGER NOT NULL DEFAULT 0 CHECK(provisional IN (0,1)),
      updated_at TEXT NOT NULL,
      UNIQUE(event_id, product_code)
    );
    CREATE TABLE IF NOT EXISTS sale_drafts (
      draft_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      register_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      session_no INTEGER NOT NULL DEFAULT 1 CHECK(session_no BETWEEN 1 AND 9),
      cash_session_id TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      state TEXT NOT NULL CHECK(state IN ('editing','payment','finalizing','parked','completed','canceled')),
      park_reference TEXT,
      parked_at TEXT,
      completed_transaction_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(cash_session_id) REFERENCES cash_sessions(session_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sale_drafts_active_register ON sale_drafts(register_id) WHERE state IN ('editing','payment','finalizing');
    CREATE TABLE IF NOT EXISTS sale_draft_lines (
      line_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      unit_price_incl_tax INTEGER,
      tax_rate_bps INTEGER,
      tax_category TEXT,
      product_options_json TEXT NOT NULL DEFAULT '{}',
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      source TEXT NOT NULL CHECK(source IN ('manual','scan','bundle','hold')),
      bundle_instance_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','canceled')),
      manual_discount_kind TEXT CHECK(manual_discount_kind IN ('rate','amount')),
      manual_discount_value INTEGER CHECK(manual_discount_value >= 0),
      created_at TEXT NOT NULL,
      canceled_at TEXT,
      UNIQUE(draft_id, line_no),
      FOREIGN KEY(draft_id) REFERENCES sale_drafts(draft_id),
      FOREIGN KEY(product_id) REFERENCES event_products(product_id)
    );
    CREATE TABLE IF NOT EXISTS draft_payments (
      payment_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('cash','credit','accounts_receivable','no_charge')),
      amount_yen INTEGER NOT NULL CHECK(amount_yen >= 0),
      tendered_yen INTEGER,
      change_yen INTEGER,
      reference_note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(draft_id, sequence),
      FOREIGN KEY(draft_id) REFERENCES sale_drafts(draft_id)
    );
    CREATE TABLE IF NOT EXISTS draft_age_verifications (
      verification_id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      minimum_age INTEGER NOT NULL CHECK(minimum_age IN (18,20)),
      method TEXT NOT NULL CHECK(method IN ('appearance','id_visual','self_declaration')),
      result TEXT NOT NULL CHECK(result IN ('passed','failed')),
      confirmer_id TEXT,
      terminal_id TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      FOREIGN KEY(draft_id) REFERENCES sale_drafts(draft_id)
    );
    CREATE TABLE IF NOT EXISTS customer_display_states (
      register_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      public_projection_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS register_audio_settings (
      register_id TEXT PRIMARY KEY,
      tap_volume INTEGER NOT NULL DEFAULT 100 CHECK(tap_volume BETWEEN 0 AND 100),
      error_volume INTEGER NOT NULL DEFAULT 100 CHECK(error_volume BETWEEN 0 AND 100),
      system_error_volume INTEGER NOT NULL DEFAULT 100 CHECK(system_error_volume BETWEEN 0 AND 100),
      speech_volume INTEGER NOT NULL DEFAULT 100 CHECK(speech_volume BETWEEN 0 AND 100),
      speaker_id INTEGER NOT NULL DEFAULT 3 CHECK(speaker_id > 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audio_announcements (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id TEXT NOT NULL UNIQUE,
      register_id TEXT NOT NULL,
      target_role TEXT NOT NULL CHECK(target_role IN ('staff','customer')),
      target_terminal_id TEXT,
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 200),
      created_at TEXT NOT NULL,
      acknowledged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS age_confirmation_requests (
      request_id TEXT PRIMARY KEY,
      register_id TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      minimum_age INTEGER NOT NULL CHECK(minimum_age IN (18,20)),
      state TEXT NOT NULL CHECK(state IN ('requested','acknowledged','canceled')),
      requested_at TEXT NOT NULL,
      responded_at TEXT,
      FOREIGN KEY(draft_id) REFERENCES sale_drafts(draft_id)
    );
    CREATE TABLE IF NOT EXISTS public_reference_counters (
      event_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      session_no INTEGER NOT NULL CHECK(session_no BETWEEN 1 AND 9),
      next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 1000000),
      PRIMARY KEY(event_id, business_date, session_no)
    );
    CREATE TABLE IF NOT EXISTS transaction_lines (
      transaction_line_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      source_draft_line_id TEXT NOT NULL,
      product_id TEXT,
      product_code TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price_incl_tax INTEGER NOT NULL,
      tax_rate_bps INTEGER NOT NULL,
      tax_category TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      gross_yen INTEGER NOT NULL,
      discount_yen INTEGER NOT NULL,
      tax_yen INTEGER NOT NULL,
      net_yen INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(transaction_id, line_no),
      FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
    );
    CREATE TABLE IF NOT EXISTS applied_discounts (
      applied_discount_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      label_snapshot TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('auto','manual','no_charge')),
      value_kind TEXT NOT NULL CHECK(value_kind IN ('amount','rate')),
      value INTEGER NOT NULL,
      amount_yen INTEGER NOT NULL,
      application_no INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
    );
    CREATE TABLE IF NOT EXISTS applied_discount_lines (
      applied_discount_line_id TEXT PRIMARY KEY,
      applied_discount_id TEXT NOT NULL,
      transaction_line_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      allocated_amount_yen INTEGER NOT NULL,
      FOREIGN KEY(applied_discount_id) REFERENCES applied_discounts(applied_discount_id),
      FOREIGN KEY(transaction_line_id) REFERENCES transaction_lines(transaction_line_id)
    );
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('cash','credit','accounts_receivable','no_charge')),
      method_name_snapshot TEXT NOT NULL,
      amount_yen INTEGER NOT NULL,
      tendered_yen INTEGER,
      change_yen INTEGER,
      external_result TEXT,
      reference_note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(transaction_id, sequence),
      FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
    );
    CREATE TABLE IF NOT EXISTS tax_summaries (
      tax_summary_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      tax_rate_bps INTEGER NOT NULL,
      taxable_gross_yen INTEGER NOT NULL,
      discount_allocated_yen INTEGER NOT NULL,
      taxable_net_yen INTEGER NOT NULL,
      tax_amount_yen INTEGER NOT NULL,
      rounding_mode TEXT NOT NULL,
      UNIQUE(transaction_id, tax_rate_bps),
      FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
    );
    CREATE TABLE IF NOT EXISTS age_verifications (
      age_verification_id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      source_draft_verification_id TEXT NOT NULL,
      minimum_age INTEGER NOT NULL,
      method TEXT NOT NULL,
      result TEXT NOT NULL,
      confirmer_id TEXT,
      terminal_id TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
    );
    CREATE TABLE IF NOT EXISTS inventory_movements (
      inventory_movement_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('sale','distribution','return','adjustment')),
      quantity_delta INTEGER NOT NULL,
      transaction_line_id TEXT,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(product_id) REFERENCES event_products(product_id),
      FOREIGN KEY(transaction_line_id) REFERENCES transaction_lines(transaction_line_id)
    );
    CREATE TABLE IF NOT EXISTS inventory_balances (
      event_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      on_hand INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
      version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(event_id, product_id),
      FOREIGN KEY(product_id) REFERENCES event_products(product_id)
    );
    CREATE TABLE IF NOT EXISTS idempotency_records (
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(scope, idempotency_key),
      FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
    );
    CREATE TABLE IF NOT EXISTS printer_operations (
      operation_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('print','drawer')),
      payload_ref TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('queued','accepted','printing','completed','failed','unknown')),
      available_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);

  const saleDraftTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sale_drafts'").get() as { sql?: string } | undefined;
  if (saleDraftTable?.sql && !saleDraftTable.sql.includes("'parked'")) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      DROP INDEX IF EXISTS ux_sale_drafts_active_register;
      CREATE TABLE sale_drafts_migrated (
        draft_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, register_id TEXT NOT NULL, staff_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL, business_date TEXT NOT NULL, session_no INTEGER NOT NULL DEFAULT 1 CHECK(session_no BETWEEN 1 AND 9),
        cash_session_id TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        state TEXT NOT NULL CHECK(state IN ('editing','payment','finalizing','parked','completed','canceled')),
        completed_transaction_id TEXT, park_reference TEXT, parked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(cash_session_id) REFERENCES cash_sessions(session_id)
      );
      INSERT INTO sale_drafts_migrated(draft_id,event_id,register_id,staff_id,terminal_id,business_date,session_no,cash_session_id,version,state,completed_transaction_id,created_at,updated_at)
        SELECT draft_id,event_id,register_id,staff_id,terminal_id,business_date,session_no,cash_session_id,version,state,completed_transaction_id,created_at,updated_at FROM sale_drafts;
      DROP TABLE sale_drafts;
      ALTER TABLE sale_drafts_migrated RENAME TO sale_drafts;
      CREATE UNIQUE INDEX ux_sale_drafts_active_register ON sale_drafts(register_id) WHERE state IN ('editing','payment','finalizing');
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }

  addColumn(db, "transactions", "event_id TEXT");
  addColumn(db, "transactions", "business_day_id TEXT");
  addColumn(db, "transactions", "public_reference TEXT");
  addColumn(db, "transactions", "public_reference_display TEXT");
  addColumn(db, "transactions", "register_id TEXT");
  addColumn(db, "transactions", "staff_id TEXT");
  addColumn(db, "transactions", "type TEXT NOT NULL DEFAULT 'sale'");
  addColumn(db, "transactions", "subtotal_yen INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "transactions", "discount_total_yen INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "transactions", "tax_total_yen INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "transactions", "tax_rounding_mode TEXT NOT NULL DEFAULT 'floor'");
  addColumn(db, "transactions", "payment_kind TEXT");
  addColumn(db, "transactions", "draft_id TEXT");
  addColumn(db, "transactions", "draft_version INTEGER");
  addColumn(db, "transactions", "original_transaction_id TEXT");
  addColumn(db, "transactions", "reason_text TEXT");
  addColumn(db, "register_audio_settings", "system_error_volume INTEGER NOT NULL DEFAULT 100");
  addColumn(db, "event_products", "provisional INTEGER NOT NULL DEFAULT 0 CHECK(provisional IN (0,1))");
  addColumn(db, "sale_draft_lines", "unit_price_incl_tax INTEGER");
  addColumn(db, "sale_draft_lines", "tax_rate_bps INTEGER");
  addColumn(db, "sale_draft_lines", "tax_category TEXT");
  addColumn(db, "sale_draft_lines", "product_options_json TEXT NOT NULL DEFAULT '{}'");
  addColumn(db, "sale_drafts", "park_reference TEXT");
  addColumn(db, "sale_drafts", "parked_at TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS official_receipts (
    receipt_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, payee_name TEXT, memo TEXT,
    amount_yen INTEGER NOT NULL, issued_by TEXT NOT NULL, terminal_id TEXT NOT NULL,
    print_job_id TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id),
    FOREIGN KEY(print_job_id) REFERENCES print_jobs(job_id)
  );`);
  db.exec(`UPDATE sale_draft_lines
    SET unit_price_incl_tax = COALESCE(unit_price_incl_tax, (SELECT price_incl_tax FROM event_products WHERE product_id = sale_draft_lines.product_id)),
        tax_rate_bps = COALESCE(tax_rate_bps, (SELECT tax_rate_bps FROM event_products WHERE product_id = sale_draft_lines.product_id)),
        tax_category = COALESCE(tax_category, (SELECT tax_category FROM event_products WHERE product_id = sale_draft_lines.product_id))
    WHERE unit_price_incl_tax IS NULL OR tax_rate_bps IS NULL OR tax_category IS NULL;`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_public_reference ON transactions(event_id, public_reference) WHERE public_reference IS NOT NULL;");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_full_return ON transactions(original_transaction_id) WHERE type='return' AND original_transaction_id IS NOT NULL;");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_print_jobs_original_receipt ON print_jobs(transaction_id) WHERE document_type = 'receipt';");
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?) ON CONFLICT(version) DO NOTHING").run(new Date().toISOString());
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?) ON CONFLICT(version) DO NOTHING").run(new Date().toISOString());
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?) ON CONFLICT(version) DO NOTHING").run(new Date().toISOString());
  db.prepare("INSERT INTO app_metadata (key, value) VALUES ('schema_version', '6') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
}
