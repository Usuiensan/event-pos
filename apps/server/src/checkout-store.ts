import { createHash } from "node:crypto";
import {
  calculateSale,
  createPublicReference,
  formatPublicReference,
  importEventCatalog,
  parseBarcode,
  type EventCatalog,
  type ManualDiscountInput,
  type SaleCalculation,
  type SaleCalculationLineInput,
} from "@event-pos/contracts";
import { getCatalog, type PosDatabase } from "./db.js";
import { renderReceipt } from "./receipt-store.js";
import type { ReceiptSnapshot } from "@event-pos/receipt-template";
import { assertRegisterOpen } from "./business-store.js";
import { uuidV7 } from "./ids.js";
import { recordProvisionalProductScan } from "./provisional-products.js";

export type DraftState = "editing" | "payment" | "finalizing" | "parked" | "completed" | "canceled";
export type PaymentKind = "cash" | "credit" | "accounts_receivable" | "no_charge";
export type ProductOptions = Record<string, unknown>;
export type DraftLineDto = SaleCalculationLineInput & { productId: string; source: "manual" | "scan" | "bundle" | "hold"; bundleInstanceId?: string; productOptions?: ProductOptions };
export type DraftPaymentDto = { paymentId: string; sequence: number; kind: PaymentKind; amountYen: number; tenderedYen?: number; changeYen?: number; referenceNote?: string };
export type DraftAgeVerificationDto = { verificationId: string; minimumAge: 18 | 20; method: "appearance" | "id_visual" | "self_declaration"; result: "passed" | "failed"; confirmerId?: string; terminalId: string; verifiedAt: string };
export type SaleDraftDto = {
  draftId: string;
  eventId: string;
  registerId: string;
  staffId: string;
  terminalId: string;
  businessDate: string;
  sessionNo: number;
  version: number;
  state: DraftState;
  completedTransactionId?: string;
  lines: DraftLineDto[];
  payments: DraftPaymentDto[];
  ageVerifications: DraftAgeVerificationDto[];
  calculation: SaleCalculation;
  createdAt: string;
  updatedAt: string;
};
export type FinalizeResult = {
  transactionId: string;
  draftId: string;
  draftVersion: number;
  publicReference: string;
  publicReferenceDisplay: string;
  subtotalYen: number;
  discountTotalYen: number;
  taxTotalYen: number;
  totalYen: number;
  paymentKind: string;
  printJobId: string;
  printState: "pending";
  completedAt: string;
};
export type FailureInjector = (step: "after_idempotency_check" | "after_recalculation" | "after_transaction" | "after_inventory" | "after_cash" | "after_audit" | "after_print_job" | "before_commit") => void;

export class CheckoutError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}

export { uuidV7 } from "./ids.js";

function immediate<T>(db: PosDatabase, work: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try { const value = work(); db.exec("COMMIT;"); return value; }
  catch (error) { db.exec("ROLLBACK;"); throw error; }
}

function draftRow(db: PosDatabase, draftId: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM sale_drafts WHERE draft_id = ?").get(draftId) as Record<string, unknown> | undefined;
  if (!row) throw new CheckoutError(404, "DRAFT_NOT_FOUND", "販売ドラフトが見つかりません");
  return row;
}

function catalogFor(db: PosDatabase, eventId: string): EventCatalog {
  const record = getCatalog(db, eventId);
  if (!record) throw new CheckoutError(409, "CATALOG_NOT_READY", "商品マスターが登録されていません");
  return importEventCatalog(record.catalogJson);
}

function emptyCalculation(): SaleCalculation { return { lines: [], discounts: [], taxSummaries: [], subtotalYen: 0, discountTotalYen: 0, taxTotalYen: 0, totalYen: 0 }; }

function parseProductOptions(value: unknown): ProductOptions {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ProductOptions : {};
  } catch { return {}; }
}

function canonicalProductOptions(value: unknown): string {
  if (value === undefined) return "{}";
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate !== null && typeof candidate === "object" && Object.getPrototypeOf(candidate) === Object.prototype) {
      return Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, normalize((candidate as Record<string, unknown>)[key])]));
    }
    throw new CheckoutError(400, "INVALID_PRODUCT_OPTIONS", "商品オプションはJSONオブジェクトで指定してください");
  };
  const normalized = normalize(value);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) throw new CheckoutError(400, "INVALID_PRODUCT_OPTIONS", "商品オプションはJSONオブジェクトで指定してください");
  return JSON.stringify(normalized);
}

function readLines(db: PosDatabase, draftId: string): DraftLineDto[] {
  const rows = db.prepare(`SELECT l.*, p.product_code, p.name, p.price_incl_tax AS current_price_incl_tax, p.tax_rate_bps AS current_tax_rate_bps, p.tax_category AS current_tax_category
    FROM sale_draft_lines l JOIN event_products p ON p.product_id = l.product_id WHERE l.draft_id = ? ORDER BY l.line_no`).all(draftId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    lineId: String(row.line_id), lineNo: Number(row.line_no), productId: String(row.product_id), productCode: String(row.product_code), name: String(row.name),
    priceInclTax: Number(row.unit_price_incl_tax ?? row.current_price_incl_tax), taxRate: Number(row.tax_rate_bps ?? row.current_tax_rate_bps) / 100, taxCategory: (row.tax_category ?? row.current_tax_category) as DraftLineDto["taxCategory"], quantity: Number(row.quantity),
    status: row.status as DraftLineDto["status"], source: row.source as DraftLineDto["source"],
    ...(row.bundle_instance_id ? { bundleInstanceId: String(row.bundle_instance_id) } : {}),
    ...(row.product_options_json && row.product_options_json !== "{}" ? { productOptions: parseProductOptions(row.product_options_json) } : {}),
    ...(row.manual_discount_kind ? { manualDiscount: { kind: row.manual_discount_kind as ManualDiscountInput["kind"], value: Number(row.manual_discount_value) } } : {}),
  }));
}

function readPayments(db: PosDatabase, draftId: string): DraftPaymentDto[] {
  const rows = db.prepare("SELECT * FROM draft_payments WHERE draft_id = ? ORDER BY sequence").all(draftId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ paymentId: String(row.payment_id), sequence: Number(row.sequence), kind: row.kind as PaymentKind, amountYen: Number(row.amount_yen), ...(row.tendered_yen === null ? {} : { tenderedYen: Number(row.tendered_yen) }), ...(row.change_yen === null ? {} : { changeYen: Number(row.change_yen) }), ...(row.reference_note ? { referenceNote: String(row.reference_note) } : {}) }));
}

function readAgeVerifications(db: PosDatabase, draftId: string): DraftAgeVerificationDto[] {
  const rows = db.prepare("SELECT * FROM draft_age_verifications WHERE draft_id = ? ORDER BY verified_at").all(draftId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ verificationId: String(row.verification_id), minimumAge: Number(row.minimum_age) as 18 | 20, method: row.method as DraftAgeVerificationDto["method"], result: row.result as DraftAgeVerificationDto["result"], ...(row.confirmer_id ? { confirmerId: String(row.confirmer_id) } : {}), terminalId: String(row.terminal_id), verifiedAt: String(row.verified_at) }));
}

