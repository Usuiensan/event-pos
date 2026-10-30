import { DatabaseSync } from "node:sqlite";
import type { CashCheck, PrintJob, PrintJobRequest, PrintJobStateUpdate } from "@event-pos/contracts";
import { importEventCatalog, normalizePrintJobState } from "@event-pos/contracts";
import { applyCheckoutSchema } from "./checkout-schema.js";
import { applyPrintingSchema } from "./printing-schema.js";
import { ensureDefaultReceiptTemplate } from "./receipt-store.js";
import { canonicalizeReceiptDocument, type ReceiptDocument } from "@event-pos/receipt-ir";
import { DEFAULT_FINISHING_POLICY, bytesSha256, receiptDocumentToEscPos } from "@event-pos/escpos";
import { randomUUID } from "node:crypto";
import { applyBackupArtifactSchema, getBackupArtifact, reserveAutomaticBackupArtifact, type BackupArtifactRecord } from "./backup-artifact-schema.js";
import { applyBusinessSchema } from "./business-schema.js";
import { applyHoldSchema } from "./hold-schema.js";
import { applyProductAssistSchema } from "./product-assist-schema.js";

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
  if (!checkColumns.some((column) => column.name === "request_key")) db.exec("ALTER TABLE cash_checks ADD COLUMN request_key TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_checks_request_key ON cash_checks(request_key) WHERE request_key IS NOT NULL;");
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
  applyCheckoutSchema(db);
  applyPrintingSchema(db);
  applyBackupArtifactSchema(db);
  applyBusinessSchema(db);
  applyHoldSchema(db);
  applyProductAssistSchema(db);
  ensureDefaultReceiptTemplate(db);
  return db;
}

