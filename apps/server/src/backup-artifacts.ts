import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import type { PosDatabase } from "./db.js";
import { getBackupArtifact, mapBackupArtifact, recoverInterruptedBackupArtifacts, type BackupArtifactRecord } from "./backup-artifact-schema.js";

export type BackupArtifactFailureStage = "after_snapshot" | "after_workbook" | "before_manifest" | "before_publish";
export type BackupArtifactFailureInjector = (stage: BackupArtifactFailureStage, artifact: BackupArtifactRecord) => void;

type SnapshotData = {
  transactions: Array<Record<string, unknown>>;
  transactionLines: Array<Record<string, unknown>>;
  appliedDiscounts: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  taxes: Array<Record<string, unknown>>;
  inventoryMovements: Array<Record<string, unknown>>;
  cashMovements: Array<Record<string, unknown>>;
  cashChecks: Array<Record<string, unknown>>;
  printOperations: Array<Record<string, unknown>>;
  auditLog: Array<Record<string, unknown>>;
};

export type SnapshotVerification = {
  integrityCheck: string;
  rowCounts: Record<string, number>;
  totals: Record<string, number>;
  logicalSha256: string;
};

const SHEET_NAMES = ["概要", "担当者別", "時間帯別", "商品別", "部門別", "売上", "売上明細", "支払", "税", "在庫移動", "現金台帳", "点検締め", "印刷Operation", "監査"] as const;

function safePathPart(value: string): string {
  return value.normalize("NFKC").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "unknown";
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizedRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value])));
}

function excelText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "�").replace(/[\r\n]+/g, " ");
}

function inspectionRows(data: SnapshotData): { staff: Array<Record<string, unknown>>; time: Array<Record<string, unknown>>; product: Array<Record<string, unknown>>; department: Array<Record<string, unknown>> } {
  const transactions = new Map(data.transactions.map((row) => [String(row.transaction_id), row]));
  const aggregate = (rows: Array<Record<string, unknown>>, key: (row: Record<string, unknown>) => string, quantity: (row: Record<string, unknown>) => number, yen: (row: Record<string, unknown>) => number, label: (key: string) => Record<string, unknown>) => [...rows.reduce((map, row) => { const id = key(row); const current = map.get(id) ?? { ...label(id), sales_count: 0, quantity: 0, sales_yen: 0 }; current.sales_count = Number(current.sales_count) + 1; current.quantity = Number(current.quantity) + quantity(row); current.sales_yen = Number(current.sales_yen) + yen(row); map.set(id, current); return map; }, new Map<string, Record<string, unknown>>()).values()].sort((a, b) => Number(b.sales_yen) - Number(a.sales_yen));
  const staff = aggregate(data.transactions, (row) => String(row.staff_id ?? "不明"), () => 0, (row) => Number(row.total_yen ?? 0), (id) => ({ staff_id: id })).map((row) => ({ ...row, quantity: undefined }));
  const time = aggregate(data.transactions, (row) => `${String((new Date(String(row.created_at)).getUTCHours() + 9) % 24).padStart(2, "0")}時台`, () => 0, (row) => Number(row.total_yen ?? 0), (id) => ({ time_band: id })).map((row) => ({ ...row, quantity: undefined }));
  const product = aggregate(data.transactionLines, (row) => `${String(row.product_code)}\u0000${String(row.product_name)}`, (row) => Number(row.quantity ?? 0), (row) => Number(row.net_yen ?? 0), (id) => { const [product_code, product_name] = id.split("\u0000"); return { product_code, product_name }; });
  const department = aggregate(data.transactionLines, (row) => String(row.department ?? "未分類"), (row) => Number(row.quantity ?? 0), (row) => Number(row.net_yen ?? 0), (id) => ({ department: id }));
  return { staff, time, product, department };
}