function calculateDraft(db: PosDatabase, eventId: string, lines: DraftLineDto[], noCharge?: boolean): SaleCalculation {
  if (!lines.some((line) => line.status === "active")) return emptyCalculation();
  return calculateSale(lines, catalogFor(db, eventId).autoDiscountRules ?? [], noCharge);
}

export function getSaleDraft(db: PosDatabase, draftId: string): SaleDraftDto {
  const row = draftRow(db, draftId);
  const lines = readLines(db, draftId);
  const payments = readPayments(db, draftId);
  return {
    draftId: String(row.draft_id), eventId: String(row.event_id), registerId: String(row.register_id), staffId: String(row.staff_id), terminalId: String(row.terminal_id), businessDate: String(row.business_date), sessionNo: Number(row.session_no), version: Number(row.version), state: row.state as DraftState,
    ...(row.completed_transaction_id ? { completedTransactionId: String(row.completed_transaction_id) } : {}), lines, payments, ageVerifications: readAgeVerifications(db, draftId),
    calculation: calculateDraft(db, String(row.event_id), lines, payments.some((payment) => payment.kind === "no_charge")), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function publicProjection(draft: SaleDraftDto, projectionVersion: number): Record<string, unknown> {
  const cashPayment = draft.payments.find((payment) => payment.kind === "cash");
  return {
    registerId: draft.registerId, draftId: draft.draftId, version: projectionVersion, draftVersion: draft.version, state: draft.state,
    lines: draft.lines.filter((line) => line.status === "active").map((line) => ({ lineId: line.lineId, productCode: line.productCode, name: line.name, quantity: line.quantity, unitPriceYen: line.priceInclTax, taxCategory: line.taxCategory, netYen: draft.calculation.lines.find((item) => item.lineId === line.lineId)?.netYen ?? 0 })),
    discounts: draft.calculation.discounts.map((discount) => ({ label: discount.label, amountYen: discount.amountYen })),
    totals: { subtotalYen: draft.calculation.subtotalYen, discountYen: draft.calculation.discountTotalYen, taxYen: draft.calculation.taxTotalYen, totalYen: draft.calculation.totalYen },
    payment: draft.payments.length ? { state: draft.state === "completed" ? "completed" : "entered", kinds: draft.payments.map((payment) => payment.kind), ...(cashPayment?.tenderedYen === undefined ? {} : { tenderedYen: cashPayment.tenderedYen, changeYen: cashPayment.changeYen }) } : { state: "waiting", kinds: [] },
    ...(draft.completedTransactionId ? { transactionId: draft.completedTransactionId } : {}),
  };
}

function updateProjection(db: PosDatabase, draftId: string): SaleDraftDto {
  const draft = getSaleDraft(db, draftId);
  const current = db.prepare("SELECT version FROM customer_display_states WHERE register_id=?").get(draft.registerId) as { version: number } | undefined;
  const projectionVersion = (current?.version ?? 0) + 1;
  db.prepare(`INSERT INTO customer_display_states (register_id, version, public_projection_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(register_id) DO UPDATE SET version=excluded.version, public_projection_json=excluded.public_projection_json, updated_at=excluded.updated_at`)
    .run(draft.registerId, projectionVersion, JSON.stringify(publicProjection(draft, projectionVersion)), draft.updatedAt);
  return draft;
}

export function createSaleDraft(db: PosDatabase, input: { eventId: string; registerId: string; staffId: string; terminalId: string; businessDate: string; sessionNo?: number }): SaleDraftDto {
  if (!input.eventId || !input.registerId || !input.staffId || !input.terminalId || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) throw new CheckoutError(400, "INVALID_DRAFT", "ドラフト開始情報が不正です");
  catalogFor(db, input.eventId);
  return immediate(db, () => {
    const existing = db.prepare("SELECT draft_id FROM sale_drafts WHERE register_id = ? AND state IN ('editing','payment','finalizing')").get(input.registerId) as { draft_id: string } | undefined;
    if (existing) return getSaleDraft(db, existing.draft_id);
    const register = assertRegisterOpen(db, input.eventId, input.registerId);
    const now = new Date().toISOString();
    const draftId = uuidV7();
    db.prepare(`INSERT INTO sale_drafts (draft_id,event_id,register_id,staff_id,terminal_id,business_date,session_no,cash_session_id,version,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,'editing',?,?)`).run(draftId, input.eventId, input.registerId, input.staffId, input.terminalId, register.businessDate, register.sessionNo, register.cashSessionId, now, now);
    return updateProjection(db, draftId);
  });
}

export function getRegisterSaleDraft(db: PosDatabase, registerId: string): SaleDraftDto | undefined {
  const row = db.prepare("SELECT draft_id FROM sale_drafts WHERE register_id = ? ORDER BY CASE WHEN state IN ('editing','payment','finalizing') THEN 0 ELSE 1 END, created_at DESC LIMIT 1").get(registerId) as { draft_id: string } | undefined;
  return row ? getSaleDraft(db, row.draft_id) : undefined;
}

function assertMutable(db: PosDatabase, row: Record<string, unknown>, expectedVersion: number): void {
  if (Number(row.version) !== expectedVersion) throw new CheckoutError(409, "DRAFT_VERSION_CONFLICT", "販売ドラフトが別端末で更新されています", { latestVersion: Number(row.version), draftId: String(row.draft_id) });
  if (row.state === "parked") throw new CheckoutError(409, "DRAFT_PARKED", "保留中の販売ドラフトは変更できません", { state: row.state });
  if (row.state !== "editing" && row.state !== "payment") throw new CheckoutError(409, "DRAFT_NOT_EDITABLE", "この販売ドラフトは変更できません", { state: row.state });
  const register = assertRegisterOpen(db, String(row.event_id), String(row.register_id));
  if (register.cashSessionId !== row.cash_session_id) throw new CheckoutError(409, "BUSINESS_CLOSED", "この会計を開始した営業は終了しています");
}

function bump(db: PosDatabase, draftId: string, version: number, state?: "editing" | "payment"): void {
  const result = db.prepare(`UPDATE sale_drafts SET version=version+1, updated_at=?, state=COALESCE(?, state) WHERE draft_id=? AND version=?`).run(new Date().toISOString(), state ?? null, draftId, version);
  if (Number(result.changes) !== 1) throw new CheckoutError(409, "DRAFT_VERSION_CONFLICT", "販売ドラフトが別端末で更新されています");
}

function productByCode(db: PosDatabase, eventId: string, productCode: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM event_products WHERE event_id = ? AND product_code = ?").get(eventId, productCode) as Record<string, unknown> | undefined;
  if (!row) throw new CheckoutError(404, "PRODUCT_NOT_FOUND", "商品コードが見つかりません", { productCode });
  if (row.sale_state !== "on_sale") throw new CheckoutError(409, "PRODUCT_OFF_SALE", "販売停止中の商品です", { productCode });
  return row;
}

function insertLine(db: PosDatabase, draftId: string, product: Record<string, unknown>, quantity: number, source: DraftLineDto["source"], bundleInstanceId: string | null, productOptionsJson: string, now: string): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new CheckoutError(400, "INVALID_QUANTITY", "数量は1以上の整数で指定してください");
  const next = db.prepare("SELECT COALESCE(MAX(line_no), 0) + 1 AS next FROM sale_draft_lines WHERE draft_id = ?").get(draftId) as { next: number };
  db.prepare(`INSERT INTO sale_draft_lines (line_id,draft_id,line_no,product_id,unit_price_incl_tax,tax_rate_bps,tax_category,product_options_json,quantity,source,bundle_instance_id,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?)`).run(uuidV7(), draftId, next.next, String(product.product_id), Number(product.price_incl_tax), Number(product.tax_rate_bps), String(product.tax_category), productOptionsJson, quantity, source, bundleInstanceId, now);
}

function addToMatchingLine(db: PosDatabase, draftId: string, product: Record<string, unknown>, quantity: number, productOptionsJson: string): boolean {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new CheckoutError(400, "INVALID_QUANTITY", "数量は1以上の整数で指定してください");
  const matching = db.prepare(`SELECT line_id, quantity FROM sale_draft_lines
    WHERE draft_id=? AND status='active' AND bundle_instance_id IS NULL
      AND product_id=? AND unit_price_incl_tax=? AND tax_rate_bps=? AND tax_category=?
      AND manual_discount_kind IS NULL AND manual_discount_value IS NULL AND product_options_json=?
    ORDER BY line_no LIMIT 1`).get(draftId, String(product.product_id), Number(product.price_incl_tax), Number(product.tax_rate_bps), String(product.tax_category), productOptionsJson) as { line_id: string; quantity: number } | undefined;
  if (!matching) return false;
  const nextQuantity = Number(matching.quantity) + quantity;
  if (!Number.isSafeInteger(nextQuantity)) throw new CheckoutError(400, "INVALID_QUANTITY", "数量が上限を超えています");
  db.prepare("UPDATE sale_draft_lines SET quantity=? WHERE line_id=?").run(nextQuantity, matching.line_id);
  return true;
}

export function addDraftLine(db: PosDatabase, draftId: string, version: number, input: { productCode: string; quantity?: number; source?: "manual" | "scan"; productOptions?: ProductOptions }): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const product = productByCode(db, String(row.event_id), input.productCode);
    const quantity = input.quantity ?? 1;
    const productOptionsJson = canonicalProductOptions(input.productOptions);
    if (!addToMatchingLine(db, draftId, product, quantity, productOptionsJson)) {
      insertLine(db, draftId, product, quantity, input.source ?? "manual", null, productOptionsJson, new Date().toISOString());
    }
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

export function addUnregisteredDraftLine(db: PosDatabase, draftId: string, version: number, input: { productCode: string; priceInclTax: number; taxRate: 0 | 8 | 10; actorId: string }): SaleDraftDto {
  const detected = parseBarcode(input.productCode);
  if (!detected.gtin || (detected.kind !== "gtin" && detected.kind !== "book-isbn")) throw new CheckoutError(400, "INVALID_UNREGISTERED_PRODUCT_CODE", "商品登録に使えるJANコードを読み取ってください");
  if (!Number.isSafeInteger(input.priceInclTax) || input.priceInclTax < 0) throw new CheckoutError(400, "INVALID_UNREGISTERED_PRODUCT_PRICE", "税込価格は0円以上の整数で入力してください");
  if (![0, 8, 10].includes(input.taxRate)) throw new CheckoutError(400, "INVALID_UNREGISTERED_PRODUCT_TAX", "税率は0%、8%、10%のいずれかです");
  const code = detected.gtin;
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const existing = db.prepare("SELECT provisional FROM event_products WHERE event_id=? AND product_code=?").get(String(row.event_id), code) as { provisional?: number } | undefined;
    if (existing && Number(existing.provisional) !== 1) throw new CheckoutError(409, "PRODUCT_ALREADY_REGISTERED", "商品マスタに登録済みの商品です。通常のスキャンを使用してください", { productCode: code });
    const product = recordProvisionalProductScan(db, { eventId: String(row.event_id), productCode: code, name: `未登録商品 ${code}`, priceInclTax: input.priceInclTax, taxRate: input.taxRate, actorId: input.actorId });
    if (!addToMatchingLine(db, draftId, product, 1, "{}")) insertLine(db, draftId, product, 1, "scan", null, "{}", new Date().toISOString());
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

/** 定期刊行物は13桁本体ではなく、読取った18桁ごとに売価と号を固定する。 */
export function addPeriodicalDraftLine(db: PosDatabase, draftId: string, version: number, code: string): SaleDraftDto {
  const detected = parseBarcode(code);
  if (detected.kind !== "periodical" || !detected.periodical) throw new CheckoutError(400, "INVALID_PERIODICAL_CODE", "定期刊行物JANコードを正しく読み取れませんでした");
  const info = detected.periodical;
  if (info.priceExclTaxYen === null) throw new CheckoutError(409, "PERIODICAL_PRICE_NOT_ENCODED", "本体価格が10,000円以上の定期刊行物はバーコードから売価を確定できません。商品マスタで登録してください");
  const priceExclTax = info.priceExclTaxYen;
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version); const now = new Date().toISOString();
    let product = db.prepare("SELECT * FROM event_products WHERE event_id=? AND product_code=?").get(String(row.event_id), code) as Record<string, unknown> | undefined;
    if (!product) {
      const productId = `${row.event_id}:periodical:${code}`; const name = `定期刊行物 ${info.magazineCode} ${info.issueLabel}`; const priceInclTax = priceExclTax + Math.floor(priceExclTax * 0.1);
      db.prepare("INSERT INTO event_products (product_id,event_id,product_code,name,price_incl_tax,price_excl_tax,tax_rate_bps,tax_category,age_requirement,inventory_tracked,sale_state,updated_at) VALUES (?,?,?,?,?,?,1000,'exclusive_10',0,0,'on_sale',?)").run(productId, String(row.event_id), code, name, priceInclTax, priceExclTax, now);
      product = db.prepare("SELECT * FROM event_products WHERE product_id=?").get(productId) as Record<string, unknown>;
    }
    // 登録済みの同一18桁商品があっても、売価はこの号のバーコード値を正とする。
    const barcodeProduct = { ...product, name: `定期刊行物 ${info.magazineCode} ${info.issueLabel}`, price_incl_tax: priceExclTax + Math.floor(priceExclTax * 0.1), price_excl_tax: priceExclTax, tax_rate_bps: 1000, tax_category: "exclusive_10" };
    if (!addToMatchingLine(db, draftId, barcodeProduct, 1, "{}")) insertLine(db, draftId, barcodeProduct, 1, "scan", null, "{}", now);
    bump(db, draftId, version, "editing"); return updateProjection(db, draftId);
  });
}