export function getCatalog(db: PosDatabase, eventId: string): CatalogRecord | undefined {
  const row = db.prepare("SELECT event_id, catalog_json, updated_at FROM event_catalogs WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
  return row ? { eventId: String(row.event_id), catalogJson: String(row.catalog_json), updatedAt: String(row.updated_at) } : undefined;
}

export function saveCatalog(db: PosDatabase, eventId: string, catalogJson: string, action = "upsert"): CatalogRecord {
  const updatedAt = new Date().toISOString();
  const catalog = importEventCatalog(catalogJson);
  db.exec("BEGIN;");
  try {
    db.prepare("INSERT INTO event_catalogs (event_id, catalog_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET catalog_json = excluded.catalog_json, updated_at = excluded.updated_at").run(eventId, catalogJson, updatedAt);
    for (const product of catalog.products) {
      const productId = `${eventId}:${product.productCode}`;
      db.prepare(`INSERT INTO event_products (product_id, event_id, product_code, name, price_incl_tax, price_excl_tax, tax_rate_bps, tax_category, age_requirement, sale_state, provisional, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(event_id, product_code) DO UPDATE SET name=excluded.name, price_incl_tax=excluded.price_incl_tax, price_excl_tax=excluded.price_excl_tax, tax_rate_bps=excluded.tax_rate_bps, tax_category=excluded.tax_category, age_requirement=excluded.age_requirement, sale_state=excluded.sale_state, provisional=0, updated_at=excluded.updated_at`)
        .run(productId, eventId, product.productCode, product.name, product.priceInclTax, product.priceExclTax ?? null, product.taxRate * 100, product.taxCategory, product.ageCheck === "18" ? 18 : product.ageCheck === "20" ? 20 : 0, product.saleState, updatedAt);
      db.prepare("INSERT INTO inventory_balances (event_id, product_id, on_hand, reserved, version) VALUES (?, ?, 0, 0, 1) ON CONFLICT(event_id, product_id) DO NOTHING").run(eventId, productId);
      db.prepare("UPDATE unregistered_product_scans SET status='registered' WHERE event_id=? AND product_code=? AND status='pending'").run(eventId, product.productCode);
    }
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, 'event_catalog', ?, ?, ?)").run(eventId, action, eventId, catalogJson, updatedAt);
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
  return { eventId, catalogJson, updatedAt };
}

export function createCashSession(db: PosDatabase, sessionId: string, eventId: string, businessDate: string, cashboxId = "default"): void {
  if (!cashboxId.trim()) throw new Error("cashbox id is required");
  db.prepare("INSERT INTO cash_sessions (session_id, event_id, business_date, cashbox_id, state, created_at) VALUES (?, ?, ?, ?, 'preparing', ?)").run(sessionId, eventId, businessDate, cashboxId, new Date().toISOString());
}

export type CashSessionSummary = {
  sessionId: string;
  eventId: string;
  businessDate: string;
  cashboxId: string;
  state: "preparing" | "open" | "closed";
  openingYen: number | null;
  closingYen: number | null;
  theoreticalYen: number;
  createdAt: string;
  checks: Array<{ id: number; kind: "opening" | "interim" | "closing"; theoreticalYen: number; countedYen: number; differenceYen: number; carryoverYen: number; actorId?: string; terminalId?: string; createdAt: string }>;
  movements: Array<{ id: number; type: CashMovement["type"]; amountYen: number; transactionId?: string; reason: string; actorId?: string; terminalId?: string; createdAt: string }>;
};

export type CashSettlementSummary = {
  cashSessionId: string; salesCount: number; salesYen: number; noChargeCount: number; noChargeYen: number;
  products: Array<{ productCode: string; name: string; quantity: number; salesYen: number }>;
  staff: Array<{ staffId: string; salesCount: number; salesYen: number }>;
  payments: Array<{ methodName: string; salesCount: number; salesYen: number }>;
  timeBands: Array<{ timeBand: string; salesCount: number; salesYen: number }>;
};

export function getCashSettlementSummary(db: PosDatabase, sessionId: string): CashSettlementSummary {
  const overall = db.prepare("SELECT COUNT(*) AS sales_count,COALESCE(SUM(total_yen),0) AS sales_yen FROM transactions WHERE session_id=?").get(sessionId) as { sales_count: number; sales_yen: number };
  const noCharge = db.prepare("SELECT COUNT(DISTINCT ad.transaction_id) AS no_charge_count,COALESCE(SUM(ad.amount_yen),0) AS no_charge_yen FROM applied_discounts ad JOIN transactions t ON t.transaction_id=ad.transaction_id WHERE t.session_id=? AND ad.kind='no_charge'").get(sessionId) as { no_charge_count: number; no_charge_yen: number };
  const products = db.prepare(`SELECT l.product_code AS product_code,l.product_name AS name,SUM(l.quantity) AS quantity,SUM(l.net_yen) AS sales_yen
    FROM transaction_lines l JOIN transactions t ON t.transaction_id=l.transaction_id WHERE t.session_id=? GROUP BY l.product_code,l.product_name ORDER BY l.product_code`).all(sessionId) as Array<{ product_code: string; name: string; quantity: number; sales_yen: number }>;
  const staff = db.prepare("SELECT COALESCE(staff_id,'未設定') AS staff_id,COUNT(*) AS sales_count,COALESCE(SUM(total_yen),0) AS sales_yen FROM transactions WHERE session_id=? GROUP BY staff_id ORDER BY staff_id").all(sessionId) as Array<{ staff_id: string; sales_count: number; sales_yen: number }>;
  const payments = db.prepare(`SELECT p.method_name_snapshot AS method_name,COUNT(DISTINCT p.transaction_id) AS sales_count,COALESCE(SUM(p.amount_yen),0) AS sales_yen
    FROM payments p JOIN transactions t ON t.transaction_id=p.transaction_id WHERE t.session_id=? GROUP BY p.method_name_snapshot ORDER BY p.method_name_snapshot`).all(sessionId) as Array<{ method_name: string; sales_count: number; sales_yen: number }>;
  const timeBands = db.prepare("SELECT strftime('%H:00',created_at,'+9 hours') AS time_band,COUNT(*) AS sales_count,COALESCE(SUM(total_yen),0) AS sales_yen FROM transactions WHERE session_id=? GROUP BY time_band ORDER BY time_band").all(sessionId) as Array<{ time_band: string; sales_count: number; sales_yen: number }>;
  return { cashSessionId: sessionId, salesCount: Number(overall.sales_count), salesYen: Number(overall.sales_yen), noChargeCount: Number(noCharge.no_charge_count), noChargeYen: Number(noCharge.no_charge_yen), products: products.map((row) => ({ productCode: row.product_code, name: row.name, quantity: Number(row.quantity), salesYen: Number(row.sales_yen) })), staff: staff.map((row) => ({ staffId: row.staff_id, salesCount: Number(row.sales_count), salesYen: Number(row.sales_yen) })), payments: payments.map((row) => ({ methodName: row.method_name, salesCount: Number(row.sales_count), salesYen: Number(row.sales_yen) })), timeBands: timeBands.map((row) => ({ timeBand: row.time_band, salesCount: Number(row.sales_count), salesYen: Number(row.sales_yen) })) };
}

export function getCashSessionSummary(db: PosDatabase, sessionId: string): CashSessionSummary | undefined {
  const session = db.prepare("SELECT * FROM cash_sessions WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
  if (!session) return undefined;
  const checks = (db.prepare("SELECT id,kind,theoretical_yen,counted_yen,difference_yen,carryover_yen,actor_id,terminal_id,created_at FROM cash_checks WHERE session_id=? ORDER BY id DESC LIMIT 50").all(sessionId) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id), kind: String(row.kind) as "opening" | "interim" | "closing", theoreticalYen: Number(row.theoretical_yen), countedYen: Number(row.counted_yen), differenceYen: Number(row.difference_yen), carryoverYen: Number(row.carryover_yen), ...(row.actor_id ? { actorId: String(row.actor_id) } : {}), ...(row.terminal_id ? { terminalId: String(row.terminal_id) } : {}), createdAt: String(row.created_at),
  }));
  const movements = (db.prepare("SELECT id,type,amount_yen,transaction_id,reason,actor_id,terminal_id,created_at FROM cash_movements WHERE session_id=? ORDER BY id DESC LIMIT 100").all(sessionId) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id), type: String(row.type) as CashMovement["type"], amountYen: Number(row.amount_yen), ...(row.transaction_id ? { transactionId: String(row.transaction_id) } : {}), reason: String(row.reason), ...(row.actor_id ? { actorId: String(row.actor_id) } : {}), ...(row.terminal_id ? { terminalId: String(row.terminal_id) } : {}), createdAt: String(row.created_at),
  }));
  return { sessionId: String(session.session_id), eventId: String(session.event_id), businessDate: String(session.business_date), cashboxId: String(session.cashbox_id), state: String(session.state) as "preparing" | "open" | "closed", openingYen: session.opening_yen === null ? null : Number(session.opening_yen), closingYen: session.closing_yen === null ? null : Number(session.closing_yen), theoreticalYen: getTheoreticalCash(db, sessionId), createdAt: String(session.created_at), checks, movements };
}