function querySnapshot(db: PosDatabase, artifact: BackupArtifactRecord): SnapshotData {
  const cutoff = (db.prepare("SELECT created_at FROM cash_checks WHERE id=?").get(artifact.sourceCashCheckId) as { created_at: string }).created_at;
  const scope = [artifact.eventId, artifact.businessDate, cutoff] as const;
  const transactions = db.prepare(`SELECT t.* FROM transactions t JOIN cash_sessions cs ON cs.session_id=t.session_id
    WHERE t.event_id=? AND cs.business_date=? AND t.created_at<=? ORDER BY t.created_at,t.transaction_id`).all(...scope) as Array<Record<string, unknown>>;
  const transactionLines = db.prepare(`SELECT tl.* FROM transaction_lines tl JOIN transactions t ON t.transaction_id=tl.transaction_id JOIN cash_sessions cs ON cs.session_id=t.session_id
    WHERE t.event_id=? AND cs.business_date=? AND t.created_at<=? ORDER BY t.created_at,tl.line_no,tl.transaction_line_id`).all(...scope) as Array<Record<string, unknown>>;
  const appliedDiscounts = db.prepare(`SELECT ad.* FROM applied_discounts ad JOIN transactions t ON t.transaction_id=ad.transaction_id JOIN cash_sessions cs ON cs.session_id=t.session_id
    WHERE t.event_id=? AND cs.business_date=? AND t.created_at<=? ORDER BY t.created_at,ad.application_no,ad.applied_discount_id`).all(...scope) as Array<Record<string, unknown>>;
  const catalogJson = (db.prepare("SELECT catalog_json FROM event_catalogs WHERE event_id=?").get(artifact.eventId) as { catalog_json?: string } | undefined)?.catalog_json;
  const departmentByCode = new Map<string, string>();
  try {
    const catalog = JSON.parse(catalogJson ?? "{}") as { products?: Array<{ productCode?: string; departmentId?: string }>; departments?: Array<{ departmentId?: string; name?: string }> };
    const departmentNames = new Map((catalog.departments ?? []).filter((department) => department.departmentId).map((department) => [String(department.departmentId), String(department.name || department.departmentId)]));
    for (const product of catalog.products ?? []) if (product.productCode) {
      const departmentId = String(product.departmentId ?? "");
      departmentByCode.set(product.productCode, departmentId ? departmentNames.get(departmentId) ?? departmentId : "未分類");
    }
  } catch { /* 元データが不正でも成果物生成を継続 */ }
  for (const line of transactionLines) line.department = departmentByCode.get(String(line.product_code)) ?? "未分類";
  const payments = db.prepare(`SELECT p.* FROM payments p JOIN transactions t ON t.transaction_id=p.transaction_id JOIN cash_sessions cs ON cs.session_id=t.session_id
    WHERE t.event_id=? AND cs.business_date=? AND t.created_at<=? ORDER BY t.created_at,p.sequence,p.payment_id`).all(...scope) as Array<Record<string, unknown>>;
  const taxes = db.prepare(`SELECT ts.* FROM tax_summaries ts JOIN transactions t ON t.transaction_id=ts.transaction_id JOIN cash_sessions cs ON cs.session_id=t.session_id
    WHERE t.event_id=? AND cs.business_date=? AND t.created_at<=? ORDER BY t.created_at,ts.tax_rate_bps,ts.tax_summary_id`).all(...scope) as Array<Record<string, unknown>>;
  const inventoryMovements = db.prepare("SELECT im.*,ep.product_code FROM inventory_movements im LEFT JOIN event_products ep ON ep.product_id=im.product_id WHERE im.event_id=? AND im.created_at<=? ORDER BY im.created_at,im.inventory_movement_id").all(artifact.eventId, cutoff) as Array<Record<string, unknown>>;
  const cashMovements = db.prepare("SELECT * FROM cash_movements WHERE session_id=? AND created_at<=? ORDER BY created_at,id").all(artifact.cashSessionId, cutoff) as Array<Record<string, unknown>>;
  const cashChecks = db.prepare("SELECT * FROM cash_checks WHERE session_id=? AND created_at<=? ORDER BY created_at,id").all(artifact.cashSessionId, cutoff) as Array<Record<string, unknown>>;
  const printOperations = db.prepare(`SELECT po.operation_id,po.sequence,po.kind AS operation_kind,po.printer_id,po.state AS operation_state,po.attempt_count,po.max_attempts,po.block_reason,po.created_at AS operation_created_at,po.updated_at AS operation_updated_at,
      pj.job_id,pj.transaction_id,pj.document_type,pj.kind AS job_kind,pj.state AS job_state,pj.delivery_certainty,pj.bytes_sha256,pj.ir_sha256,pj.error_message,pj.created_at AS job_created_at
    FROM printer_operations po JOIN print_jobs pj ON pj.job_id=po.payload_ref LEFT JOIN transactions t ON t.transaction_id=pj.transaction_id
    WHERE ((t.event_id=? AND t.created_at<=?) OR pj.transaction_id LIKE ?)
    ORDER BY po.sequence`).all(artifact.eventId, cutoff, `cash-check:${artifact.cashSessionId}:%`) as Array<Record<string, unknown>>;
  const auditLog = db.prepare("SELECT * FROM audit_log WHERE event_id=? AND created_at<=? ORDER BY created_at,id").all(artifact.eventId, cutoff) as Array<Record<string, unknown>>;
  return { transactions, transactionLines, appliedDiscounts, payments, taxes, inventoryMovements, cashMovements, cashChecks, printOperations, auditLog };
}