export function addHoldLinesToDraft(db: PosDatabase, draftId: string, version: number, lines: Array<{ productId: string; quantity: number }>): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    if (!lines.length) throw new CheckoutError(400, "HOLD_EMPTY", "取り置き明細がありません");
    for (const line of lines) {
      const product = db.prepare("SELECT * FROM event_products WHERE product_id=? AND event_id=?").get(line.productId, String(row.event_id)) as Record<string, unknown> | undefined;
      if (!product) throw new CheckoutError(409, "HOLD_PRODUCT_UNAVAILABLE", "取り置き商品の商品マスタが見つかりません");
      insertLine(db, draftId, product, line.quantity, "hold", null, "{}", new Date().toISOString());
    }
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

export function claimHoldToDraft(db: PosDatabase, holdId: string, draftId: string, version: number): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const hold = db.prepare("SELECT event_id,state FROM holds WHERE hold_id=?").get(holdId) as { event_id: string; state: string } | undefined;
    if (!hold) throw new CheckoutError(404, "HOLD_NOT_FOUND", "取り置きが見つかりません");
    if (hold.event_id !== String(row.event_id) || hold.state !== "active") throw new CheckoutError(409, "HOLD_NOT_CLAIMABLE", "この取り置きは受取会計に使用できません");
    const lines = db.prepare("SELECT product_id,quantity FROM hold_lines WHERE hold_id=? ORDER BY rowid").all(holdId) as Array<{ product_id: string; quantity: number }>;
    if (!lines.length) throw new CheckoutError(409, "HOLD_EMPTY", "取り置き明細がありません");
    for (const line of lines) {
      const product = db.prepare("SELECT * FROM event_products WHERE product_id=? AND event_id=?").get(line.product_id, String(row.event_id)) as Record<string, unknown> | undefined;
      if (!product) throw new CheckoutError(409, "HOLD_PRODUCT_UNAVAILABLE", "取り置き商品の商品マスタが見つかりません");
      insertLine(db, draftId, product, Number(line.quantity), "hold", null, "{}", new Date().toISOString());
      db.prepare("UPDATE inventory_balances SET reserved=reserved-?,version=version+1 WHERE event_id=? AND product_id=? AND reserved>=?").run(line.quantity, hold.event_id, line.product_id, line.quantity);
    }
    const changed = db.prepare("UPDATE holds SET state='claimed',claimed_draft_id=?,claimed_at=? WHERE hold_id=? AND state='active'").run(draftId, new Date().toISOString(), holdId);
    if (Number(changed.changes) !== 1) throw new CheckoutError(409, "HOLD_CLAIM_CONFLICT", "取り置きが別端末で更新されています");
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