export function findCashSessionSummary(db: PosDatabase, eventId: string, businessDate: string, cashboxId: string): CashSessionSummary | undefined {
  const row = db.prepare("SELECT session_id FROM cash_sessions WHERE event_id=? AND business_date=? AND cashbox_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(eventId, businessDate, cashboxId) as { session_id: string } | undefined;
  return row ? getCashSessionSummary(db, row.session_id) : undefined;
}

export function reopenCashSession(db: PosDatabase, sessionId: string, reason: string, actorId: string | undefined, terminalId: string | undefined): void {
  if (!reason.trim()) throw new Error("再開理由が必要です");
  const session = db.prepare(`SELECT c.event_id,c.state,c.business_session_id,b.state AS business_state
    FROM cash_sessions c LEFT JOIN business_sessions b ON b.business_session_id=c.business_session_id WHERE c.session_id=?`).get(sessionId) as { event_id: string; state: string; business_session_id: string | null; business_state: string | null } | undefined;
  if (!session) throw new Error("cash session not found");
  if (session.state !== "closed") throw new Error("cash session is not closed");
  if (session.business_session_id && session.business_state !== "open") throw new Error("BUSINESS_NOT_OPEN: 営業全体を再開してからレジを再開してください");
  const now = new Date().toISOString();
  db.exec("BEGIN;");
  try {
    db.prepare("INSERT INTO cash_session_actions (session_id, action, reason, actor_id, terminal_id, created_at) VALUES (?, 'reopen', ?, ?, ?, ?)").run(sessionId, reason, actorId ?? null, terminalId ?? null, now);
    db.prepare("UPDATE cash_sessions SET state = 'open' WHERE session_id = ?").run(sessionId);
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, 'reopen', 'cash_session', ?, ?, ?)").run(session.event_id, sessionId, JSON.stringify({ reason, actorId, terminalId }), now);
    db.exec("COMMIT;");
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
}

export function saveCashCheck(db: PosDatabase, check: CashCheck, requestKey?: string): CashCheck & { printJobId: string; backupArtifact?: BackupArtifactRecord } {
  if (requestKey) {
    const existing = db.prepare("SELECT * FROM cash_checks WHERE request_key=?").get(requestKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.session_id !== check.sessionId || existing.kind !== check.kind || existing.counted_json !== JSON.stringify(check.counted) || Number(existing.carryover_yen) !== (check.carryoverYen ?? 0)) throw new Error("idempotency key payload mismatch");
      const transactionId = `cash-check:${check.sessionId}:${check.kind}:${String(existing.created_at)}`;
      const print = db.prepare("SELECT job_id FROM print_jobs WHERE transaction_id=? ORDER BY created_at LIMIT 1").get(transactionId) as { job_id: string } | undefined;
      const artifact = db.prepare("SELECT artifact_id FROM backup_artifacts WHERE source_cash_check_id=? ORDER BY requested_at LIMIT 1").get(Number(existing.id)) as { artifact_id: string } | undefined;
      const restored: CashCheck = { sessionId: String(existing.session_id), kind: String(existing.kind) as CashCheck["kind"], counted: JSON.parse(String(existing.counted_json)) as CashCheck["counted"], theoreticalYen: Number(existing.theoretical_yen), carryoverYen: Number(existing.carryover_yen), countedYen: Number(existing.counted_yen), differenceYen: Number(existing.difference_yen), ...(existing.actor_id ? { actorId: String(existing.actor_id) } : {}), ...(existing.terminal_id ? { terminalId: String(existing.terminal_id) } : {}), createdAt: String(existing.created_at) };
      const backupArtifact = artifact ? getBackupArtifact(db, artifact.artifact_id) : undefined;
      return { ...restored, printJobId: print?.job_id ?? "", ...(backupArtifact ? { backupArtifact } : {}) };
    }
  }
  const session = db.prepare("SELECT event_id, business_date, cashbox_id, state, opening_yen FROM cash_sessions WHERE session_id = ?").get(check.sessionId) as { event_id: string; business_date: string; cashbox_id: string; state: string; opening_yen: number | null } | undefined;
  if (!session) throw new Error("cash session not found");
  if (check.kind === "opening" && session.state !== "preparing") throw new Error("cash session is not preparing");
  if (check.kind !== "opening" && session.state !== "open") throw new Error("cash session is closed");
  if (check.kind === "opening" && session.opening_yen !== null) throw new Error("opening check already exists");
  if (check.kind !== "opening" && session.opening_yen === null) throw new Error("opening check is required");
  if (check.kind === "closing") {
    const activeDraft = db.prepare(`SELECT d.draft_id FROM sale_drafts d
      WHERE d.event_id=? AND d.register_id=? AND d.state IN ('editing','payment','finalizing')
        AND (EXISTS (SELECT 1 FROM sale_draft_lines l WHERE l.draft_id=d.draft_id AND l.status='active')
          OR EXISTS (SELECT 1 FROM draft_payments p WHERE p.draft_id=d.draft_id)) LIMIT 1`).get(session.event_id, session.cashbox_id);
    if (activeDraft) throw new Error("ACTIVE_DRAFTS_EXIST: 未確定の会計を完了または登録中止してください");
  }
  db.exec("BEGIN;");
  try {
    const savedCheck = db.prepare("INSERT INTO cash_checks (session_id, kind, counted_json, theoretical_yen, carryover_yen, counted_yen, difference_yen, actor_id, terminal_id, created_at, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(check.sessionId, check.kind, JSON.stringify(check.counted), check.theoreticalYen, check.carryoverYen ?? 0, check.countedYen, check.differenceYen, check.actorId ?? null, check.terminalId ?? null, check.createdAt, requestKey ?? null);
    if (check.kind === "opening") db.prepare("UPDATE cash_sessions SET opening_yen = ?, state = 'open' WHERE session_id = ?").run(check.countedYen, check.sessionId);
    if (check.kind === "closing") db.prepare("UPDATE cash_sessions SET closing_yen = ?, state = 'closed' WHERE session_id = ?").run(check.countedYen, check.sessionId);
    db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, 'cash_check', ?, ?, ?)").run(session.event_id, check.kind, check.sessionId, JSON.stringify(check), check.createdAt);
    const printJobId = enqueueCashCheckReceipt(db, session, check);
    const backupArtifact = check.kind === "interim" || check.kind === "closing" ? reserveAutomaticBackupArtifact(db, { eventId: session.event_id, businessDate: session.business_date, cashboxId: session.cashbox_id, cashSessionId: check.sessionId, cashCheckId: Number(savedCheck.lastInsertRowid), triggerKind: check.kind, ...(check.actorId ? { requestedBy: check.actorId } : {}), requestedAt: check.createdAt }) : undefined;
    if (backupArtifact) db.prepare("INSERT INTO audit_log (event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'backup_artifact_requested','backup_artifact',?,?,?)").run(session.event_id, backupArtifact.artifactId, JSON.stringify({ artifactId: backupArtifact.artifactId, triggerKind: backupArtifact.triggerKind, requestedBy: backupArtifact.requestedBy ?? null, sourceCashCheckId: backupArtifact.sourceCashCheckId, result: "pending" }), check.createdAt);
    db.exec("COMMIT;");
    return { ...check, printJobId, ...(backupArtifact ? { backupArtifact } : {}) };
  } catch (error) { db.exec("ROLLBACK;"); throw error; }
}

