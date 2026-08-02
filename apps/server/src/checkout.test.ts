import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase, type PosDatabase } from "./db.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const catalog = {
  eventId: "checkout-event",
  products: [
    { productCode: "00000001", name: "10%商品", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" },
    { productCode: "00000002", name: "8%商品", priceInclTax: 108, taxRate: 8, taxCategory: "inclusive_8", saleState: "on_sale" },
    { productCode: "00000003", name: "20歳商品", priceInclTax: 220, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", ageCheck: "20" },
    { productCode: "00000004", name: "停止商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "off_sale" },
  ],
  quickEntries: [
    { id: "good-set", label: "正常セット", components: [{ productCode: "00000001", quantity: 1 }, { productCode: "00000002", quantity: 1 }] },
    { id: "bad-set", label: "停止商品セット", components: [{ productCode: "00000001", quantity: 1 }, { productCode: "00000004", quantity: 1 }] },
  ],
  autoDiscountRules: [{ id: "pair", label: "2個で20円引き", requiredProducts: [{ productCode: "00000001", quantity: 2 }], discountYen: 20, priority: 10 }],
};

function makeApp(database = openDatabase(), checkoutFailureInjector?: (step: Parameters<NonNullable<Parameters<typeof buildApp>[0]["checkoutFailureInjector"]>>[0]) => void): { app: FastifyInstance; db: PosDatabase } {
  const app = buildApp({ database, ...(checkoutFailureInjector ? { checkoutFailureInjector } : {}) });
  apps.push(app);
  return { app, db: database };
}

async function installCatalog(app: FastifyInstance): Promise<void> {
  const response = await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog });
  expect(response.statusCode).toBe(200);
}

async function startDraft(app: FastifyInstance, registerId = "register-1"): Promise<any> {
  const response = await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId: catalog.eventId, staffId: "staff-1", terminalId: registerId, businessDate: "2026-08-02", sessionNo: 1 } });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function addLine(app: FastifyInstance, draft: any, productCode = "00000001", quantity = 1): Promise<any> {
  const response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode, quantity } });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function addPayment(app: FastifyInstance, draft: any, kind: "cash" | "credit" | "accounts_receivable" | "no_charge", amountYen?: number, tenderedYen?: number): Promise<any> {
  const response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(draft.version) }, payload: { kind, ...(amountYen === undefined ? {} : { amountYen }), ...(tenderedYen === undefined ? {} : { tenderedYen }) } });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function finalize(app: FastifyInstance, draft: any, key: string): Promise<any> {
  return app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": key }, payload: { version: draft.version } });
}