export function addDraftBundle(db: PosDatabase, draftId: string, version: number, bundleId: string): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const entry = catalogFor(db, String(row.event_id)).quickEntries.find((candidate) => candidate.id === bundleId && candidate.components);
    if (!entry?.components) throw new CheckoutError(404, "BUNDLE_NOT_FOUND", "セットが見つかりません");
    const products = entry.components.map((component) => ({ component, product: productByCode(db, String(row.event_id), component.productCode) }));
    const instance = uuidV7(); const now = new Date().toISOString();
    for (const { component, product } of products) insertLine(db, draftId, product, component.quantity, "bundle", instance, "{}", now);
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

export function updateDraftLine(db: PosDatabase, draftId: string, lineId: string, version: number, input: { quantity?: number; manualDiscount?: ManualDiscountInput | null }): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const line = db.prepare("SELECT status FROM sale_draft_lines WHERE draft_id=? AND line_id=?").get(draftId, lineId) as { status: string } | undefined;
    if (!line) throw new CheckoutError(404, "DRAFT_LINE_NOT_FOUND", "販売明細が見つかりません");
    if (line.status === "canceled") throw new CheckoutError(409, "DRAFT_LINE_CANCELED", "取消済み明細は変更できません");
    if (input.quantity !== undefined && (!Number.isSafeInteger(input.quantity) || input.quantity < 1)) throw new CheckoutError(400, "INVALID_QUANTITY", "数量は1以上の整数で指定してください");
    if (input.manualDiscount !== undefined && input.manualDiscount !== null && (!Number.isSafeInteger(input.manualDiscount.value) || input.manualDiscount.value < 0 || (input.manualDiscount.kind === "rate" && input.manualDiscount.value > 100))) throw new CheckoutError(422, "INVALID_MANUAL_DISCOUNT", "任意値引きが不正です");
    if (input.quantity !== undefined) db.prepare("UPDATE sale_draft_lines SET quantity=? WHERE line_id=?").run(input.quantity, lineId);
    if (input.manualDiscount !== undefined) db.prepare("UPDATE sale_draft_lines SET manual_discount_kind=?, manual_discount_value=? WHERE line_id=?").run(input.manualDiscount?.kind ?? null, input.manualDiscount?.value ?? null, lineId);
    const candidate = readLines(db, draftId);
    try { calculateDraft(db, String(row.event_id), candidate); } catch (error) { throw new CheckoutError(422, error instanceof Error && "code" in error ? String((error as { code: string }).code) : "INVALID_DISCOUNT", error instanceof Error ? error.message : "値引きが不正です"); }
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

export function cancelDraftLine(db: PosDatabase, draftId: string, lineId: string, version: number): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const result = db.prepare("UPDATE sale_draft_lines SET status='canceled', canceled_at=? WHERE draft_id=? AND line_id=? AND status='active'").run(new Date().toISOString(), draftId, lineId);
    if (Number(result.changes) !== 1) throw new CheckoutError(404, "DRAFT_LINE_NOT_FOUND", "有効な販売明細が見つかりません");
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