function yen(value: number): string { return `¥${value.toLocaleString("ja-JP")}`; }

function enqueueCashCheckReceipt(db: PosDatabase, session: { event_id: string; business_date: string; cashbox_id: string }, check: CashCheck): string {
  const labels = { opening: "開局", interim: "中間計", closing: "精算" } as const;
  const lines = check.counted.map((item) => ({ kind: "row" as const, left: `${item.denomination.toLocaleString("ja-JP")}円 × ${item.quantity}`, right: yen(item.denomination * item.quantity) }));
  const summary = check.kind === "opening" ? undefined : getCashSettlementSummary(db, check.sessionId);
  const section = (title: string, rows: Array<{ left: string; right: string }>) => [{ kind: "rule" as const, style: "double" as const }, { kind: "text" as const, value: title }, ...(rows.length ? rows.map((row) => ({ kind: "row" as const, ...row })) : [{ kind: "text" as const, value: "該当なし" }])];
  const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes: [
    { kind: "reset" }, { kind: "align", value: "center" }, { kind: "emphasis", bold: true, underline: false, invert: false }, { kind: "text", value: `${labels[check.kind]}レシート` }, { kind: "emphasis", bold: false, underline: false, invert: false },
    { kind: "align", value: "left" }, { kind: "text", value: `営業日 ${session.business_date}` }, { kind: "text", value: `現金箱 ${session.cashbox_id}` }, { kind: "rule", style: "single" },
    ...lines, { kind: "rule", style: "single" }, { kind: "row", left: "理論現金", right: yen(check.theoreticalYen) }, { kind: "row", left: "実在高", right: yen(check.countedYen) }, { kind: "row", left: "過不足", right: yen(check.differenceYen) },
    ...(check.kind === "closing" ? [{ kind: "row" as const, left: "翌日残し", right: yen(check.carryoverYen ?? 0) }] : []), { kind: "feed", lines: 8 }, { kind: "cut", mode: "partial" },
  ] };
  if (summary) document.nodes.splice(-2, 0,
    ...section("売上集計", [{ left: "取引件数", right: `${summary.salesCount}件` }, { left: "売上合計", right: yen(summary.salesYen) }, ...(summary.noChargeCount > 0 ? [{ left: "うち無配", right: `${summary.noChargeCount}件 ${yen(summary.noChargeYen)}` }] : [])]),
    ...section("商品別", summary.products.map((row) => ({ left: `${row.name.slice(0, 14)} ×${row.quantity}`, right: yen(row.salesYen) }))),
    ...section("担当者別", summary.staff.map((row) => ({ left: `${row.staffId} ${row.salesCount}件`, right: yen(row.salesYen) }))),
    ...section("決済手段別", summary.payments.map((row) => ({ left: `${row.methodName.slice(0, 14)} ${row.salesCount}件`, right: yen(row.salesYen) }))),
    ...section("時間帯別（JST）", summary.timeBands.map((row) => ({ left: `${row.timeBand} ${row.salesCount}件`, right: yen(row.salesYen) }))),
  );
  const canonicalIr = canonicalizeReceiptDocument(document); const bytes = receiptDocumentToEscPos(document); const jobId = randomUUID(); const operationId = randomUUID();
  db.prepare("INSERT INTO print_jobs (job_id,operation_id,transaction_id,printer_id,document_type,kind,payload_json,created_at,state,updated_at,source,renderer_version,bytes_sha256,finishing_policy_id,finishing_policy_version,canonical_ir,ir_sha256,escpos_bytes,expected_bytes_length,delivery_certainty) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'not_sent')")
    .run(jobId, operationId, `cash-check:${check.sessionId}:${check.kind}:${check.createdAt}`, "receipt-1", "cash-check", check.kind, JSON.stringify({ escposBase64: Buffer.from(bytes).toString("base64"), cashCheck: check, settlementSummary: summary, eventId: session.event_id }), check.createdAt, "pending", check.createdAt, "event-pos", "event-pos-cash-check-v3", bytesSha256(bytes), DEFAULT_FINISHING_POLICY.id, DEFAULT_FINISHING_POLICY.version, canonicalIr, bytesSha256(new TextEncoder().encode(canonicalIr)), Buffer.from(bytes), bytes.length);
  const sequence = Number((db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM printer_operations").get() as { next: number }).next);
  db.prepare("INSERT INTO printer_operations (operation_id,sequence,kind,printer_id,payload_ref,state,available_at,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,'print','receipt-1',?,'pending',?,0,4,?,?)").run(operationId, sequence, jobId, check.createdAt, check.createdAt, check.createdAt);
  return jobId;
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
  const existing = getPrintJob(db, request.jobId);
  if (existing) {
    if (existing.transactionId !== request.transactionId || existing.printerId !== request.printerId || existing.documentType !== request.documentType || JSON.stringify(existing.payload) !== JSON.stringify(request.payload)) throw new Error("jobIdが異なるpayloadで再利用されました");
    return existing;
  }
  const operationId = `operation:${request.jobId}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO print_jobs (job_id,operation_id,transaction_id,printer_id,document_type,kind,payload_json,created_at,state,updated_at,source,source_event_id,renderer_version,bytes_sha256,canonical_ir,ir_sha256,expected_bytes_length,template_key,template_version,template_source_sha256,asset_manifest_json,font_id,font_version,font_sha256,finishing_policy_id,finishing_policy_version,delivery_certainty)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'not_sent')`).run(
      request.jobId, operationId, request.transactionId, request.printerId, request.documentType, request.kind ?? "original", JSON.stringify(request.payload), request.createdAt, now, request.source ?? null, request.sourceEventId ?? null,
      request.rendererVersion ?? null, request.bytesSha256 ?? null, request.canonicalIr ?? null, request.irSha256 ?? null, request.expectedBytesLength ?? null, request.templateKey ?? null, request.templateVersion ?? null,
      request.templateSourceSha256 ?? null, JSON.stringify(request.assets?.map(({ rasterBase64: _raster, ...asset }) => asset) ?? []), request.fontId ?? null, request.fontVersion ?? null, request.fontSha256 ?? null,
      request.finishingPolicyId ?? null, request.finishingPolicyVersion ?? null,
    );
    const sequence = Number((db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM printer_operations").get() as { next: number }).next);
    db.prepare("INSERT INTO printer_operations (operation_id,sequence,kind,printer_id,payload_ref,state,available_at,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,?,'receipt-1',?,'pending',?,0,4,?,?)").run(operationId, sequence, request.kind === "drawer" ? "drawer" : "print", request.jobId, now, now, now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const job = getPrintJob(db, request.jobId);
  if (!job) throw new Error("print job was not persisted");
  return job;
}

export function getPrintJob(db: PosDatabase, jobId: string): PrintJob | undefined {
  const row = db.prepare("SELECT * FROM print_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const assets = row.template_key && row.template_version ? db.prepare("SELECT asset_id AS assetId,asset_version AS version,content_sha256 AS sha256,width_dots AS widthDots,height_dots AS heightDots,content_base64 AS rasterBase64 FROM receipt_template_assets WHERE template_key=? AND template_version=? ORDER BY asset_id").all(String(row.template_key), Number(row.template_version)) as PrintJob["assets"] : undefined;
  return {
    jobId: String(row.job_id), transactionId: String(row.transaction_id), printerId: String(row.printer_id),
    documentType: String(row.document_type), payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at), state: row.state as PrintJob["state"], updatedAt: String(row.updated_at),
    ...(row.operation_id ? { operationId: String(row.operation_id) } : {}),
    ...(row.kind ? { kind: row.kind as NonNullable<PrintJob["kind"]> } : {}),
    ...(row.source_job_id ? { sourceJobId: String(row.source_job_id) } : {}),
    ...(row.reprint_no ? { reprintNo: Number(row.reprint_no) } : {}),
    ...(row.delivery_certainty ? { deliveryCertainty: row.delivery_certainty as NonNullable<PrintJob["deliveryCertainty"]> } : {}),
    ...(row.completion_evidence ? { completionEvidence: row.completion_evidence as NonNullable<PrintJob["completionEvidence"]> } : {}),
    ...(row.source ? { source: String(row.source) } : {}),
    ...(row.source_event_id ? { sourceEventId: String(row.source_event_id) } : {}),
    ...(row.renderer_version ? { rendererVersion: String(row.renderer_version) } : {}),
    ...(row.bytes_sha256 ? { bytesSha256: String(row.bytes_sha256) } : {}),
    ...(row.canonical_ir ? { canonicalIr: String(row.canonical_ir) } : {}),
    ...(row.ir_sha256 ? { irSha256: String(row.ir_sha256) } : {}),
    ...(row.expected_bytes_length !== null && row.expected_bytes_length !== undefined ? { expectedBytesLength: Number(row.expected_bytes_length) } : {}),
    ...(row.template_key ? { templateKey: String(row.template_key) } : {}),
    ...(row.template_version ? { templateVersion: Number(row.template_version) } : {}),
    ...(row.template_source_sha256 ? { templateSourceSha256: String(row.template_source_sha256) } : {}),
    ...(assets?.length ? { assets } : {}),
    ...(row.font_id ? { fontId: String(row.font_id) } : {}),
    ...(row.font_version ? { fontVersion: Number(row.font_version) } : {}),
    ...(row.font_sha256 ? { fontSha256: String(row.font_sha256) } : {}),
    ...(row.finishing_policy_id ? { finishingPolicyId: String(row.finishing_policy_id) } : {}),
    ...(row.finishing_policy_version ? { finishingPolicyVersion: Number(row.finishing_policy_version) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
  };
}

export function updatePrintJob(db: PosDatabase, jobId: string, update: PrintJobStateUpdate): PrintJob | undefined {
  const normalized = normalizePrintJobState(update.state); const now = new Date().toISOString();
  db.prepare("UPDATE print_jobs SET state=?,delivery_certainty=COALESCE(?,delivery_certainty),completion_evidence=COALESCE(?,completion_evidence),updated_at=?,error_message=? WHERE job_id=?")
    .run(normalized.state, update.deliveryCertainty ?? normalized.deliveryCertainty ?? null, update.completionEvidence ?? null, now, update.errorMessage ?? null, jobId);
  db.prepare("UPDATE printer_operations SET state=?,updated_at=? WHERE payload_ref=?").run(normalized.state, now, jobId);
  return getPrintJob(db, jobId);
}
