import { DatabaseSync } from "node:sqlite";
import type { PrintJob, PrintJobRequest, PrintJobStateUpdate } from "@event-pos/contracts";

export type PosDatabase = DatabaseSync;

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
           );`);
  const existing = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
  if (!existing) {
    db.exec("BEGIN;");
    try {
      db.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run("schema_version", "1");
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  return db;
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