function scopedVerification(data: SnapshotData): Omit<SnapshotVerification, "integrityCheck"> {
  const rowCounts = {
    transactions: data.transactions.length, transaction_lines: data.transactionLines.length, applied_discounts: data.appliedDiscounts.length, payments: data.payments.length, tax_summaries: data.taxes.length,
    inventory_movements: data.inventoryMovements.length, cash_movements: data.cashMovements.length, cash_checks: data.cashChecks.length, printer_operations: data.printOperations.length, audit_log: data.auditLog.length,
  };
  const sum = (rows: Array<Record<string, unknown>>, key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const totals = {
    sales_yen: sum(data.transactions, "total_yen"), payments_yen: sum(data.payments, "amount_yen"), tax_yen: sum(data.taxes, "tax_amount_yen"),
    inventory_quantity_delta: sum(data.inventoryMovements, "quantity_delta"), cash_ledger_yen: data.cashMovements.reduce((total, row) => total + (["sale", "pay_in"].includes(String(row.type)) ? 1 : -1) * Number(row.amount_yen), 0), no_charge_yen: sum(data.appliedDiscounts.filter((row) => String(row.kind) === "no_charge"), "amount_yen"), no_charge_count: new Set(data.appliedDiscounts.filter((row) => String(row.kind) === "no_charge").map((row) => String(row.transaction_id))).size,
  };
  const logicalSha256 = createHash("sha256").update(JSON.stringify({ ...Object.fromEntries(Object.entries(data).map(([key, rows]) => [key, normalizedRows(rows)])), rowCounts, totals })).digest("hex");
  return { rowCounts, totals, logicalSha256 };
}

export function verifySnapshotDatabase(path: string, artifact: BackupArtifactRecord): SnapshotVerification {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const integrityCheck = integrity.map((row) => String(Object.values(row)[0])).join("; ");
    const scoped = scopedVerification(querySnapshot(db, artifact));
    return { integrityCheck, ...scoped };
  } finally { db.close(); }
}

type Column = { header: string; key: string; width: number; kind?: "yen" | "date" | "integer" | "text" };

