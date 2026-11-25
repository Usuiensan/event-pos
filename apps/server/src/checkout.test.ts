import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { createPublicReference } from "@event-pos/contracts";
import { buildApp } from "./app.js";
import { openDatabase, type PosDatabase } from "./db.js";
import { openRegisterForTest, signInForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const catalog = {
  eventId: "checkout-event",
  products: [
    { productCode: "00000001", name: "10%商品", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", departmentId: "001" },
    { productCode: "00000002", name: "8%商品", priceInclTax: 108, taxRate: 8, taxCategory: "inclusive_8", saleState: "on_sale", departmentId: "002" },
    { productCode: "00000003", name: "20歳商品", priceInclTax: 220, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", ageCheck: "20" },
    { productCode: "00000004", name: "停止商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "off_sale" },
  ],
  quickEntries: [
    { id: "good-set", label: "正常セット", components: [{ productCode: "00000001", quantity: 1 }, { productCode: "00000002", quantity: 1 }] },
    { id: "bad-set", label: "停止商品セット", components: [{ productCode: "00000001", quantity: 1 }, { productCode: "00000004", quantity: 1 }] },
  ],
  autoDiscountRules: [{ id: "pair", label: "2個で20円引き", requiredProducts: [{ productCode: "00000001", quantity: 2 }], discountYen: 20, priority: 10 }],
  departments: [{ departmentId: "001", code: "001", name: "第一部門", settlementOwnerId: "001", enabled: true }, { departmentId: "002", code: "002", name: "第二部門", settlementOwnerId: "002", enabled: true }],
  staffMembers: [{ responsibleNumber: "001", displayName: "試験管理者", role: "admin" }],
};

function makeApp(database = openDatabase(), checkoutFailureInjector?: (step: Parameters<NonNullable<Parameters<typeof buildApp>[0]["checkoutFailureInjector"]>>[0]) => void, drawerEnabled = false): { app: FastifyInstance; db: PosDatabase } {
  const app = buildApp({ database, drawerEnabled, ...(checkoutFailureInjector ? { checkoutFailureInjector } : {}) });
  apps.push(app);
  return { app, db: database };
}

async function installCatalog(app: FastifyInstance, catalogOverride = catalog): Promise<void> {
  const response = await app.inject({ method: "PUT", url: `/api/v1/events/${catalogOverride.eventId}/catalog`, payload: catalogOverride });
  expect(response.statusCode).toBe(200);
}

async function startDraft(app: FastifyInstance, registerId = "register-1"): Promise<any> {
  await openRegisterForTest(app, catalog.eventId, "2026-08-02", registerId);
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
  it.each([
    { kind: "cash", totalYen: 180, discountYen: 20, tenderedYen: 500, changeYen: 320 },
    { kind: "credit", totalYen: 180, discountYen: 20 },
    { kind: "no_charge", totalYen: 0, discountYen: 200 },
  ] as const)("確定済みの明細・値引き配賦・税・支払を設定変更後も返す ($kind)", async ({ kind, totalYen, discountYen, ...cash }) => {
    const { app } = makeApp();
    const product = { ...catalog.products[0]!, priceInclTax: 100 };
    const originalCatalog = { ...catalog, products: [product, ...catalog.products.slice(1)] };
    await installCatalog(app, originalCatalog);
    let draft = await addLine(app, await startDraft(app), product.productCode, 2);
    const lineId = draft.lines[0].lineId;
    const url = `/api/v1/sale-drafts/${draft.draftId}`;
    const parked = await app.inject({ method: "POST", url: `${url}/park`, payload: { terminalId: "register-1" } });
    expect(parked.statusCode).toBe(201);
    const resumed = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/parked-drafts/resume", payload: { terminalId: "register-1", parkReference: parked.json().parkReference } });
    expect(resumed.statusCode).toBe(200);
    draft = await addPayment(app, resumed.json(), kind, totalYen, "tenderedYen" in cash ? cash.tenderedYen : undefined);
    const finalized = await finalize(app, draft, `snapshot-${kind}`);
    expect(finalized.statusCode).toBe(201);

    await installCatalog(app, { ...originalCatalog, products: [{ ...product, name: "改名済み商品", priceInclTax: 250 }, ...catalog.products.slice(1)], autoDiscountRules: [] });
    for (const endpoint of [url, "/api/v1/registers/register-1/sale-draft"]) {
      const response = await app.inject(endpoint);
      expect(response.statusCode).toBe(200);
      const completed = response.json();
      expect(completed).toMatchObject({
        state: "completed", completedTransactionId: finalized.json().transactionId,
        lines: [{ lineId, name: product.name, priceInclTax: 100, quantity: 2 }],
        calculation: {
          subtotalYen: 200, discountTotalYen: discountYen, totalYen, taxTotalYen: Math.floor(totalYen / 11),
          lines: [{ lineId, name: product.name, grossYen: 200, discountYen, netYen: totalYen }],
          discounts: expect.arrayContaining([{ id: "auto:pair", kind: "auto", label: "2個で20円引き", valueKind: "amount", value: 20, amountYen: 20, allocations: [{ lineId, quantity: 2, amountYen: 20 }] }]),
          taxSummaries: [{ taxRateBps: 1000, taxableGrossYen: 200, discountAllocatedYen: discountYen, taxableNetYen: totalYen, taxAmountYen: Math.floor(totalYen / 11), roundingMode: "floor" }],
        },
        payments: [{ kind, amountYen: totalYen, ...cash }],
      });
      if (kind !== "cash") expect(completed.payments[0]).not.toHaveProperty("changeYen");
    }
  });

  it("返品対象検索は認証必須でイベントを越えて検索できない", async () => {
    const database = openDatabase();
    const app = buildApp({ database, requireAuth: true }); apps.push(app);
    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/transactions/returnable?eventId=checkout-event&query=123" });
    expect(unauthenticated.statusCode).toBe(401);
    const installed = await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog });
    expect(installed.statusCode).toBe(200);
    const session = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    const foreign = await app.inject({ method: "GET", url: "/api/v1/transactions/returnable?eventId=other-event&query=123", headers: session });
    expect(foreign.statusCode).toBe(403);
  });

  it("定期刊行物は18桁の号・年月・バーコード価格から販売明細を作り、13桁本体へフォールバックしない", async () => {
    const { app } = makeApp(); await installCatalog(app); const draft = await startDraft(app);
    const response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/periodicals`, headers: { "if-match": String(draft.version) }, payload: { code: "491217631016501000" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().lines).toMatchObject([{ productCode: "491217631016501000", name: "定期刊行物 17631 2026年1月号", priceInclTax: 1100, taxCategory: "exclusive_10", source: "scan" }]);
    expect((await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/periodicals`, headers: { "if-match": "2" }, payload: { code: "4912176310165" } })).statusCode).toBe(400);
  });
  it("元売上を変更せず全部返品を支払・現金・在庫・税へ逆仕訳し、返品レシートを作る", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft, "00000001", 1); draft = await addPayment(app, draft, "cash", 110, 500);
    const sale = await finalize(app, draft, "return-source"); expect(sale.statusCode).toBe(201); const originalId = sale.json().transactionId as string;
    const sessionId = (await app.inject({ method: "GET", url: "/api/v1/cash-sessions/current?eventId=checkout-event&businessDate=2026-08-02&cashboxId=register-1" })).json().session.sessionId as string;
    const headers = { "x-pos-role": "manager", "x-pos-actor-id": "manager-1", "idempotency-key": "full-return-1" };
    const returned = await app.inject({ method: "POST", url: `/api/v1/transactions/${originalId}/full-return`, headers, payload: { cashSessionId: sessionId, terminalId: "register-1", reason: "商品不良" } });
    if (returned.statusCode !== 201) throw new Error(returned.body); const result = returned.json(); expect(result).toMatchObject({ originalTransactionId: originalId, totalYen: -110 });
    expect((await app.inject({ method: "POST", url: `/api/v1/transactions/${originalId}/full-return`, headers, payload: { cashSessionId: sessionId, terminalId: "register-1", reason: "商品不良" } })).json().transactionId).toBe(result.transactionId);
    expect(db.prepare("SELECT type,total_yen,original_transaction_id,reason_text FROM transactions WHERE transaction_id=?").get(result.transactionId)).toEqual({ type: "return", total_yen: -110, original_transaction_id: originalId, reason_text: "商品不良" });
    expect(db.prepare("SELECT quantity,gross_yen,tax_yen,net_yen FROM transaction_lines WHERE transaction_id=?").get(result.transactionId)).toMatchObject({ quantity: -1, gross_yen: -110, tax_yen: -10, net_yen: -110 });
    expect(db.prepare("SELECT amount_yen FROM payments WHERE transaction_id=?").get(result.transactionId)).toEqual({ amount_yen: -110 });
    expect(db.prepare("SELECT type,quantity_delta FROM inventory_movements WHERE transaction_line_id IN (SELECT transaction_line_id FROM transaction_lines WHERE transaction_id=?)").get(result.transactionId)).toEqual({ type: "return", quantity_delta: 1 });
    expect(db.prepare("SELECT type,amount_yen FROM cash_movements WHERE transaction_id=?").get(result.transactionId)).toEqual({ type: "return", amount_yen: 110 });
    expect(db.prepare("SELECT tax_amount_yen FROM tax_summaries WHERE transaction_id=?").get(result.transactionId)).toEqual({ tax_amount_yen: -10 });
    const snapshot = JSON.parse(String((db.prepare("SELECT receipt_snapshot_json FROM print_jobs WHERE transaction_id=?").get(result.transactionId) as { receipt_snapshot_json: string }).receipt_snapshot_json)); expect(snapshot).toMatchObject({ transactionType: "return", originalPublicReference: expect.any(String), totalYen: 110, hasOriginalTransaction: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='full_return' AND entity_id=?").get(result.transactionId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT total_yen,type FROM transactions WHERE transaction_id=?").get(originalId)).toEqual({ total_yen: 110, type: "sale" });
    const search = await app.inject({ method: "GET", url: `/api/v1/transactions/returnable?eventId=checkout-event&query=${encodeURIComponent(sale.json().publicReference)}`, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" } }); expect(search.json().transactions[0]).toMatchObject({ transactionId: originalId, returnable: false, returnTransactionId: result.transactionId });
    let creditDraft = await startDraft(app, "register-credit-return"); creditDraft = await addLine(app, creditDraft); creditDraft = await addPayment(app, creditDraft, "credit", 110); const creditSale = await finalize(app, creditDraft, "credit-return-source");
    const creditReturn = await app.inject({ method: "POST", url: `/api/v1/transactions/${creditSale.json().transactionId}/full-return`, headers: { "idempotency-key": "credit-return-1" }, payload: { cashSessionId: sessionId, terminalId: "register-1", reason: "紙面へ手書き", externalResults: { "1": "completed" } } }); expect(creditReturn.statusCode).toBe(201);
    expect(db.prepare("SELECT external_result FROM payments WHERE transaction_id=?").get(creditReturn.json().transactionId)).toEqual({ external_result: "completed" });
  });
  it("権限制限なしで商品指定または金額指定の例外返金を追記し署名欄付きレシートを作る", async () => {
    const { app, db } = makeApp(); await installCatalog(app); const sessionId="manual-refund-session";
    await app.inject({method:"POST",url:"/api/v1/cash-sessions",payload:{sessionId,eventId:catalog.eventId,businessDate:"2026-08-02",cashboxId:"register-1"}});
    await app.inject({method:"POST",url:`/api/v1/cash-sessions/${sessionId}/checks/opening`,payload:{counted:[{denomination:1000,quantity:2}]}});
    const response=await app.inject({method:"POST",url:"/api/v1/refunds/manual",headers:{"idempotency-key":"manual-refund-1"},payload:{eventId:catalog.eventId,cashSessionId:sessionId,terminalId:"register-1",description:"マスタ異常商品の返金",amountYen:350,paymentKind:"cash"}});
    expect(response.statusCode).toBe(201); const id=response.json().transactionId;
    expect(db.prepare("SELECT type,total_yen,staff_id FROM transactions WHERE transaction_id=?").get(id)).toEqual({type:"return",total_yen:-350,staff_id:"unsigned-operator"});
    expect(db.prepare("SELECT type,amount_yen FROM cash_movements WHERE transaction_id=?").get(id)).toEqual({type:"return",amount_yen:350});
    expect(db.prepare("SELECT reason_text FROM transactions WHERE transaction_id=?").get(id)).toEqual({reason_text:"紙面へ手書き"});
    const snapshot=JSON.parse(String((db.prepare("SELECT receipt_snapshot_json FROM print_jobs WHERE transaction_id=?").get(id) as {receipt_snapshot_json:string}).receipt_snapshot_json));
    expect(snapshot.footer).toContain("扱い者署名"); expect(snapshot.footer).not.toContain("返品理由");
    const selected=await app.inject({method:"POST",url:"/api/v1/refunds/manual",headers:{"idempotency-key":"manual-refund-2"},payload:{eventId:catalog.eventId,cashSessionId:sessionId,terminalId:"register-1",description:"お客様都合の返金",amountYen:200,paymentKind:"cash",reason:"買主都合"}});
    expect(selected.statusCode).toBe(201); const selectedId=selected.json().transactionId;
    expect(db.prepare("SELECT reason_text FROM transactions WHERE transaction_id=?").get(selectedId)).toEqual({reason_text:"買主都合"});
    expect(db.prepare("SELECT reason FROM cash_movements WHERE transaction_id=?").get(selectedId)).toEqual({reason:"買主都合"});
    const audit=db.prepare("SELECT detail_json FROM audit_log WHERE action='manual_refund' AND entity_id=?").get(selectedId) as {detail_json:string};
    expect(JSON.parse(audit.detail_json)).toMatchObject({reason:"買主都合",reasonRecordedOnPaper:false});
  });
  it("atomically finalizes exact cash and keeps immutable receipt snapshots", async () => {
    const { app, db } = makeApp(openDatabase(), undefined, true); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft); draft = await addPayment(app, draft, "cash", 110, 110);
    const response = await finalize(app, draft, "cash-exact");
    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result).toMatchObject({ totalYen: 110, paymentKind: "cash", printState: "pending" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transaction_lines").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM payments").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tax_summaries").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE transaction_id IS NOT NULL").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='sale_finalize'").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT o.kind FROM printer_operations o JOIN print_jobs j ON j.job_id=o.payload_ref WHERE j.transaction_id=? ORDER BY o.sequence").all(result.transactionId)).toEqual([{ kind: "drawer" }, { kind: "print" }]);
    expect(db.prepare("SELECT document_type,payload_json FROM print_jobs WHERE transaction_id=? ORDER BY created_at,document_type").all(result.transactionId)).toContainEqual({ document_type: "drawer", payload_json: JSON.stringify({ pin: 2, onMs: 40, offMs: 200, reason: "cash_sale" }) });
    const transaction = await app.inject({ method: "GET", url: `/api/v1/transactions/${result.transactionId}` });
    expect(transaction.json()).toMatchObject({ lines: [{ productCode: "00000001", name: "10%商品", priceInclTax: 110, taxRateBps: 1000, taxCategory: "inclusive_10", grossYen: 110, netYen: 110 }] });
  });

  it("販売レシートの共通文言をカタログからスナップショットへ取り込む", async () => {
    const cases: Array<{ commonText?: { footer: string; returnPolicy: string }; expected: { footer: string; returnPolicy: string } }> = [
      { commonText: { footer: "イベントありがとうございました", returnPolicy: "返品は受付へ" }, expected: { footer: "イベントありがとうございました", returnPolicy: "返品は受付へ" } },
      { expected: { footer: "ありがとうございました", returnPolicy: "返品は責任者へお申し出ください" } },
      { commonText: { footer: "", returnPolicy: "" }, expected: { footer: "", returnPolicy: "" } },
    ];
    for (const [index, testCase] of cases.entries()) {
      const { app, db } = makeApp();
      const catalogOverride = testCase.commonText === undefined ? catalog : { ...catalog, receiptSettings: { templates: {}, commonText: testCase.commonText } };
      await installCatalog(app, catalogOverride);
      let draft = await startDraft(app, `register-common-text-${index}`);
      draft = await addLine(app, draft);
      draft = await addPayment(app, draft, "credit", 110);
      const response = await finalize(app, draft, `common-text-${index}`);
      expect(response.statusCode).toBe(201);
      const snapshot = JSON.parse(String((db.prepare("SELECT receipt_snapshot_json FROM print_jobs WHERE transaction_id=?").get(response.json().transactionId) as { receipt_snapshot_json: string }).receipt_snapshot_json));
      expect(snapshot).toMatchObject(testCase.expected);
    }
  });

  it("商品マスタのreceiptNoteを確定時のレシートスナップショットへ保存する", async () => {
    const { app, db } = makeApp();
    await installCatalog(app, { ...catalog, products: catalog.products.map((product) => product.productCode === "00000001" ? { ...product, receiptNote: "一行目\n二行目" } : product) });
    let draft = await startDraft(app, "register-receipt-note"); draft = await addLine(app, draft, "00000001"); draft = await addLine(app, draft, "00000002"); draft = await addPayment(app, draft, "credit", 218);
    const response = await finalize(app, draft, "receipt-note"); expect(response.statusCode).toBe(201);
    const snapshot = JSON.parse(String((db.prepare("SELECT receipt_snapshot_json FROM print_jobs WHERE transaction_id=?").get(response.json().transactionId) as { receipt_snapshot_json: string }).receipt_snapshot_json));
    expect(snapshot.lines[0].receiptNote).toBe("一行目\n二行目");
    expect(snapshot.lines[1]).not.toHaveProperty("receiptNote");
    const canonicalIr = String((db.prepare("SELECT canonical_ir FROM print_jobs WHERE transaction_id=?").get(response.json().transactionId) as { canonical_ir: string }).canonical_ir);
    expect(canonicalIr.indexOf("一行目")).toBeGreaterThan(canonicalIr.indexOf("10%商品"));
    expect(canonicalIr.indexOf("一行目")).toBeLessThan(canonicalIr.indexOf("品番 00000001"));
  });

  it("drawer未受入時は現金会計でもpulse jobを作らない", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft); draft = await addPayment(app, draft, "cash", 110, 110);
    expect((await finalize(app, draft, "drawer-disabled")).statusCode).toBe(201);
    expect(db.prepare("SELECT o.kind FROM printer_operations o JOIN print_jobs j ON j.job_id=o.payload_ref WHERE j.document_type='receipt' ORDER BY o.sequence").all()).toEqual([{ kind: "print" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='drawer'").get()).toEqual({ count: 0 });
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

  it("精算サマリに無配の件数と値引額を集計する", async () => {
    const { app } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft); draft = await addPayment(app, draft, "no_charge", 0);
    expect((await finalize(app, draft, "settlement-no-charge")).statusCode).toBe(201);
    const sessionId = (await app.inject({ method: "GET", url: "/api/v1/cash-sessions/current?eventId=checkout-event&businessDate=2026-08-02&cashboxId=register-1" })).json().session.sessionId as string;
    const summary = await app.inject({ method: "GET", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/settlement-summary` });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ salesCount: 1, salesYen: 0, noChargeCount: 1, noChargeYen: 110 });
  });

  it("精算サマリに部門別の数量と金額を集計する", async () => {
    const { app } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app); draft = await addLine(app, draft, "00000001"); draft = await addLine(app, draft, "00000002"); draft = await addPayment(app, draft, "credit", 218);
    expect((await finalize(app, draft, "settlement-departments")).statusCode).toBe(201);
    const sessionId = (await app.inject({ method: "GET", url: "/api/v1/cash-sessions/current?eventId=checkout-event&businessDate=2026-08-02&cashboxId=register-1" })).json().session.sessionId as string;
    const summary = await app.inject({ method: "GET", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/settlement-summary` });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().departments).toEqual([
      { departmentId: "001", name: "第一部門", quantity: 1, salesYen: 110 },
      { departmentId: "002", name: "第二部門", quantity: 1, salesYen: 108 },
    ]);
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

  it("同一の商品条件だけを同じ明細へ加算し、計算結果を更新する", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let draft = await startDraft(app, "register-line-merge");

    draft = await addLine(app, draft, "00000001", 1);
    const firstLineId = draft.lines[0].lineId;
    draft = await addLine(app, draft, "00000001", 1);
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ lineId: firstLineId, quantity: 2 });
    expect(draft.calculation).toMatchObject({ subtotalYen: 220, discountTotalYen: 20, totalYen: 200 });

    const discounted = await app.inject({ method: "PATCH", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${firstLineId}`, headers: { "if-match": String(draft.version) }, payload: { manualDiscount: { kind: "amount", value: 1 } } });
    draft = discounted.json();
    draft = await addLine(app, draft, "00000001", 1);
    expect(draft.lines.filter((line: any) => line.status === "active")).toHaveLength(2);

    let optionDraft = await startDraft(app, "register-line-options");
    const postOption = async (value: Record<string, unknown>) => {
      const response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${optionDraft.draftId}/lines`, headers: { "if-match": String(optionDraft.version) }, payload: { productCode: "00000001", productOptions: value } });
      expect(response.statusCode).toBe(201); optionDraft = response.json();
    };
    await postOption({ size: "M", toppings: ["A", "B"] });
    await postOption({ toppings: ["A", "B"], size: "M" });
    await postOption({ size: "L", toppings: ["A", "B"] });
    expect(optionDraft.lines).toHaveLength(2);
    expect(optionDraft.lines[0]).toMatchObject({ quantity: 2, productOptions: { size: "M", toppings: ["A", "B"] } });
    expect(optionDraft.lines[1]).toMatchObject({ quantity: 1, productOptions: { size: "L", toppings: ["A", "B"] } });

    let priceDraft = await startDraft(app, "register-line-price");
    priceDraft = await addLine(app, priceDraft, "00000001", 1);
    db.prepare("UPDATE event_products SET price_incl_tax=120, tax_rate_bps=800, tax_category='inclusive_8' WHERE event_id=? AND product_code=?").run(catalog.eventId, "00000001");
    priceDraft = await addLine(app, priceDraft, "00000001", 1);
    expect(priceDraft.lines).toHaveLength(2);
    expect(priceDraft.lines.map((line: any) => ({ priceInclTax: line.priceInclTax, taxRate: line.taxRate, taxCategory: line.taxCategory }))).toEqual([
      { priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10" },
      { priceInclTax: 120, taxRate: 8, taxCategory: "inclusive_8" },
    ]);
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

  it.each([
    {
      title: "合格の後に同じ年齢で不合格を登録すると確定を拒否する",
      ageCheck: "20",
      checks: [
        { minimumAge: 20, method: "appearance", result: "passed" },
        { minimumAge: 20, method: "id_visual", result: "failed" },
      ],
      status: 422,
    },
    {
      title: "不合格の後に同じ年齢で合格を登録すると確定できる",
      ageCheck: "20",
      checks: [
        { minimumAge: 20, method: "appearance", result: "failed" },
        { minimumAge: 20, method: "id_visual", result: "passed" },
      ],
      status: 201,
    },
    {
      title: "20歳の合格で18歳の年齢要件を満たす",
      ageCheck: "18",
      checks: [{ minimumAge: 20, method: "id_visual", result: "passed" }],
      status: 201,
    },
  ])("$title", async ({ ageCheck, checks, status }) => {
    const { app, db } = makeApp();
    const products = catalog.products.map((product) => product.productCode === "00000003" && product.ageCheck ? { ...product, ageCheck } : product);
    await installCatalog(app, { ...catalog, products });
    let draft = await startDraft(app);
    draft = await addLine(app, draft, "00000003");
    draft = await addPayment(app, draft, "credit", 220);
    try {
      for (const [index, check] of checks.entries()) {
        // 時計が戻っても登録順で判定する。
        vi.setSystemTime(Date.UTC(2026, 7, 2, 0, 0, 10 - index));
        const response = await app.inject({
          method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/age-verifications`,
          headers: { "if-match": String(draft.version) },
          payload: { ...check, confirmerId: "staff-1", terminalId: "register-1" },
        });
        expect(response.statusCode).toBe(201);
        draft = response.json();
      }
    } finally {
      vi.useRealTimers();
    }
    const response = await finalize(app, draft, "latest-age-verification");
    expect(response.statusCode).toBe(status);
    if (status === 422) {
      expect(response.json().error).toMatchObject({ code: "AGE_VERIFICATION_REQUIRED", details: { minimumAge: 20 } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual({ count: 0 });
    }
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

  it("採番カウンターが既存取引に遅れていても、使用済み番号を飛ばして会計を確定する", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    let first = await startDraft(app, "register-reference-first"); first = await addLine(app, first); first = await addPayment(app, first, "credit", 110);
    expect((await finalize(app, first, "reference-first")).statusCode).toBe(201);
    db.prepare("UPDATE public_reference_counters SET next_sequence=1 WHERE event_id=? AND business_date=? AND session_no=?").run(catalog.eventId, "2026-08-02", 1);
    let duplicate = await startDraft(app, "register-reference-duplicate"); duplicate = await addLine(app, duplicate); duplicate = await addPayment(app, duplicate, "credit", 110);
    const response = await finalize(app, duplicate, "reference-duplicate");
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ publicReference: createPublicReference(1, 2) });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT next_sequence FROM public_reference_counters WHERE event_id=? AND business_date=? AND session_no=?").get(catalog.eventId, "2026-08-02", 1)).toMatchObject({ next_sequence: 3 });
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
    for (const table of ["transactions", "transaction_lines", "payments", "tax_summaries", "inventory_movements", "idempotency_records"]) expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM printer_operations").get()).toMatchObject({ count: 1 });
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
      app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(completed.version) }, payload: { productCode: "00000001" } }),
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

  it("DB再起動後も確定時の値引き・支払と顧客表示を復元する", async () => {
    const path = "./.checkout-reopen-test.sqlite";
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    const product = { ...catalog.products[0]!, priceInclTax: 100 };
    const originalCatalog = { ...catalog, products: [product, ...catalog.products.slice(1)] };
    const first = makeApp(openDatabase(path)); await installCatalog(first.app, originalCatalog);
    let draft = await addLine(first.app, await startDraft(first.app), "00000001", 2);
    draft = await addPayment(first.app, draft, "cash", 180, 500);
    const result = (await finalize(first.app, draft, "persist-key")).json();
    await installCatalog(first.app, { ...originalCatalog, autoDiscountRules: [] });
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    const reopened = makeApp(openDatabase(path));
    expect((await reopened.app.inject({ method: "GET", url: `/api/v1/transactions/${result.transactionId}` })).statusCode).toBe(200);
    expect((await reopened.app.inject({ method: "GET", url: "/api/v1/registers/register-1/sale-draft" })).json()).toMatchObject({
      state: "completed", completedTransactionId: result.transactionId, calculation: { totalYen: 180, discountTotalYen: 20 },
      payments: [{ kind: "cash", tenderedYen: 500, changeYen: 320 }],
    });
    expect((await reopened.app.inject({ method: "GET", url: "/api/v1/customer-displays/register-1" })).json()).toMatchObject({
      state: "completed", transactionId: result.transactionId, totals: { totalYen: 180, discountYen: 20 },
      payment: { state: "completed", kinds: ["cash"], tenderedYen: 500, changeYen: 320 },
    });
    await reopened.app.close(); apps.splice(apps.indexOf(reopened.app), 1);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  });

  it("keeps all artifact counts aligned at 60 sales per minute-equivalent burst", async () => {
    const { app, db } = makeApp(); await installCatalog(app);
    for (let index = 0; index < 60; index += 1) {
      let draft = await startDraft(app, `load-register-${index}`); draft = await addLine(app, draft); draft = await addPayment(app, draft, "cash", 110, 110);
      expect((await finalize(app, draft, `load-${index}`)).statusCode).toBe(201);
    }
    for (const table of ["transactions", "transaction_lines", "payments", "inventory_movements", "idempotency_records", "print_jobs", "printer_operations"]) {
      const filter = table === "print_jobs" ? " WHERE document_type='receipt'" : table === "printer_operations" ? " WHERE payload_ref IN (SELECT job_id FROM print_jobs WHERE document_type='receipt')" : "";
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}${filter}`).get()).toMatchObject({ count: 60 });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='drawer'").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE transaction_id IS NOT NULL").get()).toMatchObject({ count: 60 });
  });
});
