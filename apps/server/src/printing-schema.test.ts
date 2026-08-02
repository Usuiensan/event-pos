import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyPrintingSchema } from "./printing-schema.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("printing schema migration", () => {
  it("旧job/operation状態をGoal 5状態へ移行し、reprintを許す部分unique indexへ置換する", () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE print_jobs (
        job_id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, printer_id TEXT NOT NULL,
        document_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        state TEXT NOT NULL, updated_at TEXT NOT NULL, error_message TEXT,
        source TEXT, source_event_id TEXT, renderer_version TEXT, bytes_sha256 TEXT
      );
      CREATE UNIQUE INDEX ux_print_jobs_original_receipt ON print_jobs(transaction_id) WHERE document_type='receipt';
      CREATE TABLE printer_operations (
        operation_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('print','drawer')), payload_ref TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('queued','accepted','printing','completed','failed','unknown')),
        available_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
    `);
    const now = "2026-08-02T00:00:00.000Z";
    for (const [index, state] of ["queued", "printing", "unknown"].entries()) {
      const id = `job-${index + 1}`;
      db.prepare("INSERT INTO print_jobs (job_id,transaction_id,printer_id,document_type,payload_json,created_at,state,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, `tx-${index + 1}`, "register-1", "receipt", "{}", now, state, now);
      db.prepare("INSERT INTO printer_operations (operation_id,sequence,kind,payload_ref,state,available_at,attempt_count,created_at) VALUES (?,?,'print',?,?,?,?,?)").run(`op-${index + 1}`, index + 1, id, state, now, 0, now);
    }

    applyPrintingSchema(db);

    expect(db.prepare("SELECT payload_ref,state FROM printer_operations ORDER BY sequence").all()).toEqual([
      { payload_ref: "job-1", state: "pending" }, { payload_ref: "job-2", state: "sending" }, { payload_ref: "job-3", state: "failed" },
    ]);
    expect(db.prepare("SELECT job_id,state,delivery_certainty FROM print_jobs ORDER BY job_id").all()).toEqual([
      { job_id: "job-1", state: "pending", delivery_certainty: "not_sent" },
      { job_id: "job-2", state: "sending", delivery_certainty: "not_sent" },
      { job_id: "job-3", state: "failed", delivery_certainty: "unknown" },
    ]);
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_print_jobs_original_receipt'").get() as { sql: string };
    expect(index.sql).toContain("kind='original'");
    expect(db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()).toEqual({ value: "5" });
  });
});