function addDataSheet(workbook: ExcelJS.Workbook, name: string, columns: Column[], rows: Array<Record<string, unknown>>): void {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  for (const source of rows) {
    const row = Object.fromEntries(columns.map((column) => {
      const raw = source[column.key];
      if (column.kind === "date") return [column.key, toDate(raw)];
      if (column.kind === "integer" || column.kind === "yen") return [column.key, raw === null || raw === undefined ? null : Number(raw)];
      return [column.key, excelText(raw)];
    }));
    sheet.addRow(row);
  }
  const lastColumn = sheet.getColumn(columns.length).letter;
  sheet.autoFilter = { from: "A1", to: `${lastColumn}${Math.max(1, sheet.rowCount)}` };
  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  for (const [index, column] of columns.entries()) {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.alignment = { vertical: "top", wrapText: column.kind === "text" };
    if (column.kind === "yen" || column.kind === "integer") excelColumn.numFmt = "#,##0";
    if (column.kind === "date") excelColumn.numFmt = "yyyy-mm-dd hh:mm:ss";
  }
}

async function writeWorkbook(path: string, artifact: BackupArtifactRecord, verification: Omit<SnapshotVerification, "integrityCheck">, data: SnapshotData): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "event-pos"; workbook.created = new Date(artifact.requestedAt); workbook.modified = new Date(artifact.requestedAt);
  addDataSheet(workbook, "概要", [
    { header: "項目", key: "key", width: 28, kind: "text" }, { header: "値", key: "value", width: 72, kind: "text" },
  ], [
    { key: "成果物ID", value: artifact.artifactId }, { key: "event ID", value: artifact.eventId }, { key: "営業日", value: artifact.businessDate }, { key: "現金箱", value: artifact.cashboxId }, { key: "cash session ID", value: artifact.cashSessionId }, { key: "契機", value: artifact.triggerKind }, { key: "生成要求日時 UTC", value: artifact.requestedAt }, { key: "snapshot論理SHA-256", value: verification.logicalSha256 },
    ...Object.entries(verification.rowCounts).map(([key, value]) => ({ key: `件数.${key}`, value })), ...Object.entries(verification.totals).map(([key, value]) => ({ key: `合計.${key}`, value })),
  ]);
  const inspection = inspectionRows(data);
  addDataSheet(workbook, "担当者別", [{ header: "担当者", key: "staff_id", width: 18 }, { header: "売上件数", key: "sales_count", width: 12, kind: "integer" }, { header: "売上金額（円）", key: "sales_yen", width: 16, kind: "yen" }], inspection.staff);
  addDataSheet(workbook, "時間帯別", [{ header: "時間帯（JST）", key: "time_band", width: 16 }, { header: "売上件数", key: "sales_count", width: 12, kind: "integer" }, { header: "売上金額（円）", key: "sales_yen", width: 16, kind: "yen" }], inspection.time);
  addDataSheet(workbook, "商品別", [{ header: "商品コード", key: "product_code", width: 18 }, { header: "商品名", key: "product_name", width: 32, kind: "text" }, { header: "売上数量", key: "quantity", width: 12, kind: "integer" }, { header: "売上金額（円）", key: "sales_yen", width: 16, kind: "yen" }], inspection.product);
  addDataSheet(workbook, "部門別", [{ header: "部門", key: "department", width: 24 }, { header: "売上数量", key: "quantity", width: 12, kind: "integer" }, { header: "売上金額（円）", key: "sales_yen", width: 16, kind: "yen" }], inspection.department);
  addDataSheet(workbook, "売上", [
    { header: "取引ID", key: "transaction_id", width: 38 }, { header: "受付番号", key: "public_reference_display", width: 18 }, { header: "レジ", key: "register_id", width: 16 }, { header: "担当者", key: "staff_id", width: 16 }, { header: "種別", key: "type", width: 12 }, { header: "小計（円）", key: "subtotal_yen", width: 14, kind: "yen" }, { header: "値引（円）", key: "discount_total_yen", width: 14, kind: "yen" }, { header: "税（円）", key: "tax_total_yen", width: 14, kind: "yen" }, { header: "合計（円）", key: "total_yen", width: 14, kind: "yen" }, { header: "支払種別", key: "payment_kind", width: 18 }, { header: "確定日時 UTC", key: "created_at", width: 21, kind: "date" },
  ], data.transactions);
  addDataSheet(workbook, "売上明細", [
    { header: "明細ID", key: "transaction_line_id", width: 38 }, { header: "取引ID", key: "transaction_id", width: 38 }, { header: "行", key: "line_no", width: 8, kind: "integer" }, { header: "商品ID", key: "product_id", width: 28 }, { header: "商品コード", key: "product_code", width: 18 }, { header: "商品名", key: "product_name", width: 32, kind: "text" }, { header: "税込単価（円）", key: "price_incl_tax", width: 16, kind: "yen" }, { header: "税率bps", key: "tax_rate_bps", width: 12, kind: "integer" }, { header: "税区分", key: "tax_category", width: 16 }, { header: "数量", key: "quantity", width: 10, kind: "integer" }, { header: "値引前（円）", key: "gross_yen", width: 14, kind: "yen" }, { header: "値引（円）", key: "discount_yen", width: 14, kind: "yen" }, { header: "税（円）", key: "tax_yen", width: 14, kind: "yen" }, { header: "純額（円）", key: "net_yen", width: 14, kind: "yen" }, { header: "日時 UTC", key: "created_at", width: 21, kind: "date" },
  ], data.transactionLines);
  addDataSheet(workbook, "支払", [
    { header: "支払ID", key: "payment_id", width: 38 }, { header: "取引ID", key: "transaction_id", width: 38 }, { header: "順序", key: "sequence", width: 8, kind: "integer" }, { header: "種別", key: "kind", width: 16 }, { header: "名称", key: "method_name_snapshot", width: 18 }, { header: "金額（円）", key: "amount_yen", width: 14, kind: "yen" }, { header: "預り（円）", key: "tendered_yen", width: 14, kind: "yen" }, { header: "釣銭（円）", key: "change_yen", width: 14, kind: "yen" }, { header: "外部結果", key: "external_result", width: 14 }, { header: "参照", key: "reference_note", width: 28, kind: "text" }, { header: "日時 UTC", key: "created_at", width: 21, kind: "date" },
  ], data.payments);
  addDataSheet(workbook, "税", [
    { header: "税集計ID", key: "tax_summary_id", width: 38 }, { header: "取引ID", key: "transaction_id", width: 38 }, { header: "税率bps", key: "tax_rate_bps", width: 12, kind: "integer" }, { header: "税込対象（円）", key: "taxable_gross_yen", width: 16, kind: "yen" }, { header: "値引配賦（円）", key: "discount_allocated_yen", width: 16, kind: "yen" }, { header: "課税対象（円）", key: "taxable_net_yen", width: 16, kind: "yen" }, { header: "税額（円）", key: "tax_amount_yen", width: 14, kind: "yen" }, { header: "丸め", key: "rounding_mode", width: 12 },
  ], data.taxes);
  addDataSheet(workbook, "在庫移動", [
    { header: "移動ID", key: "inventory_movement_id", width: 38 }, { header: "event ID", key: "event_id", width: 18 }, { header: "商品ID", key: "product_id", width: 28 }, { header: "商品コード", key: "product_code", width: 18 }, { header: "種別", key: "type", width: 14 }, { header: "数量差", key: "quantity_delta", width: 12, kind: "integer" }, { header: "取引明細ID", key: "transaction_line_id", width: 38 }, { header: "実行者", key: "actor_id", width: 16 }, { header: "日時 UTC", key: "created_at", width: 21, kind: "date" },
  ], data.inventoryMovements);
  addDataSheet(workbook, "現金台帳", [
    { header: "台帳ID", key: "id", width: 12, kind: "integer" }, { header: "cash session ID", key: "session_id", width: 34 }, { header: "種別", key: "type", width: 14 }, { header: "金額（円）", key: "amount_yen", width: 14, kind: "yen" }, { header: "取引ID", key: "transaction_id", width: 38 }, { header: "理由", key: "reason", width: 30, kind: "text" }, { header: "実行者", key: "actor_id", width: 16 }, { header: "端末", key: "terminal_id", width: 16 }, { header: "日時 UTC", key: "created_at", width: 21, kind: "date" },
  ], data.cashMovements);
  addDataSheet(workbook, "点検締め", [
    { header: "点検ID", key: "id", width: 12, kind: "integer" }, { header: "cash session ID", key: "session_id", width: 34 }, { header: "種別", key: "kind", width: 14 }, { header: "理論現金（円）", key: "theoretical_yen", width: 16, kind: "yen" }, { header: "実在高（円）", key: "counted_yen", width: 16, kind: "yen" }, { header: "過不足（円）", key: "difference_yen", width: 14, kind: "yen" }, { header: "翌日残し（円）", key: "carryover_yen", width: 16, kind: "yen" }, { header: "実行者", key: "actor_id", width: 16 }, { header: "端末", key: "terminal_id", width: 16 }, { header: "日時 UTC", key: "created_at", width: 21, kind: "date" },
  ], data.cashChecks);
  addDataSheet(workbook, "印刷Operation", [
    { header: "operation ID", key: "operation_id", width: 38 }, { header: "job ID", key: "job_id", width: 38 }, { header: "sequence", key: "sequence", width: 12, kind: "integer" }, { header: "operation種別", key: "operation_kind", width: 16 }, { header: "printer", key: "printer_id", width: 16 }, { header: "文書種別", key: "document_type", width: 18 }, { header: "job種別", key: "job_kind", width: 14 }, { header: "operation状態", key: "operation_state", width: 18 }, { header: "job状態", key: "job_state", width: 14 }, { header: "certainty", key: "delivery_certainty", width: 16 }, { header: "bytes SHA-256", key: "bytes_sha256", width: 66 }, { header: "IR SHA-256", key: "ir_sha256", width: 66 }, { header: "試行数", key: "attempt_count", width: 10, kind: "integer" }, { header: "error", key: "error_message", width: 36, kind: "text" }, { header: "日時 UTC", key: "operation_created_at", width: 21, kind: "date" },
  ], data.printOperations);
  addDataSheet(workbook, "監査", [
    { header: "監査ID", key: "id", width: 12, kind: "integer" }, { header: "event ID", key: "event_id", width: 18 }, { header: "action", key: "action", width: 28 }, { header: "entity種別", key: "entity_type", width: 20 }, { header: "entity ID", key: "entity_id", width: 38 }, { header: "detail JSON", key: "detail_json", width: 72, kind: "text" }, { header: "日時 UTC", key: "created_at", width: 21, kind: "date" },
  ], data.auditLog);
  await workbook.xlsx.writeFile(path);
}