describe("durable checkout API", () => {
  it("atomically finalizes exact cash and keeps immutable receipt snapshots", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft); draft = await addPayment(app, draft, "cash", 110, 110);
    const response = await finalize(app, draft, "cash-exact");
    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result).toMatchObject({ totalYen: 110, paymentKind: "cash", printState: "queued" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transaction_lines").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tax_summaries").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE transaction_id IS NOT NULL").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='sale_finalize'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM printer_operations").get()).toMatchObject({ count: 1 });
    const transaction = await app.inject({ method: "GET", url: `/api/v1/transactions/${result.transactionId}` });
    expect(transaction.json()).toMatchObject({ lines: [{ productCode: "00000001", name: "10%商品", priceInclTax: 110, taxRateBps: 1000, taxCategory: "inclusive_10", grossYen: 110, netYen: 110 }] });
  });

  it("stores cash change and rejects insufficient tender or change of 10,000 yen and above", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let changed = await startDraft(app, "register-change"); changed = await addLine(app, changed); changed = await addPayment(app, changed, "cash", 110, 500);
    expect((await finalize(app, changed, "change-ok")).statusCode).toBe(201);
    expect(db.prepare("SELECT tendered_yen,change_yen FROM payments WHERE kind='cash'").get()).toMatchObject({ tendered_yen: 500, change_yen: 390 });

    let insufficient = await startDraft(app, "register-short"); insufficient = await addLine(app, insufficient);
    const short = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${insufficient.draftId}/payments`, headers: { "if-match": String(insufficient.version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 100 } });
    expect(short.statusCode).toBe(422); expect(short.json().error.code).toBe("PAYMENT_INSUFFICIENT");
    expect(db.prepare("SELECT COUNT(*) AS count FROM draft_payments WHERE draft_id=?").get(insufficient.draftId)).toMatchObject({ count: 0 });

    let excessive = await startDraft(app, "register-large-change"); excessive = await addLine(app, excessive);
    const large = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${excessive.draftId}/payments`, headers: { "if-match": String(excessive.version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 10_110 } });
    expect(large.statusCode).toBe(422); expect(large.json().error.code).toBe("CHANGE_LIMIT_EXCEEDED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 1 });
  });

  it("distinguishes credit, accounts receivable, and no-charge payments", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    for (const [index, kind] of (["credit", "accounts_receivable", "no_charge"] as const).entries()) {
      let draft = await startDraft(app, `register-method-${index}`); draft = await addLine(app, draft); draft = await addPayment(app, draft, kind, kind === "no_charge" ? 0 : 110);
      const response = await finalize(app, draft, `method-${kind}`);
      expect(response.statusCode).toBe(201);
      expect(response.json().totalYen).toBe(kind === "no_charge" ? 0 : 110);
    }
    expect(db.prepare("SELECT kind,amount_yen FROM payments ORDER BY kind").all()).toEqual([
      expect.objectContaining({ kind: "accounts_receivable", amount_yen: 110 }),
      expect.objectContaining({ kind: "credit", amount_yen: 110 }),
      expect.objectContaining({ kind: "no_charge", amount_yen: 0 }),
    ]);
    expect(db.prepare("SELECT type FROM inventory_movements WHERE type='distribution'").get()).toMatchObject({ type: "distribution" });
  });

  it("recalculates automatic/manual discounts and taxes from the product master", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft, "00000001", 2); draft = await addLine(app, draft, "00000002", 1);
    const eightLine = draft.lines.find((line: any) => line.productCode === "00000002");
    const discounted = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${eightLine.lineId}`, headers: { "if-match": String(draft.version) }, payload: { manualDiscount: { kind: "amount", value: 1 } } });
    expect(discounted.statusCode).toBe(200); draft = discounted.json();
    expect(draft.calculation).toMatchObject({ subtotalYen: 328, discountTotalYen: 21, totalYen: 307, taxSummaries: [{ taxRateBps: 1000, taxAmountYen: 18 }, { taxRateBps: 800, taxAmountYen: 7 }] });
    draft = await addPayment(app, draft, "credit", 307);
    expect((await finalize(app, draft, "discount-tax")).statusCode).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS count FROM applied_discounts").get()).toMatchObject({ count: 2 });

    let invalid = await startDraft(app, "register-invalid-discount"); invalid = await addLine(app, invalid);
    const lineId = invalid.lines[0].lineId;
    const overRate = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${invalid.draftId}/lines/${lineId}`, headers: { "if-match": String(invalid.version) }, payload: { manualDiscount: { kind: "rate", value: 101 } } });
    expect(overRate.statusCode).toBe(422);
    const overAmount = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${invalid.draftId}/lines/${lineId}`, headers: { "if-match": String(invalid.version) }, payload: { manualDiscount: { kind: "amount", value: 111 } } });
    expect(overAmount.statusCode).toBe(422);
  });

  it("removes automatic and manual discounts only when their conditions or values are cleared", async () => {
    const { app } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app, "register-discount-removal"); draft = await addLine(app, draft, "00000001", 2);
    expect(draft.calculation.discounts).toMatchObject([{ kind: "auto", amountYen: 20 }]);
    const lineId = draft.lines[0].lineId;
    const quantityChanged = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(draft.version) }, payload: { quantity: 1 } });
    draft = quantityChanged.json(); expect(draft.calculation.discounts).toEqual([]);
    const discounted = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(draft.version) }, payload: { manualDiscount: { kind: "rate", value: 100 } } });
    draft = discounted.json(); expect(draft.calculation.totalYen).toBe(0);
    const preserved = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(draft.version) }, payload: { quantity: 2 } });
    draft = preserved.json(); expect(draft.calculation.totalYen).toBe(0);
    const cleared = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(draft.version) }, payload: { manualDiscount: null } });
    expect(cleared.json().calculation.totalYen).toBe(200);
  });

  it("adds every bundle component or rolls the whole request back", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app);
    const failed = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/bundles`, headers: { "if-match": String(draft.version) }, payload: { bundleId: "bad-set" } });
    expect(failed.statusCode).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sale_draft_lines WHERE draft_id=?").get(draft.draftId)).toMatchObject({ count: 0 });
    expect((await app.inject({ method: "GET", url: `/api/v1/sale-drafts/${draft.draftId}` })).json().version).toBe(1);
    const success = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/bundles`, headers: { "if-match": "1" }, payload: { bundleId: "good-set" } });
    expect(success.statusCode).toBe(201); expect(success.json().lines).toHaveLength(2);
    const stale = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": "1" }, payload: { productCode: "00000001" } });
    expect(stale.statusCode).toBe(409); expect(stale.json()).toMatchObject({ error: { code: "DRAFT_VERSION_CONFLICT", details: { latest: { version: 2 } } } });
  });

  it("retains canceled lines but excludes them from sales and inventory", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft, "00000001"); draft = await addLine(app, draft, "00000002");
    const canceled = await app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${draft.lines[1].lineId}`, headers: { "if-match": String(draft.version) } });
    draft = canceled.json(); expect(draft.lines[1].status).toBe("canceled");
    draft = await addPayment(app, draft, "credit", 110);
    expect((await finalize(app, draft, "cancel-line")).statusCode).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sale_draft_lines WHERE status='canceled'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transaction_lines").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get()).toMatchObject({ count: 1 });
  });

  it("requires staff verification at the age required by the product and rejects PII fields", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft, "00000003");
    const canary = "CANARY-PRIVATE-1990-01-01";
    const pii = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/age-verifications`, headers: { "if-match": String(draft.version) }, payload: { minimumAge: 20, method: "id_visual", result: "passed", confirmerId: "staff-1", terminalId: "register-1", birthDate: canary } });
    expect(pii.statusCode).toBe(400); expect(pii.body).not.toContain(canary);
    let verified18 = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/age-verifications`, headers: { "if-match": String(draft.version) }, payload: { minimumAge: 18, method: "appearance", result: "passed", confirmerId: "staff-1", terminalId: "register-1" } });
    draft = verified18.json(); draft = await addPayment(app, draft, "credit", 220);
    const rejected = await finalize(app, draft, "age-18"); expect(rejected.statusCode).toBe(422); expect(rejected.json().error.code).toBe("AGE_VERIFICATION_REQUIRED");
    const verified20 = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/age-verifications`, headers: { "if-match": String(draft.version) }, payload: { minimumAge: 20, method: "id_visual", result: "passed", confirmerId: "staff-1", terminalId: "register-1" } });
    draft = verified20.json(); expect((await finalize(app, draft, "age-20")).statusCode).toBe(201);
    expect(JSON.stringify(db.prepare("SELECT * FROM draft_age_verifications").all())).not.toContain(canary);
    expect(JSON.stringify(db.prepare("SELECT * FROM age_verifications").all())).not.toContain(canary);
  });

  it("returns the same result for an identical idempotency retry and rejects payload reuse", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft); draft = await addPayment(app, draft, "credit", 110);
    const first = await finalize(app, draft, "retry-key"); const second = await finalize(app, draft, "retry-key");
    expect(second.statusCode).toBe(201); expect(second.json()).toEqual(first.json());
    const mismatch = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "retry-key" }, payload: { version: draft.version - 1 } });
    expect(mismatch.statusCode).toBe(409); expect(mismatch.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='receipt'").get()).toMatchObject({ count: 1 });
  });

  it("prevents double finalization from simultaneous Enter/button requests and allocates unique references across registers", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    db.prepare("UPDATE inventory_balances SET on_hand=1 WHERE product_id=?").run(`${catalog.eventId}:00000001`);
    let firstDraft = await startDraft(app, "register-1"); firstDraft = await addLine(app, firstDraft); firstDraft = await addPayment(app, firstDraft, "credit", 110);
    let secondDraft = await startDraft(app, "register-2"); secondDraft = await addLine(app, secondDraft); secondDraft = await addPayment(app, secondDraft, "credit", 110);
    const [enter, button, secondRegister] = await Promise.all([finalize(app, firstDraft, "double-key"), finalize(app, firstDraft, "double-key"), finalize(app, secondDraft, "register-2-key")]);
    expect(enter.json().transactionId).toBe(button.json().transactionId);
    expect(secondRegister.statusCode).toBe(201);
    const references = db.prepare("SELECT public_reference FROM transactions ORDER BY public_reference").all() as Array<{ public_reference: string }>;
    expect(new Set(references.map((row) => row.public_reference)).size).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get()).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT on_hand FROM inventory_balances WHERE product_id=?").get(`${catalog.eventId}:00000001`)).toMatchObject({ on_hand: -1 });
  });

  it("rolls every artifact back when failure is injected in the transaction", async () => {
    const { app, db } = makeApp(openDatabase(), (step) => { if (step === "after_inventory") throw new Error("injected"); }); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft); draft = await addPayment(app, draft, "cash", 110, 110);
    const response = await finalize(app, draft, "rollback-key"); expect(response.statusCode).toBe(500);
    for (const table of ["transactions", "transaction_lines", "payments", "tax_summaries", "inventory_movements", "idempotency_records", "printer_operations"]) expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT on_hand FROM inventory_balances WHERE product_id=?").get(`${catalog.eventId}:00000001`)).toMatchObject({ on_hand: 0 });
    expect((await app.inject({ method: "GET", url: `/api/v1/sale-drafts/${draft.draftId}` })).json().state).toBe("payment");
  });

  it("keeps the committed sale when post-commit printer dispatch fails", async () => {
    const db = openDatabase();
    const app = buildApp({ database: db, printerHost: { accept: async () => { throw new Error("printer offline"); } } });
    apps.push(app); await installCatalog(app);
    let draft = await startDraft(app, "register-print-failure"); draft = await addLine(app, draft); draft = await addPayment(app, draft, "cash", 110, 110);
    const response = await finalize(app, draft, "print-failure-key");
    expect(response.statusCode).toBe(201);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT state,error_message FROM print_jobs WHERE job_id=?").get(response.json().printJobId)).toMatchObject({ state: "failed", error_message: "printer offline" });
  });

  it("会計済みdraftの取消・数量・売価・値引き・支払・登録中止をAPIでも拒否する", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app, "register-locked"); draft = await addLine(app, draft); draft = await addPayment(app, draft, "credit", 110);
    const finalized = await finalize(app, draft, "locked-key");
    expect(finalized.statusCode).toBe(201);
    const completed = (await app.inject({ method: "GET", url: `/api/v1/sale-drafts/${draft.draftId}` })).json();
    expect(completed.state).toBe("completed");
    const lineId = completed.lines[0].lineId;
    const attempts = await Promise.all([
      app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(completed.version) } }),
      app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(completed.version) }, payload: { quantity: 2 } }),
      app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(completed.version) }, payload: { manualDiscount: { kind: "rate", value: 10 } } }),
      app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(completed.version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 110 } }),
      app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${draft.draftId}`, headers: { "if-match": String(completed.version) } }),
    ]);
    for (const attempt of attempts) { expect(attempt.statusCode).toBe(409); expect(attempt.json().error.code).toBe("DRAFT_NOT_EDITABLE"); }
    const retry = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "locked-key" }, payload: { version: draft.version } });
    expect(retry.json().transactionId).toBe(finalized.json().transactionId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='receipt'").get()).toMatchObject({ count: 1 });
  });

  it("restores the completed transaction and public projection after a database reopen", async () => {
    const path = "./.checkout-reopen-test.sqlite";
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    const first = makeApp(openDatabase(path)); await installCatalog(first.app);
    let draft = await startDraft(first.app); draft = await addLine(first.app, draft); draft = await addPayment(first.app, draft, "credit", 110);
    const result = (await finalize(first.app, draft, "persist-key")).json();
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const reopened = makeApp(openDatabase(path));
    expect((await reopened.app.inject({ method: "GET", url: `/api/v1/transactions/${result.transactionId}` })).statusCode).toBe(200);
    expect((await reopened.app.inject({ method: "GET", url: "/api/v1/registers/register-1/sale-draft" })).json()).toMatchObject({ state: "completed", completedTransactionId: result.transactionId });
    expect((await reopened.app.inject({ method: "GET", url: "/api/v1/customer-displays/register-1" })).json()).toMatchObject({ state: "completed", transactionId: result.transactionId, payment: { state: "completed", kinds: ["credit"] } });
    await reopened.app.close(); apps.splice(apps.indexOf(reopened.app), 1);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  });

  it("keeps all artifact counts aligned at 60 sales per minute-equivalent burst", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    for (let index = 0; index < 60; index += 1) {
      let draft = await startDraft(app, `load-register-${index}`); draft = await addLine(app, draft); draft = await addPayment(app, draft, "cash", 110, 110);
      expect((await finalize(app, draft, `load-${index}`)).statusCode).toBe(201);
    }
    for (const table of ["transactions", "transaction_lines", "payments", "inventory_movements", "idempotency_records", "print_jobs", "printer_operations"]) expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}${table === "print_jobs" ? " WHERE document_type='receipt'" : ""}`).get()).toMatchObject({ count: 60 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE transaction_id IS NOT NULL").get()).toMatchObject({ count: 60 });
  });
});
