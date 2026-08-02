import { DatabaseSync } from "node:sqlite";
import type { CashCheck, PrintJob, PrintJobRequest, PrintJobStateUpdate } from "@event-pos/contracts";

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
           );
           CREATE TABLE IF NOT EXISTS cash_sessions (
             session_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, business_date TEXT NOT NULL, cashbox_id TEXT NOT NULL DEFAULT 'default',
             state TEXT NOT NULL, opening_yen INTEGER, closing_yen INTEGER, created_at TEXT NOT NULL
           );
           CREATE TABLE IF NOT EXISTS cash_checks (
             id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
             counted_json TEXT NOT NULL, theoretical_yen INTEGER NOT NULL, carryover_yen INTEGER NOT NULL,
             counted_yen INTEGER NOT NULL, difference_yen INTEGER NOT NULL, actor_id TEXT, terminal_id TEXT, created_at TEXT NOT NULL,
             FOREIGN KEY(session_id) REFERENCES cash_sessions(session_id)
           );
           CREATE TABLE IF NOT EXISTS cash_movements (
             id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, type TEXT NOT NULL,
             amount_yen INTEGER NOT NULL, transaction_id TEXT, reason TEXT NOT NULL, idempotency_key TEXT,
             actor_id TEXT, terminal_id TEXT, created_at TEXT NOT NULL,
             FOREIGN KEY(session_id) REFERENCES cash_sessions(session_id)
           );
           CREATE TABLE IF NOT EXISTS cash_session_actions (
             id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, action TEXT NOT NULL,
             reason TEXT NOT NULL, actor_id TEXT, terminal_id TEXT, created_at TEXT NOT NULL,
             FOREIGN KEY(session_id) REFERENCES cash_sessions(session_id)
           );
           CREATE TABLE IF NOT EXISTS transactions (
             transaction_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, total_yen INTEGER NOT NULL,
             idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
             FOREIGN KEY(session_id) REFERENCES cash_sessions(session_id)
           );`);
  const sessionColumns = db.prepare("PRAGMA table_info(cash_sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "cashbox_id")) db.exec("ALTER TABLE cash_sessions ADD COLUMN cashbox_id TEXT NOT NULL DEFAULT 'default'");
  const movementColumns = db.prepare("PRAGMA table_info(cash_movements)").all() as Array<{ name: string }>;
  if (!movementColumns.some((column) => column.name === "idempotency_key")) db.exec("ALTER TABLE cash_movements ADD COLUMN idempotency_key TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_movements_idempotency ON cash_movements(idempotency_key) WHERE idempotency_key IS NOT NULL;");
  const checkColumns = db.prepare("PRAGMA table_info(cash_checks)").all() as Array<{ name: string }>;
  if (!checkColumns.some((column) => column.name === "actor_id")) db.exec("ALTER TABLE cash_checks ADD COLUMN actor_id TEXT");
  if (!checkColumns.some((column) => column.name === "terminal_id")) db.exec("ALTER TABLE cash_checks ADD COLUMN terminal_id TEXT");
  if (!movementColumns.some((column) => column.name === "actor_id")) db.exec("ALTER TABLE cash_movements ADD COLUMN actor_id TEXT");
  if (!movementColumns.some((column) => column.name === "terminal_id")) db.exec("ALTER TABLE cash_movements ADD COLUMN terminal_id TEXT");
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

export function createCashSession(db: PosDatabase, sessionId: string, eventId: string, businessDate: string, cashboxId = "default"): void {
  if (!cashboxId.trim()) throw new Error("cashbox id is required");
  db.prepare("INSERT INTO cash_sessions (session_id, event_id, business_date, cashbox_id, state, created_at) VALUES (?, ?, ?, ?, 'open', ?)").run(sessionId, eventId, businessDate, cashboxId, new Date().toISOString());
}

export function reopenCashSession(db: PosDatabase, sessionId: string, reason: string, actorId: string | undefined, terminalId: string | undefined): void {
  if (!reason.trim()) throw new Error("再開理由が必要です");
  const session = db.prepare("SELECT event_id, state FROM cash_sessions WHERE session_id = ?").get(sessionId) as { event_id: string; state: string } | undefined;
  if (!session) throw new Error("cash session not found");
  if (session.state !== "closed") throw new Error("cash session is not closed");
  const now = new Date().toISOString();
  db.exec("BEGIN;");
  try {
    db.prepare("INSERT INTO cash_session_actions (session_id, action, reason, actor_id, terminal_id, created_at) VALUES (?, 'reopen', ?, ?, ?, ?)").run(sessionId, reason, actorId ?? null, terminalId ?? null, now);
    db.prepare("UPDATE cash_sessions SET state = 'open' WHERE session_id = ?").run(sessionId);
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, 'reopen', 'cash_session', ?, ?, ?)").run(session.event_id, sessionId, JSON.stringify({ reason, actorId, terminalId }), now);
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
}

export function saveCashCheck(db: PosDatabase, check: CashCheck): CashCheck {
  const session = db.prepare("SELECT event_id, state, opening_yen FROM cash_sessions WHERE session_id = ?").get(check.sessionId) as { event_id: string; state: string; opening_yen: number | null } | undefined;
  if (!session) throw new Error("cash session not found");
  if (session.state !== "open") throw new Error("cash session is closed");
  if (check.kind === "opening" && session.opening_yen !== null) throw new Error("opening check already exists");
  if (check.kind !== "opening" && session.opening_yen === null) throw new Error("opening check is required");
  db.exec("BEGIN;");
  try {
    db.prepare("INSERT INTO cash_checks (session_id, kind, counted_json, theoretical_yen, carryover_yen, counted_yen, difference_yen, actor_id, terminal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(check.sessionId, check.kind, JSON.stringify(check.counted), check.theoreticalYen, check.carryoverYen ?? 0, check.countedYen, check.differenceYen, check.actorId ?? null, check.terminalId ?? null, check.createdAt);
    if (check.kind === "opening") db.prepare("UPDATE cash_sessions SET opening_yen = ? WHERE session_id = ?").run(check.countedYen, check.sessionId);
    if (check.kind === "closing") db.prepare("UPDATE cash_sessions SET closing_yen = ?, state = 'closed' WHERE session_id = ?").run(check.countedYen, check.sessionId);
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, 'cash_check', ?, ?, ?)").run(session.event_id, check.kind, check.sessionId, JSON.stringify(check), check.createdAt);
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
  return check;
}

export type CashMovement = { sessionId: string; type: "sale" | "return" | "pay_in" | "pay_out"; amountYen: number; transactionId?: string; reason: string; idempotencyKey?: string; actorId?: string; terminalId?: string; createdAt: string };

export type SaleTransaction = { transactionId: string; sessionId: string; amountYen: number; idempotencyKey: string; reason: string; actorId?: string; terminalId?: string };

function saveCashTransaction(db: PosDatabase, sale: SaleTransaction, movementType: "sale" | "return"): { transactionId: string; sessionId: string; amountYen: number; createdAt: string } {
  if (!sale.transactionId || !sale.idempotencyKey || !Number.isSafeInteger(sale.amountYen) || sale.amountYen <= 0) throw new Error("取引が不正です");
  const session = db.prepare("SELECT event_id, state, opening_yen FROM cash_sessions WHERE session_id = ?").get(sale.sessionId) as { event_id: string; state: string; opening_yen: number | null } | undefined;
  if (!session) throw new Error("cash session not found");
  if (session.state !== "open") throw new Error("cash session is closed");
  if (session.opening_yen === null) throw new Error("opening check is required");
  const existing = db.prepare("SELECT transaction_id, session_id, total_yen, created_at FROM transactions WHERE idempotency_key = ?").get(sale.idempotencyKey) as { transaction_id: string; session_id: string; total_yen: number; created_at: string } | undefined;
  if (existing) {
    if (existing.session_id !== sale.sessionId || existing.total_yen !== sale.amountYen) throw new Error("idempotency key payload mismatch");
    return { transactionId: existing.transaction_id, sessionId: existing.session_id, amountYen: existing.total_yen, createdAt: existing.created_at };
  }
  const createdAt = new Date().toISOString();
  db.exec("BEGIN;");
  try {
    db.prepare("INSERT INTO transactions (transaction_id, session_id, total_yen, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?)").run(sale.transactionId, sale.sessionId, sale.amountYen, sale.idempotencyKey, createdAt);
    db.prepare("INSERT INTO cash_movements (session_id, type, amount_yen, transaction_id, reason, idempotency_key, actor_id, terminal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(sale.sessionId, movementType, sale.amountYen, sale.transactionId, sale.reason, `tx:${sale.idempotencyKey}`, sale.actorId ?? null, sale.terminalId ?? null, createdAt);
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, 'transaction', ?, ?, ?)").run(session.event_id, movementType, sale.transactionId, JSON.stringify({ sessionId: sale.sessionId, amountYen: sale.amountYen, actorId: sale.actorId, terminalId: sale.terminalId }), createdAt);
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
  return { transactionId: sale.transactionId, sessionId: sale.sessionId, amountYen: sale.amountYen, createdAt };
}

export const saveSaleTransaction = (db: PosDatabase, sale: SaleTransaction) => saveCashTransaction(db, sale, "sale");
export const saveReturnTransaction = (db: PosDatabase, sale: SaleTransaction) => saveCashTransaction(db, sale, "return");

export function saveCashMovement(db: PosDatabase, movement: CashMovement): CashMovement {
  if (!Number.isSafeInteger(movement.amountYen) || movement.amountYen <= 0 || !movement.reason.trim()) throw new Error("現金移動が不正です");
  const session = db.prepare("SELECT event_id, state, opening_yen FROM cash_sessions WHERE session_id = ?").get(movement.sessionId) as { event_id: string; state: string; opening_yen: number | null } | undefined;
  if (!session) throw new Error("cash session not found");
  if (session.state !== "open") throw new Error("cash session is closed");
  if (session.opening_yen === null) throw new Error("opening check is required");
  if (movement.idempotencyKey) {
    const existing = db.prepare("SELECT * FROM cash_movements WHERE idempotency_key = ?").get(movement.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      const same = existing.session_id === movement.sessionId && existing.type === movement.type && existing.amount_yen === movement.amountYen && existing.transaction_id === (movement.transactionId ?? null) && existing.reason === movement.reason;
      if (!same) throw new Error("idempotency key payload mismatch");
      return movement;
    }
  }
  db.exec("BEGIN;");
  try {
    db.prepare("INSERT INTO cash_movements (session_id, type, amount_yen, transaction_id, reason, idempotency_key, actor_id, terminal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(movement.sessionId, movement.type, movement.amountYen, movement.transactionId ?? null, movement.reason, movement.idempotencyKey ?? null, movement.actorId ?? null, movement.terminalId ?? null, movement.createdAt);
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, 'cash_movement', 'cash_movement', ?, ?, ?)").run(session.event_id, movement.sessionId, JSON.stringify(movement), movement.createdAt);
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
  return movement;
}

export function getTheoreticalCash(db: PosDatabase, sessionId: string): number {
  const session = db.prepare("SELECT opening_yen FROM cash_sessions WHERE session_id = ?").get(sessionId) as { opening_yen?: number } | undefined;
  if (!session) throw new Error("cash session not found");
  const row = db.prepare("SELECT COALESCE(SUM(CASE WHEN type IN ('sale', 'pay_in') THEN amount_yen ELSE -amount_yen END), 0) AS movement_yen FROM cash_movements WHERE session_id = ?").get(sessionId) as { movement_yen: number };
  return Number(session.opening_yen ?? 0) + Number(row.movement_yen);
}

export type CashJournalCandidate = { id: number; type: CashMovement["type"]; amountYen: number; transactionId?: string; reason: string; createdAt: string; score: number };

export type CashJournalSearch = { differenceYen: number; limit?: number; from?: string; to?: string; occurredAt?: string; actorId?: string; terminalId?: string; type?: CashMovement["type"] };

export function findCashJournalCandidates(db: PosDatabase, sessionId: string, search: CashJournalSearch): CashJournalCandidate[] {
  const { differenceYen, limit = 20, from, to, occurredAt, actorId, terminalId, type } = search;
  if (!Number.isSafeInteger(differenceYen) || differenceYen === 0) throw new Error("difference is invalid");
  const clauses = ["session_id = ?"]; const params: Array<string | number> = [sessionId];
  if (from) { clauses.push("created_at >= ?"); params.push(from); }
  if (to) { clauses.push("created_at <= ?"); params.push(to); }
  if (actorId) { clauses.push("actor_id = ?"); params.push(actorId); }
  if (terminalId) { clauses.push("terminal_id = ?"); params.push(terminalId); }
  if (type) { clauses.push("type = ?"); params.push(type); }
  const rows = db.prepare(`SELECT id, type, amount_yen, transaction_id, reason, created_at FROM cash_movements WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT 500`).all(...params) as Array<Record<string, unknown>>;
  const target = Math.abs(differenceYen);
  return rows.map((row) => {
    const amount = Number(row.amount_yen);
    const amountDistance = Math.abs(amount - target);
    const timeDistance = occurredAt ? Math.abs(Date.parse(String(row.created_at)) - Date.parse(occurredAt)) / 60000 : 0;
    const score = amountDistance + timeDistance;
    return { id: Number(row.id), type: row.type as CashMovement["type"], amountYen: amount, ...(row.transaction_id ? { transactionId: String(row.transaction_id) } : {}), reason: String(row.reason), createdAt: String(row.created_at), score };
  }).sort((a, b) => a.score - b.score || b.id - a.id).slice(0, Math.max(1, Math.min(100, Math.trunc(limit))));
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
