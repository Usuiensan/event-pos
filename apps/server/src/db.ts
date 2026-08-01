import { DatabaseSync } from "node:sqlite";
import type { PrintJob, PrintJobRequest, PrintJobStateUpdate } from "@event-pos/contracts";

export type PosDatabase = DatabaseSync;

export type CatalogRecord = { eventId: string; catalogJson: string; updatedAt: string };

export function openDatabase(filename = ":memory:"): PosDatabase {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS print_jobs (
             job_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, printer_id TEXT NOT NULL,
             document_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
             state TEXT NOT NULL, updated_at TEXT NOT NULL, error_message TEXT,
             source TEXT, source_event_id TEXT, renderer_version TEXT, bytes_sha256 TEXT
           );
           CREATE TABLE IF NOT EXISTS event_catalogs (
             event_id TEXT PRIMARY KEY, catalog_json TEXT NOT NULL, updated_at TEXT NOT NULL
           );
           CREATE TABLE IF NOT EXISTS audit_log (
             id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, action TEXT NOT NULL,
             entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
           );`);
  const existing = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
  if (!existing) {
    db.exec("BEGIN;");
    try {
      db.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("schema_version", "2");
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  const catalogMigration = db.prepare("SELECT version FROM schema_migrations WHERE version = 2").get();
  if (!catalogMigration) {
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, new Date().toISOString());
    db.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("schema_version", "2");
  }
  return db;
}

export function getCatalog(db: PosDatabase, eventId: string): CatalogRecord | undefined {
  const row = db.prepare("SELECT event_id, catalog_json, updated_at FROM event_catalogs WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
  return row ? { eventId: String(row.event_id), catalogJson: String(row.catalog_json), updatedAt: String(row.updated_at) } : undefined;
}

export function saveCatalog(db: PosDatabase, eventId: string, catalogJson: string, action = "upsert"): CatalogRecord {
  const updatedAt = new Date().toISOString();
  db.exec("BEGIN;");
  try {
    db.prepare("INSERT INTO event_catalogs (event_id, catalog_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET catalog_json = excluded.catalog_json, updated_at = excluded.updated_at").run(eventId, catalogJson, updatedAt);
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, 'event_catalog', ?, ?, ?)").run(eventId, action, eventId, catalogJson, updatedAt);
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
  return { eventId, catalogJson, updatedAt };
}

export function createPrintJob(db: PosDatabase, request: PrintJobRequest): PrintJob {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO print_jobs (job_id, transaction_id, printer_id, document_type, payload_json, created_at, state, updated_at, source, source_event_id, renderer_version, bytes_sha256)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`).run(
    request.jobId, request.transactionId, request.printerId, request.documentType,
    JSON.stringify(request.payload), request.createdAt, now, request.source ?? null, request.sourceEventId ?? null,
    request.rendererVersion ?? null, request.bytesSha256 ?? null,
  );
  const job = getPrintJob(db, request.jobId);
  if (!job) throw new Error("print job was not persisted");
  return job;
}

export function getPrintJob(db: PosDatabase, jobId: string): PrintJob | undefined {
  const row = db.prepare("SELECT * FROM print_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    jobId: String(row.job_id), transactionId: String(row.transaction_id), printerId: String(row.printer_id),
    documentType: String(row.document_type), payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at), state: row.state as PrintJob["state"], updatedAt: String(row.updated_at),
    ...(row.source ? { source: String(row.source) } : {}),
    ...(row.source_event_id ? { sourceEventId: String(row.source_event_id) } : {}),
    ...(row.renderer_version ? { rendererVersion: String(row.renderer_version) } : {}),
    ...(row.bytes_sha256 ? { bytesSha256: String(row.bytes_sha256) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
  };
}

export function updatePrintJob(db: PosDatabase, jobId: string, update: PrintJobStateUpdate): PrintJob | undefined {
  db.prepare("UPDATE print_jobs SET state = ?, updated_at = ?, error_message = ? WHERE job_id = ?")
    .run(update.state, new Date().toISOString(), update.errorMessage ?? null, jobId);
  return getPrintJob(db, jobId);
}