export function addDraftPayment(db: PosDatabase, draftId: string, version: number, input: { kind: PaymentKind; amountYen?: number; tenderedYen?: number; referenceNote?: string }): SaleDraftDto {
  const kinds: PaymentKind[] = ["cash", "credit", "accounts_receivable", "no_charge"];
  if (!kinds.includes(input.kind)) throw new CheckoutError(400, "INVALID_PAYMENT_KIND", "支払方法が不正です");
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const lines = readLines(db, draftId);
    if (!lines.some((line) => line.status === "active")) throw new CheckoutError(409, "EMPTY_DRAFT", "商品が登録されていません");
    const existing = readPayments(db, draftId);
    if (input.kind === "no_charge" && existing.length) throw new CheckoutError(409, "PAYMENT_COMBINATION_INVALID", "無配は他の支払と併用できません");
    if (input.kind !== "no_charge" && existing.some((payment) => payment.kind === "no_charge")) throw new CheckoutError(409, "PAYMENT_COMBINATION_INVALID", "無配は他の支払と併用できません");
    const total = calculateDraft(db, String(row.event_id), lines, input.kind === "no_charge").totalYen;
    const paid = existing.reduce((sum, payment) => sum + payment.amountYen, 0);
    const amountYen = input.kind === "no_charge" ? 0 : input.amountYen ?? Math.max(0, total - paid);
    if (!Number.isSafeInteger(amountYen) || amountYen < 0 || (input.tenderedYen !== undefined && (!Number.isSafeInteger(input.tenderedYen) || input.tenderedYen < 0))) throw new CheckoutError(400, "INVALID_PAYMENT", "支払金額が不正です");
    const changeYen = input.kind === "cash" && input.tenderedYen !== undefined ? input.tenderedYen - amountYen : undefined;
    if (input.kind === "cash" && input.tenderedYen !== undefined && input.tenderedYen < amountYen) throw new CheckoutError(422, "PAYMENT_INSUFFICIENT", "預り金が不足しています", { amountYen, tenderedYen: input.tenderedYen });
    if (changeYen !== undefined && changeYen >= 10_000) throw new CheckoutError(422, "CHANGE_LIMIT_EXCEEDED", "釣銭が10,000円以上になる支払は入力できません", { changeYen });
    const sequence = existing.length + 1;
    db.prepare("INSERT INTO draft_payments (payment_id,draft_id,sequence,kind,amount_yen,tendered_yen,change_yen,reference_note,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(uuidV7(), draftId, sequence, input.kind, amountYen, input.tenderedYen ?? null, changeYen ?? null, input.referenceNote ?? null, new Date().toISOString());
    bump(db, draftId, version, "payment");
    return updateProjection(db, draftId);
  });
}

export function removeDraftPayment(db: PosDatabase, draftId: string, paymentId: string, version: number): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const result = db.prepare("DELETE FROM draft_payments WHERE draft_id=? AND payment_id=?").run(draftId, paymentId);
    if (Number(result.changes) !== 1) throw new CheckoutError(404, "DRAFT_PAYMENT_NOT_FOUND", "支払入力が見つかりません");
    bump(db, draftId, version, "editing");
    return updateProjection(db, draftId);
  });
}

export function addAgeVerification(db: PosDatabase, draftId: string, version: number, input: { minimumAge: 18 | 20; method: DraftAgeVerificationDto["method"]; result: DraftAgeVerificationDto["result"]; confirmerId?: string; terminalId: string }): SaleDraftDto {
  if (![18, 20].includes(input.minimumAge) || !["appearance", "id_visual", "self_declaration"].includes(input.method) || !["passed", "failed"].includes(input.result) || !input.terminalId) throw new CheckoutError(400, "INVALID_AGE_VERIFICATION", "年齢確認結果が不正です");
  if (input.method !== "self_declaration" && !input.confirmerId) throw new CheckoutError(400, "CONFIRMER_REQUIRED", "担当者による年齢確認が必要です");
  return immediate(db, () => {
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    db.prepare("INSERT INTO draft_age_verifications (verification_id,draft_id,minimum_age,method,result,confirmer_id,terminal_id,verified_at) VALUES (?,?,?,?,?,?,?,?)").run(uuidV7(), draftId, input.minimumAge, input.method, input.result, input.confirmerId ?? null, input.terminalId, new Date().toISOString());
    bump(db, draftId, version);
    return updateProjection(db, draftId);
  });
}

export function cancelSaleDraft(db: PosDatabase, draftId: string, version: number): SaleDraftDto {
  return immediate(db, () => {
    const row = draftRow(db, draftId);
    if (row.state !== "parked") assertMutable(db, row, version);
    else if (Number(row.version) !== version) throw new CheckoutError(409, "DRAFT_VERSION_CONFLICT", "販売ドラフトが別端末で更新されています");
    bump(db, draftId, version);
    db.prepare("UPDATE sale_drafts SET state='canceled' WHERE draft_id=?").run(draftId);
    return updateProjection(db, draftId);
  });
}

function requiredAge(db: PosDatabase, lines: DraftLineDto[]): number {
  let maximum = 0;
  const statement = db.prepare("SELECT age_requirement FROM event_products WHERE product_id=?");
  for (const line of lines.filter((candidate) => candidate.status === "active")) maximum = Math.max(maximum, Number((statement.get(line.productId) as { age_requirement: number }).age_requirement));
  return maximum;
}

function validatedPayments(payments: DraftPaymentDto[], calculation: SaleCalculation): Array<DraftPaymentDto & { changeYen?: number }> {
  if (calculation.totalYen === 0 && payments.length === 0) return [{ paymentId: uuidV7(), sequence: 1, kind: "no_charge", amountYen: 0 }];
  if (payments.length === 0) throw new CheckoutError(422, "PAYMENT_REQUIRED", "支払を入力してください");
  const noCharge = payments.some((payment) => payment.kind === "no_charge");
  if (noCharge && (payments.length !== 1 || calculation.totalYen !== 0 || payments[0]!.amountYen !== 0)) throw new CheckoutError(422, "PAYMENT_MISMATCH", "無配支払が会計金額と一致しません");
  const amount = payments.reduce((sum, payment) => sum + payment.amountYen, 0);
  if (amount !== calculation.totalYen) throw new CheckoutError(422, "PAYMENT_MISMATCH", "支払合計が会計金額と一致しません", { expectedYen: calculation.totalYen, actualYen: amount });
  return payments.map((payment) => {
    if (payment.kind !== "cash") return payment;
    if (payment.tenderedYen === undefined || payment.tenderedYen < payment.amountYen) throw new CheckoutError(422, "PAYMENT_INSUFFICIENT", "預り金が不足しています", { amountYen: payment.amountYen, tenderedYen: payment.tenderedYen ?? null });
    const changeYen = payment.tenderedYen - payment.amountYen;
    if (changeYen >= 10_000) throw new CheckoutError(422, "CHANGE_LIMIT_EXCEEDED", "釣銭が10,000円以上になる会計は確定できません", { changeYen });
    return { ...payment, changeYen };
  });
}

export function allocatePublicReference(db: PosDatabase, eventId: string, businessDate: string, sessionNo: number): { raw: string; display: string } {
  db.prepare("INSERT INTO public_reference_counters (event_id,business_date,session_no,next_sequence) VALUES (?,?,?,1) ON CONFLICT(event_id,business_date,session_no) DO NOTHING").run(eventId, businessDate, sessionNo);
  const counter = db.prepare("SELECT next_sequence FROM public_reference_counters WHERE event_id=? AND business_date=? AND session_no=?");
  const advance = db.prepare("UPDATE public_reference_counters SET next_sequence=next_sequence+1 WHERE event_id=? AND business_date=? AND session_no=?");
  const alreadyUsed = db.prepare("SELECT 1 FROM transactions WHERE event_id=? AND public_reference=? UNION SELECT 1 FROM holds WHERE event_id=? AND public_reference=? LIMIT 1");
  while (true) {
    const sequence = (counter.get(eventId, businessDate, sessionNo) as { next_sequence: number }).next_sequence;
    if (sequence > 999_999) throw new CheckoutError(409, "PUBLIC_REFERENCE_EXHAUSTED", "受付番号が上限に達しました");
    const raw = createPublicReference(sessionNo, sequence);
    advance.run(eventId, businessDate, sessionNo);
    if (!alreadyUsed.get(eventId, raw, eventId, raw)) return { raw, display: formatPublicReference(raw) };
  }
}