async function verifyWorkbook(path: string, expected: Record<string, number>): Promise<void> {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path);
  const actualNames = workbook.worksheets.map((sheet) => sheet.name);
  if (JSON.stringify(actualNames) !== JSON.stringify(SHEET_NAMES)) throw new Error(`Excelシート構成が不正です: ${actualNames.join(",")}`);
  const mapping: Record<string, keyof typeof expected> = { "売上": "transactions", "売上明細": "transaction_lines", "支払": "payments", "税": "tax_summaries", "在庫移動": "inventory_movements", "現金台帳": "cash_movements", "点検締め": "cash_checks", "印刷Operation": "printer_operations", "監査": "audit_log" };
  for (const [sheetName, key] of Object.entries(mapping)) {
    const count = Math.max(0, (workbook.getWorksheet(sheetName)?.actualRowCount ?? 1) - 1);
    if (count !== expected[key]) throw new Error(`${sheetName}の行数が不一致です: expected=${expected[key]} actual=${count}`);
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC") return "STORAGE_FULL";
  if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
  if (code === "EEXIST") return "OVERWRITE_BLOCKED";
  if (code === "STORAGE_LOW") return "STORAGE_LOW";
  return "GENERATION_FAILED";
}

export class BackupArtifactWorker {
  private draining: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly db: PosDatabase, private readonly rootDirectory: string, private readonly failureInjector?: BackupArtifactFailureInjector, private readonly minimumFreeBytes = 0) {
    recoverInterruptedBackupArtifacts(db);
  }

  trigger(): void {
    if (this.draining || this.stopping) return;
    this.draining = this.drain().finally(() => { this.draining = null; });
  }

  async waitForIdle(): Promise<void> { await this.draining; }
  async stop(): Promise<void> { this.stopping = true; await this.draining; }

  private nextPending(): BackupArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM backup_artifacts WHERE state='pending' ORDER BY requested_at,artifact_id LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? mapBackupArtifact(row) : undefined;
  }

  private claim(artifactId: string): BackupArtifactRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const changed = this.db.prepare("UPDATE backup_artifacts SET state='generating',started_at=?,completed_at=NULL,error_code=NULL,error_message=NULL,attempt_count=attempt_count+1 WHERE artifact_id=? AND state='pending'").run(now, artifactId);
      if (Number(changed.changes) !== 1) { this.db.exec("COMMIT"); return undefined; }
      const artifact = getBackupArtifact(this.db, artifactId)!;
      this.db.prepare("INSERT INTO audit_log (event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'backup_artifact_started','backup_artifact',?,?,?)").run(artifact.eventId, artifactId, JSON.stringify({ artifactId, triggerKind: artifact.triggerKind, requestedBy: artifact.requestedBy ?? null, attemptCount: artifact.attemptCount }), now);
      this.db.exec("COMMIT");
      return artifact;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const pending = this.nextPending(); if (!pending) return;
      const artifact = this.claim(pending.artifactId); if (!artifact) continue;
      await this.generate(artifact);
    }
  }

  private async generate(artifact: BackupArtifactRecord): Promise<void> {
    const parent = resolve(this.rootDirectory, safePathPart(artifact.eventId), safePathPart(artifact.businessDate), safePathPart(artifact.cashboxId));
    const finalDirectory = join(parent, artifact.artifactId); const stagingDirectory = join(resolve(this.rootDirectory), `.tmp-${artifact.artifactId.slice(0, 8)}-${randomUUID().slice(0, 8)}`);
    const prefix = [artifact.eventId, artifact.businessDate, artifact.cashboxId, artifact.artifactId].map(safePathPart).join("_");
    const backupName = `${prefix}.sqlite`; const workbookName = `${prefix}.xlsx`; const manifestName = `${prefix}.manifest.json`;
    const stagingBackup = join(stagingDirectory, backupName); const stagingWorkbook = join(stagingDirectory, workbookName); const stagingManifest = join(stagingDirectory, manifestName);
    try {
      await mkdir(resolve(this.rootDirectory), { recursive: true, mode: 0o700 });
      const filesystem = await statfs(resolve(this.rootDirectory)); const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
      if (freeBytes < this.minimumFreeBytes) throw Object.assign(new Error(`成果物保存先の空き容量が不足しています（空き ${freeBytes} bytes／必要 ${this.minimumFreeBytes} bytes）`), { code: "STORAGE_LOW" });
      await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
      this.db.prepare("VACUUM INTO ?").run(stagingBackup);
      await chmod(stagingBackup, 0o600);
      this.failureInjector?.("after_snapshot", artifact);
      const snapshotDb = new DatabaseSync(stagingBackup, { readOnly: true });
      let data: SnapshotData;
      try { data = querySnapshot(snapshotDb, artifact); } finally { snapshotDb.close(); }
      const scoped = scopedVerification(data);
      await writeWorkbook(stagingWorkbook, artifact, scoped, data); await chmod(stagingWorkbook, 0o600);
      await verifyWorkbook(stagingWorkbook, scoped.rowCounts);
      this.failureInjector?.("after_workbook", artifact);
      const backupSha256 = await sha256File(stagingBackup); const workbookSha256 = await sha256File(stagingWorkbook);
      const integrityCheck = verifySnapshotDatabase(stagingBackup, artifact).integrityCheck;
      if (integrityCheck !== "ok") throw new Error(`SQLite integrity_check failed: ${integrityCheck}`);
      this.failureInjector?.("before_manifest", artifact);
      const manifest = {
        schemaVersion: 1, artifactId: artifact.artifactId, eventId: artifact.eventId, businessDate: artifact.businessDate, cashboxId: artifact.cashboxId, cashSessionId: artifact.cashSessionId, sourceCashCheckId: artifact.sourceCashCheckId, triggerKind: artifact.triggerKind, retryOfArtifactId: artifact.retryOfArtifactId ?? null, requestedBy: artifact.requestedBy ?? null, requestedAt: artifact.requestedAt, generatedAt: new Date().toISOString(),
        sqliteSchemaVersion: Number((this.db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get() as { value: string }).value), snapshotLogicalSha256: scoped.logicalSha256, integrityCheck, rowCounts: scoped.rowCounts, totals: scoped.totals,
        files: { backup: { name: backupName, sha256: backupSha256 }, workbook: { name: workbookName, sha256: workbookSha256 } }, workbook: { format: "xlsx", sheets: SHEET_NAMES, timezone: "UTC", currency: "JPY", taxRateUnit: "basis_points" },
      };
      await writeFile(stagingManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const manifestSha256 = await sha256File(stagingManifest);
      this.failureInjector?.("before_publish", artifact);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await rename(stagingDirectory, finalDirectory);
      const completedAt = new Date().toISOString();
      const backupPath = join(finalDirectory, backupName); const workbookPath = join(finalDirectory, workbookName); const manifestPath = join(finalDirectory, manifestName);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`UPDATE backup_artifacts SET state='completed',completed_at=?,output_directory=?,backup_path=?,workbook_path=?,manifest_path=?,backup_sha256=?,workbook_sha256=?,manifest_sha256=?,snapshot_logical_sha256=?,row_counts_json=?,totals_json=? WHERE artifact_id=? AND state='generating'`)
          .run(completedAt, finalDirectory, backupPath, workbookPath, manifestPath, backupSha256, workbookSha256, manifestSha256, scoped.logicalSha256, JSON.stringify(scoped.rowCounts), JSON.stringify(scoped.totals), artifact.artifactId);
        this.db.prepare("INSERT INTO audit_log (event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'backup_artifact_completed','backup_artifact',?,?,?)").run(artifact.eventId, artifact.artifactId, JSON.stringify({ artifactId: artifact.artifactId, triggerKind: artifact.triggerKind, requestedBy: artifact.requestedBy ?? null, backupSha256, workbookSha256, manifestSha256, snapshotLogicalSha256: scoped.logicalSha256, result: "completed" }), completedAt);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      const completedAt = new Date().toISOString(); const code = errorCode(error); const message = error instanceof Error ? error.message : "成果物生成に失敗しました";
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE backup_artifacts SET state='failed',completed_at=?,error_code=?,error_message=? WHERE artifact_id=? AND state='generating'").run(completedAt, code, message, artifact.artifactId);
        this.db.prepare("INSERT INTO audit_log (event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'backup_artifact_failed','backup_artifact',?,?,?)").run(artifact.eventId, artifact.artifactId, JSON.stringify({ artifactId: artifact.artifactId, triggerKind: artifact.triggerKind, requestedBy: artifact.requestedBy ?? null, errorCode: code, errorMessage: message, result: "failed" }), completedAt);
        this.db.exec("COMMIT");
      } catch (auditError) { this.db.exec("ROLLBACK"); throw auditError; }
    }
  }
}
