import type { PosDatabase } from "./db.js";

function addColumn(db: PosDatabase, table: string, definition: string): void {
  const column = definition.trim().split(/\s+/, 1)[0]!;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrateOperations(db: PosDatabase): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='printer_operations'").get() as { sql?: string } | undefined;
  if (table?.sql?.includes("retry_wait")) return;
  db.exec(`
    CREATE TABLE printer_operations_goal5 (
      operation_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('print','drawer')),
      printer_id TEXT NOT NULL DEFAULT 'receipt-1',
      payload_ref TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('pending','sending','completed','failed','retry_wait','canceled')),
      available_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 4 CHECK(max_attempts BETWEEN 1 AND 4),
      block_reason TEXT,
      lease_owner TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO printer_operations_goal5 (operation_id,sequence,kind,printer_id,payload_ref,state,available_at,attempt_count,max_attempts,created_at,updated_at)
      SELECT operation_id,sequence,kind,'receipt-1',payload_ref,
        CASE state WHEN 'queued' THEN 'pending' WHEN 'accepted' THEN 'sending' WHEN 'printing' THEN 'sending' WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'unknown' THEN 'failed' ELSE 'failed' END,
        available_at,attempt_count,4,created_at,created_at FROM printer_operations;
    DROP TABLE printer_operations;
    ALTER TABLE printer_operations_goal5 RENAME TO printer_operations;
  `);
}

export function applyPrintingSchema(db: PosDatabase): void {
  const now = new Date().toISOString();
  migrateOperations(db);
  for (const definition of [
    "operation_id TEXT", "kind TEXT NOT NULL DEFAULT 'original'", "source_job_id TEXT", "reprint_no INTEGER NOT NULL DEFAULT 0", "requested_by TEXT", "reason_code TEXT", "reason_text TEXT", "approval_id TEXT", "source_physical_outcome TEXT", "risk_accepted INTEGER NOT NULL DEFAULT 0", "self_approved INTEGER NOT NULL DEFAULT 0",
    "template_key TEXT", "template_version INTEGER", "template_source_sha256 TEXT", "asset_manifest_json TEXT NOT NULL DEFAULT '[]'", "font_id TEXT", "font_version INTEGER", "font_sha256 TEXT", "finishing_policy_id TEXT", "finishing_policy_version INTEGER",
    "receipt_snapshot_json TEXT", "canonical_ir TEXT", "ir_sha256 TEXT", "escpos_bytes BLOB", "expected_bytes_length INTEGER", "delivery_certainty TEXT NOT NULL DEFAULT 'not_sent'", "completion_evidence TEXT",
  ]) addColumn(db, "print_jobs", definition);
  db.exec(`
    DROP INDEX IF EXISTS ux_print_jobs_original_receipt;
    CREATE UNIQUE INDEX ux_print_jobs_original_receipt ON print_jobs(transaction_id) WHERE document_type='receipt' AND kind='original';
    CREATE TABLE IF NOT EXISTS print_attempts (
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatch_started','transport_accepted','postcheck_completed')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      compiler_bytes_sha256 TEXT NOT NULL,
      adapter_bytes_sha256 TEXT,
      write_bytes_sha256 TEXT,
      accepted_bytes INTEGER,
      result TEXT,
      error_code TEXT,
      error_message TEXT,
      status_snapshot_json TEXT,
      UNIQUE(job_id,attempt_no),
      FOREIGN KEY(job_id) REFERENCES print_jobs(job_id)
    );
    CREATE TABLE IF NOT EXISTS receipt_templates (
      template_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      source_text TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
      validated_source_sha256 TEXT,
      validation_json TEXT,
      validated_at TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      PRIMARY KEY(template_key,version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_receipt_templates_active ON receipt_templates(template_key) WHERE status='active';
    CREATE TABLE IF NOT EXISTS receipt_template_assets (
      template_key TEXT NOT NULL,
      template_version INTEGER NOT NULL,
      asset_id TEXT NOT NULL,
      asset_version INTEGER NOT NULL,
      mime TEXT NOT NULL,
      content_base64 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      width_dots INTEGER NOT NULL,
      height_dots INTEGER NOT NULL,
      PRIMARY KEY(template_key,template_version,asset_id),
      FOREIGN KEY(template_key,template_version) REFERENCES receipt_templates(template_key,version)
    );
    CREATE TABLE IF NOT EXISTS print_approvals (
      approval_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL CHECK(operation_type='reprint'),
      subject_job_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      self_approved INTEGER NOT NULL CHECK(self_approved IN (0,1)),
      risk_accepted INTEGER NOT NULL CHECK(risk_accepted IN (0,1)),
      reason TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_printer_operations_head ON printer_operations(printer_id,sequence);
    CREATE INDEX IF NOT EXISTS ix_print_attempts_job ON print_attempts(job_id,attempt_no);
  `);
  db.prepare("UPDATE print_jobs SET state=CASE state WHEN 'queued' THEN 'pending' WHEN 'accepted' THEN 'sending' WHEN 'printing' THEN 'sending' WHEN 'unknown' THEN 'failed' ELSE state END, delivery_certainty=CASE WHEN state='unknown' THEN 'unknown' WHEN state='completed' THEN 'accepted' ELSE COALESCE(delivery_certainty,'not_sent') END").run();
  db.prepare("INSERT INTO schema_migrations (version,applied_at) VALUES (5,?) ON CONFLICT(version) DO NOTHING").run(now);
  db.prepare("INSERT INTO app_metadata (key,value) VALUES ('schema_version','5') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
}