export function businessDateYYMMDD(businessDate: string): string { return businessDate.slice(2, 4) + businessDate.slice(5, 7) + businessDate.slice(8, 10); }

export function finalizeRequestHash(draftId: string, version: number): string { return createHash("sha256").update(JSON.stringify({ draftId, version })).digest("hex"); }

function formatYen(value: number): string { return `¥${Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`; }
function formatPlainAmount(value: number): string { return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

function receiptSnapshot(db: PosDatabase, row: Record<string, unknown>, calculation: SaleCalculation, payments: ReturnType<typeof validatedPayments>, transactionId: string, publicReference: string, publicReferenceRaw: string, confirmedAt: string): ReceiptSnapshot {
  const catalogRecord = getCatalog(db, String(row.event_id));
  const catalog = catalogRecord ? importEventCatalog(catalogRecord.catalogJson) : undefined;
  const receiptNotes = new Map(catalog?.products.map((product) => [product.productCode, product.receiptNote] as const) ?? []);
  const commonText = catalog?.receiptSettings?.commonText;
  const staffId = String(row.staff_id); const configuredStaff = catalog?.staffMembers?.find((member) => member.staffId === staffId || member.responsibleNumber === staffId || member.displayName === staffId);
  const staffPrintLabel = configuredStaff?.receiptDisplay === "name" ? configuredStaff.displayName : configuredStaff?.responsibleNumber ?? staffId.replace(/^staff-/, "").slice(0, 12);
  const registerNo = String(row.register_id).replace(/^register-/, "").slice(0, 12);
  const cashTendered = payments.filter((payment) => payment.tenderedYen !== undefined).reduce((sum, payment) => sum + (payment.tenderedYen ?? 0), 0);
  const change = payments.filter((payment) => payment.changeYen !== undefined).reduce((sum, payment) => sum + (payment.changeYen ?? 0), 0);
  const jst = new Date(Date.parse(confirmedAt) + 9 * 60 * 60 * 1000).toISOString();
  return {
    schemaVersion: 1, eventName: String(row.event_id), circleName: catalog?.customerWelcome?.circleName ?? String(row.event_id), transactionId, publicReference, publicReferenceRaw, transactionType: "sale", originalPublicReference: "", confirmedAt, confirmedAtPrinted: `${jst.slice(0, 10)} ${jst.slice(11, 16)}`, businessDate: String(row.business_date), businessDateYYMMDD: businessDateYYMMDD(String(row.business_date)), registerNo, staffPrintLabel,
    lines: calculation.lines.map((line) => ({ productCode: line.productCode, name: line.name, ...(receiptNotes.get(line.productCode)?.trim() ? { receiptNote: receiptNotes.get(line.productCode)!.trim() } : {}), quantity: line.quantity, unitPriceYen: line.priceInclTax, unitPriceFormatted: formatPlainAmount(line.priceInclTax), grossYen: line.grossYen, grossFormatted: formatYen(line.grossYen), discountAllocatedYen: line.discountYen, discountFormatted: formatYen(line.discountYen), taxYen: line.taxYen, taxFormatted: formatYen(line.taxYen), netYen: line.netYen, netFormatted: formatYen(line.netYen), taxRateBps: line.taxRate * 100 })),
    discounts: calculation.discounts.map((discount) => ({ label: discount.label, amountYen: discount.amountYen, amountFormatted: formatYen(discount.amountYen) })),
    taxSummaries: calculation.taxSummaries.map((summary) => ({ taxRateBps: summary.taxRateBps, taxableNetYen: summary.taxableNetYen, taxableNetFormatted: formatYen(summary.taxableNetYen), taxYen: summary.taxAmountYen, taxFormatted: formatYen(summary.taxAmountYen) })),
    payments: payments.map((payment) => ({ methodName: ({ cash: "現金", credit: "クレジット", accounts_receivable: "売掛", no_charge: "無配" } as const)[payment.kind], amountYen: payment.amountYen, amountFormatted: formatYen(payment.amountYen), tenderedYen: payment.tenderedYen ?? null, tenderedFormatted: payment.tenderedYen === undefined ? "" : formatYen(payment.tenderedYen), changeYen: payment.changeYen ?? null, changeFormatted: payment.changeYen === undefined ? "" : formatYen(payment.changeYen) })),
    subtotalYen: calculation.subtotalYen, subtotalFormatted: formatYen(calculation.subtotalYen), discountTotalYen: calculation.discountTotalYen, discountTotalFormatted: formatYen(calculation.discountTotalYen), taxTotalYen: calculation.taxTotalYen, taxTotalFormatted: formatYen(calculation.taxTotalYen), totalYen: calculation.totalYen, totalFormatted: formatYen(calculation.totalYen), tenderedYen: cashTendered || null, tenderedFormatted: cashTendered ? formatYen(cashTendered) : "", changeYen: change || null, changeFormatted: change ? formatYen(change) : "", isReprint: false, reprintLabel: "", reprintNo: 0, originalReceiptNumber: "", footer: commonText?.footer ?? "ありがとうございました", returnPolicy: commonText?.returnPolicy ?? "返品は責任者へお申し出ください", hasOriginalTransaction: false, hasDiscounts: calculation.discountTotalYen > 0, hasTendered: cashTendered > 0, hasChange: change > 0,
  };
}

export function finalizeSale(db: PosDatabase, draftId: string, version: number, idempotencyKey: string, failureInjector?: FailureInjector, drawerEnabled = false): FinalizeResult {
  if (!idempotencyKey.trim()) throw new CheckoutError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Keyが必要です");
  const requestHash = finalizeRequestHash(draftId, version);
  return immediate(db, () => {
    const existing = db.prepare("SELECT request_hash,response_json FROM idempotency_records WHERE scope='sale-finalize' AND idempotency_key=?").get(idempotencyKey) as { request_hash: string; response_json: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) throw new CheckoutError(409, "IDEMPOTENCY_KEY_REUSED", "同じIdempotency-Keyが異なる内容で使用されています");
      return JSON.parse(existing.response_json) as FinalizeResult;
    }
    failureInjector?.("after_idempotency_check");
    const row = draftRow(db, draftId); assertMutable(db, row, version);
    const lines = readLines(db, draftId);
    if (!lines.some((line) => line.status === "active")) throw new CheckoutError(422, "EMPTY_DRAFT", "商品が登録されていません");
    const draftPayments = readPayments(db, draftId);
    const noCharge = draftPayments.some((payment) => payment.kind === "no_charge");
    const calculation = calculateDraft(db, String(row.event_id), lines, noCharge);
    const payments = validatedPayments(draftPayments, calculation);
    const age = requiredAge(db, lines);
    if (age > 0) {
      const latest = db.prepare(`SELECT result FROM draft_age_verifications
        WHERE draft_id = ? AND minimum_age >= ? AND method IN ('appearance', 'id_visual') AND confirmer_id <> ''
        ORDER BY rowid DESC LIMIT 1`).get(draftId, age) as { result: DraftAgeVerificationDto["result"] } | undefined;
      if (latest?.result !== "passed") throw new CheckoutError(422, "AGE_VERIFICATION_REQUIRED", `${age}歳以上の担当者確認が必要です`, { minimumAge: age });
    }
    const ageVerifications = readAgeVerifications(db, draftId);
    failureInjector?.("after_recalculation");
    const now = new Date().toISOString();
    const transactionId = uuidV7();
    const reference = allocatePublicReference(db, String(row.event_id), String(row.business_date), Number(row.session_no));
    const paymentKind = payments.map((payment) => payment.kind).join("+");
    db.prepare(`INSERT INTO transactions (transaction_id,session_id,total_yen,idempotency_key,created_at,event_id,business_day_id,public_reference,public_reference_display,register_id,staff_id,type,subtotal_yen,discount_total_yen,tax_total_yen,tax_rounding_mode,payment_kind,draft_id,draft_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(transactionId, String(row.cash_session_id), calculation.totalYen, `sale-finalize:${idempotencyKey}`, now, String(row.event_id), `${row.event_id}:${row.business_date}:${row.session_no}`, reference.raw, reference.display, String(row.register_id), String(row.staff_id), "sale", calculation.subtotalYen, calculation.discountTotalYen, calculation.taxTotalYen, "floor", paymentKind, draftId, version);
    const transactionLineIds = new Map<string, string>();
    for (const line of calculation.lines) {
      const id = uuidV7(); transactionLineIds.set(line.lineId, id);
      const source = lines.find((candidate) => candidate.lineId === line.lineId)!;
      db.prepare(`INSERT INTO transaction_lines (transaction_line_id,transaction_id,line_no,source_draft_line_id,product_id,product_code,product_name,price_incl_tax,tax_rate_bps,tax_category,quantity,gross_yen,discount_yen,tax_yen,net_yen,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, transactionId, line.lineNo, line.lineId, source.productId, line.productCode, line.name, line.priceInclTax, line.taxRate * 100, line.taxCategory, line.quantity, line.grossYen, line.discountYen, line.taxYen, line.netYen, now);
    }
    for (const [index, discount] of calculation.discounts.entries()) {
      const discountId = uuidV7();
      db.prepare("INSERT INTO applied_discounts (applied_discount_id,transaction_id,source_key,label_snapshot,kind,value_kind,value,amount_yen,application_no,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(discountId, transactionId, discount.id, discount.label, discount.kind, discount.valueKind, discount.value, discount.amountYen, index + 1, now);
      for (const allocation of discount.allocations) db.prepare("INSERT INTO applied_discount_lines (applied_discount_line_id,applied_discount_id,transaction_line_id,quantity,allocated_amount_yen) VALUES (?,?,?,?,?)").run(uuidV7(), discountId, transactionLineIds.get(allocation.lineId)!, allocation.quantity, allocation.amountYen);
    }
    for (const payment of payments) db.prepare("INSERT INTO payments (payment_id,transaction_id,sequence,kind,method_name_snapshot,amount_yen,tendered_yen,change_yen,external_result,reference_note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(uuidV7(), transactionId, payment.sequence, payment.kind, ({ cash: "現金", credit: "クレジット", accounts_receivable: "売掛", no_charge: "無配" } as const)[payment.kind], payment.amountYen, payment.tenderedYen ?? null, payment.changeYen ?? null, payment.kind === "credit" ? "completed" : null, payment.referenceNote ?? null, now);
    for (const summary of calculation.taxSummaries) db.prepare("INSERT INTO tax_summaries (tax_summary_id,transaction_id,tax_rate_bps,taxable_gross_yen,discount_allocated_yen,taxable_net_yen,tax_amount_yen,rounding_mode) VALUES (?,?,?,?,?,?,?,?)").run(uuidV7(), transactionId, summary.taxRateBps, summary.taxableGrossYen, summary.discountAllocatedYen, summary.taxableNetYen, summary.taxAmountYen, summary.roundingMode);
    for (const verification of ageVerifications.filter((item) => item.result === "passed" && (item.method === "appearance" || item.method === "id_visual"))) db.prepare("INSERT INTO age_verifications (age_verification_id,transaction_id,source_draft_verification_id,minimum_age,method,result,confirmer_id,terminal_id,verified_at) VALUES (?,?,?,?,?,?,?,?,?)").run(uuidV7(), transactionId, verification.verificationId, verification.minimumAge, verification.method, verification.result, verification.confirmerId ?? null, verification.terminalId, verification.verifiedAt);
    failureInjector?.("after_transaction");
    for (const line of calculation.lines) {
      const source = lines.find((candidate) => candidate.lineId === line.lineId)!;
      const movementId = uuidV7();
      db.prepare("INSERT INTO inventory_movements (inventory_movement_id,event_id,product_id,type,quantity_delta,transaction_line_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)").run(movementId, String(row.event_id), source.productId, noCharge ? "distribution" : "sale", -line.quantity, transactionLineIds.get(line.lineId)!, String(row.staff_id), now);
      db.prepare("UPDATE inventory_balances SET on_hand=on_hand-?,version=version+1 WHERE event_id=? AND product_id=?").run(line.quantity, String(row.event_id), source.productId);
    }
    failureInjector?.("after_inventory");
    for (const payment of payments.filter((item) => item.kind === "cash" && item.amountYen > 0)) db.prepare("INSERT INTO cash_movements (session_id,type,amount_yen,transaction_id,reason,idempotency_key,actor_id,terminal_id,created_at) VALUES (?,'sale',?,?,?, ?,?,?,?)").run(String(row.cash_session_id), payment.amountYen, transactionId, "商品売上", `sale-finalize:${idempotencyKey}:${payment.sequence}`, String(row.staff_id), String(row.terminal_id), now);
    failureInjector?.("after_cash");
    db.prepare("INSERT INTO audit_log (event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'sale_finalize','transaction',?,?,?)").run(String(row.event_id), transactionId, JSON.stringify({ draftId, draftVersion: version, registerId: row.register_id, terminalId: row.terminal_id, staffId: row.staff_id, publicReference: reference.display, totalYen: calculation.totalYen, paymentKind }), now);
    failureInjector?.("after_audit");
    if (drawerEnabled && payments.some((payment) => payment.kind === "cash" && payment.amountYen > 0)) {
      const drawerJobId = uuidV7(); const drawerOperationId = uuidV7();
      db.prepare("INSERT INTO print_jobs (job_id,operation_id,transaction_id,printer_id,document_type,kind,payload_json,created_at,state,updated_at,source,renderer_version,bytes_sha256,expected_bytes_length,delivery_certainty) VALUES (?,?,?,?,?,'drawer',?,?,?,?,?,?,?,?,'not_sent')")
        .run(drawerJobId, drawerOperationId, transactionId, String(row.register_id), "drawer", JSON.stringify({ pin: 2, onMs: 40, offMs: 200, reason: "cash_sale" }), now, "pending", now, "event-pos", "event-pos-drawer-v1", "e11e22d0c2538e1cd892e671b4915e0cf57a34d71f54ea1712fbd9629a024134", 5);
      const drawerSequence = Number((db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM printer_operations").get() as { next: number }).next);
      db.prepare("INSERT INTO printer_operations (operation_id,sequence,kind,printer_id,payload_ref,state,available_at,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,'drawer','receipt-1',?,'pending',?,0,4,?,?)").run(drawerOperationId, drawerSequence, drawerJobId, now, now, now);
    }
    const printJobId = uuidV7();
    const snapshot = receiptSnapshot(db, row, calculation, payments, transactionId, reference.display, reference.raw, now);
    const receipt = renderReceipt(db, snapshot);
    const operationId = uuidV7();
    db.prepare(`INSERT INTO print_jobs (job_id,operation_id,transaction_id,printer_id,document_type,kind,payload_json,created_at,state,updated_at,source,renderer_version,bytes_sha256,template_key,template_version,template_source_sha256,asset_manifest_json,font_id,font_version,font_sha256,finishing_policy_id,finishing_policy_version,receipt_snapshot_json,canonical_ir,ir_sha256,escpos_bytes,expected_bytes_length,delivery_certainty)
      VALUES (?,?,?,?,?,'original',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'not_sent')`)
      .run(printJobId, operationId, transactionId, String(row.register_id), "receipt", JSON.stringify(snapshot), now, "pending", now, "event-pos", receipt.rendererVersion, receipt.bytesSha256, receipt.templateKey, receipt.templateVersion, receipt.templateSourceSha256, JSON.stringify(receipt.assets.map(({ rasterBase64: _raster, mime: _mime, ...asset }) => asset)), receipt.fontId, receipt.fontVersion, receipt.fontSha256, receipt.finishingPolicyId, receipt.finishingPolicyVersion, JSON.stringify(snapshot), receipt.canonicalIr, receipt.irSha256, Buffer.from(receipt.escposBytes), receipt.escposBytes.length);
    const operationSequence = Number((db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM printer_operations").get() as { next: number }).next);
    db.prepare("INSERT INTO printer_operations (operation_id,sequence,kind,printer_id,payload_ref,state,available_at,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,'print','receipt-1',?,'pending',?,0,4,?,?)").run(operationId, operationSequence, printJobId, now, now, now);
    failureInjector?.("after_print_job");
    const completedVersion = version + 1;
    db.prepare("UPDATE sale_drafts SET state='completed',version=?,completed_transaction_id=?,updated_at=? WHERE draft_id=?").run(completedVersion, transactionId, now, draftId);
    const result: FinalizeResult = { transactionId, draftId, draftVersion: completedVersion, publicReference: reference.raw, publicReferenceDisplay: reference.display, subtotalYen: calculation.subtotalYen, discountTotalYen: calculation.discountTotalYen, taxTotalYen: calculation.taxTotalYen, totalYen: calculation.totalYen, paymentKind, printJobId, printState: "pending", completedAt: now };
    db.prepare("INSERT INTO idempotency_records (scope,idempotency_key,request_hash,response_json,transaction_id,created_at) VALUES ('sale-finalize',?,?,?,?,?)").run(idempotencyKey, requestHash, JSON.stringify(result), transactionId, now);
    updateProjection(db, draftId);
    failureInjector?.("before_commit");
    return result;
  });
}

export function getTransactionSnapshot(db: PosDatabase, transactionId: string): Record<string, unknown> | undefined {
  const transaction = db.prepare("SELECT * FROM transactions WHERE transaction_id=?").get(transactionId) as Record<string, unknown> | undefined;
  if (!transaction) return undefined;
  return {
    transactionId: String(transaction.transaction_id), eventId: transaction.event_id, publicReference: transaction.public_reference, publicReferenceDisplay: transaction.public_reference_display, registerId: transaction.register_id, staffId: transaction.staff_id,
    subtotalYen: Number(transaction.subtotal_yen), discountTotalYen: Number(transaction.discount_total_yen), taxTotalYen: Number(transaction.tax_total_yen), totalYen: Number(transaction.total_yen), paymentKind: transaction.payment_kind, createdAt: transaction.created_at,
    lines: db.prepare("SELECT product_code AS productCode,product_name AS name,price_incl_tax AS priceInclTax,tax_rate_bps AS taxRateBps,tax_category AS taxCategory,quantity,gross_yen AS grossYen,discount_yen AS discountYen,tax_yen AS taxYen,net_yen AS netYen FROM transaction_lines WHERE transaction_id=? ORDER BY line_no").all(transactionId),
    discounts: db.prepare("SELECT label_snapshot AS label,kind,value_kind AS valueKind,value,amount_yen AS amountYen FROM applied_discounts WHERE transaction_id=? ORDER BY application_no").all(transactionId),
    payments: db.prepare("SELECT sequence,kind,method_name_snapshot AS methodName,amount_yen AS amountYen,tendered_yen AS tenderedYen,change_yen AS changeYen,external_result AS externalResult FROM payments WHERE transaction_id=? ORDER BY sequence").all(transactionId),
    taxSummaries: db.prepare("SELECT tax_rate_bps AS taxRateBps,taxable_gross_yen AS taxableGrossYen,discount_allocated_yen AS discountAllocatedYen,taxable_net_yen AS taxableNetYen,tax_amount_yen AS taxAmountYen,rounding_mode AS roundingMode FROM tax_summaries WHERE transaction_id=? ORDER BY tax_rate_bps DESC").all(transactionId),
    ageVerifications: db.prepare("SELECT minimum_age AS minimumAge,method,result,confirmer_id AS confirmerId,terminal_id AS terminalId,verified_at AS verifiedAt FROM age_verifications WHERE transaction_id=?").all(transactionId),
    printJob: db.prepare("SELECT job_id AS jobId,state,created_at AS createdAt FROM print_jobs WHERE transaction_id=? AND document_type='receipt'").get(transactionId),
  };
}

export function getCustomerDisplayProjection(db: PosDatabase, registerId: string): Record<string, unknown> | undefined {
  const row = db.prepare("SELECT public_projection_json FROM customer_display_states WHERE register_id=?").get(registerId) as { public_projection_json: string } | undefined;
  return row ? JSON.parse(row.public_projection_json) as Record<string, unknown> : undefined;
}

export function getCustomerDisplayVersion(db: PosDatabase, registerId: string): number | undefined {
  return (db.prepare("SELECT version FROM customer_display_states WHERE register_id=?").get(registerId) as { version: number } | undefined)?.version;
}
