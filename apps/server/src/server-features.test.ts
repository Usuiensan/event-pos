import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
const catalog = { eventId: "feature-event", event: { name: "機能試験イベント", businessDate: "2026-08-02", seller: { circleName: "試験サークル", space: "A01", receiptIssuerName: "試験" }, locale: { language: "ja", currency: "JPY", timezone: "Asia/Tokyo" } }, products: [
  { productCode: "00000001", name: "在庫商品", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", inventory: { openingQuantity: 5 } },
  { productCode: "00000002", name: "無管理商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", inventory: { openingQuantity: null } },
], quickEntries: [], staffMembers: [{ responsibleNumber: "001", displayName: "試験管理者", role: "admin" }] };

async function setup(): Promise<{ app: FastifyInstance; db: ReturnType<typeof openDatabase> }> {
  const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
  expect((await app.inject({ method: "PUT", url: "/api/v1/events/feature-event/catalog", payload: catalog })).statusCode).toBe(200);
  await openRegisterForTest(app, "feature-event", "2026-08-02", "register-1");
  return { app, db };
}

describe("在庫残数・領収書・会計保留", () => {
  it("openingQuantityと移動・予約を集計し、未管理商品をnullで返す", async () => {
    const { app, db } = await setup();
    const draft = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "feature-event", staffId: "001", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
    const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    const saleDraft = line.json(); const paid = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(saleDraft.version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 110 } });
    expect((await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "feature-sale" }, payload: { version: paid.json().version } })).statusCode).toBe(201);
    const inventory = (await app.inject({ method: "GET", url: "/api/v1/events/feature-event/inventory" })).json();
    expect(inventory.products).toContainEqual({ productCode: "00000001", tracked: true, openingQuantity: 5, remaining: 4, reserved: 0, available: 4 });
    expect(inventory.products).toContainEqual({ productCode: "00000002", tracked: false, openingQuantity: null, remaining: null, reserved: null, available: null });
    db.prepare("UPDATE inventory_balances SET reserved=1 WHERE event_id=? AND product_id=?").run("feature-event", "feature-event:00000001");
    expect((await app.inject({ method: "GET", url: "/api/v1/events/feature-event/inventory" })).json().products).toContainEqual(expect.objectContaining({ productCode: "00000001", available: 3 }));
  });

  it("保留中は変更できず、番号で呼び戻せる", async () => {
    const { app } = await setup();
    let draft = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "feature-event", staffId: "001", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
    const empty = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/park`, payload: { terminalId: "register-1" } }); expect(empty.statusCode).toBe(400); expect(empty.json().error.code).toBe("PARK_EMPTY");
    const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } }); draft = line.json();
    const parked = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/park`, payload: { terminalId: "register-1" } }); expect(parked.statusCode).toBe(201);
    const parkedJson = parked.json(); expect((await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(parkedJson.version ?? 2) }, payload: { productCode: "00000001" } })).statusCode).toBe(409);
    const fresh = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "feature-event", staffId: "001", terminalId: "register-1", businessDate: "2026-08-02" } }); expect(fresh.statusCode).toBe(201); expect(fresh.json().draftId).not.toBe(draft.draftId);
    const freshLine = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${fresh.json().draftId}/lines`, headers: { "if-match": String(fresh.json().version) }, payload: { productCode: "00000001" } });
    expect((await app.inject({ method: "POST", url: "/api/v1/registers/register-1/parked-drafts/resume", payload: { parkReference: parkedJson.parkReference, terminalId: "register-1" } })).json().error.code).toBe("PARK_RESUME_BLOCKED");
    await app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${fresh.json().draftId}`, headers: { "if-match": String(freshLine.json().version) } });
    const resumed = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/parked-drafts/resume", payload: { parkReference: parkedJson.parkReference, terminalId: "register-1" } }); expect(resumed.statusCode).toBe(200); expect(resumed.json().draftId).toBe(draft.draftId); expect(resumed.json().lines).toHaveLength(1);
  });

  it("確定売上だけ領収書を発行し、再発行を追記する", async () => {
    const { app, db } = await setup();
    let draft = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "feature-event", staffId: "001", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
    const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } }); draft = line.json();
    const payment = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(draft.version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 110 } });
    const sale = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "receipt-sale" }, payload: { version: payment.json().version } });
    const input = { payeeName: "山田", memo: "商品代", terminalId: "register-1" };
    const first = await app.inject({ method: "POST", url: `/api/v1/transactions/${sale.json().transactionId}/official-receipts`, payload: input }); expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: `/api/v1/transactions/${sale.json().transactionId}/official-receipts`, payload: input }); expect(second.statusCode).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS count FROM official_receipts WHERE transaction_id=?").get(sale.json().transactionId)).toEqual({ count: 2 });
    expect(db.prepare("SELECT document_type FROM print_jobs WHERE job_id=?").get(first.json().printJobId)).toEqual({ document_type: "official_receipt" });
    expect(db.prepare("SELECT canonical_ir FROM print_jobs WHERE job_id=?").get(second.json().printJobId)).toMatchObject({ canonical_ir: expect.stringContaining("再発行") });
    expect((await app.inject({ method: "POST", url: "/api/v1/transactions/not-found/official-receipts", payload: input })).statusCode).toBe(404);
  });
});
