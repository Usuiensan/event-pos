import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { SaleDraftDto } from "./checkout-store.js";
import { openDatabase } from "./db.js";
import { RealtimeHub } from "./realtime.js";
import { openRegisterForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
const catalog = { eventId: "feature-event", event: { name: "機能試験イベント", businessDate: "2026-08-02", seller: { circleName: "試験サークル", space: "A01", receiptIssuerName: "試験" }, locale: { language: "ja", currency: "JPY", timezone: "Asia/Tokyo" } }, products: [
  { productCode: "00000001", name: "在庫商品", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", inventory: { openingQuantity: 5 } },
  { productCode: "00000002", name: "無管理商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", inventory: { openingQuantity: null } },
], quickEntries: [], staffMembers: [{ responsibleNumber: "001", displayName: "試験管理者", role: "admin" }] };

async function setup(realtimeHub?: RealtimeHub): Promise<{ app: FastifyInstance; db: ReturnType<typeof openDatabase> }> {
  const db = openDatabase(); const app = buildApp({ database: db, ...(realtimeHub ? { realtimeHub } : {}) }); apps.push(app);
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
    expect((await app.inject({ method: "POST", url: "/api/v1/registers/register-1/parked-drafts/resume", payload: { parkReference: parkedJson.parkReference, terminalId: "register-1", eventId: "feature-event" } })).json().error.code).toBe("PARK_RESUME_BLOCKED");
    await app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${fresh.json().draftId}`, headers: { "if-match": String(freshLine.json().version) } });
    const resumed = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/parked-drafts/resume", payload: { parkReference: parkedJson.parkReference, terminalId: "register-1", eventId: "feature-event" } }); expect(resumed.statusCode).toBe(200); expect(resumed.json().draftId).toBe(draft.draftId); expect(resumed.json().lines).toHaveLength(1);
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
    const canonicalIr = String((db.prepare("SELECT canonical_ir FROM print_jobs WHERE job_id=?").get(second.json().printJobId) as { canonical_ir: string }).canonical_ir);
    expect(canonicalIr).toContain("再発行");
    expect(canonicalIr).toContain('!text "宛名"');
    expect(canonicalIr).toContain('!text "但し"');
    expect(canonicalIr).toContain('!text "発行者 試験サークル"');
    expect(canonicalIr.indexOf('!text "宛名"')).toBeLessThan(canonicalIr.indexOf("!feed 3"));
    expect(canonicalIr.indexOf("!feed 3")).toBeLessThan(canonicalIr.indexOf('!rule "single"'));
    expect(canonicalIr.indexOf('!text "但し"')).toBeLessThan(canonicalIr.lastIndexOf("!feed 2"));
    expect(canonicalIr).toContain('!row {"left":"在庫商品","right":"1点 ¥110"}');
    expect(canonicalIr).toContain('!row {"left":"合計","right":"¥110"}');
    expect(canonicalIr).toContain("!feed 6");
    expect(canonicalIr).not.toContain("山田");
    expect(canonicalIr).not.toContain("商品代");
    expect((await app.inject({ method: "POST", url: "/api/v1/transactions/not-found/official-receipts", payload: input })).statusCode).toBe(404);
  });
});

describe("保留・呼戻しと顧客画面", () => {
  const registerId = "register-1";
  const displayUrl = `/api/v1/customer-displays/customer-1?registerId=${registerId}`;
  const startDraft = (app: FastifyInstance) => app.inject({
    method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`,
    payload: { eventId: catalog.eventId, staffId: "001", terminalId: registerId, businessDate: catalog.event.businessDate },
  });

  async function setupDraftWithLine() {
    const hub = new RealtimeHub();
    const { app } = await setup(hub);
    const started = await startDraft(app);
    expect(started.statusCode).toBe(201);
    const draft = started.json<SaleDraftDto>();
    const added = await app.inject({
      method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`,
      headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" },
    });
    expect(added.statusCode).toBe(201);
    return { app, draft: added.json<SaleDraftDto>(), notify: vi.spyOn(hub, "notify") };
  }

  it("保留すると顧客画面の状態とバージョンを更新して通知する", async () => {
    const { app, draft, notify } = await setupDraftWithLine();
    const before = (await app.inject(displayUrl)).json();
    const parked = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/park`, payload: { terminalId: registerId } });
    expect(parked.statusCode).toBe(201);

    const after = (await app.inject(displayUrl)).json();
    expect(after).toMatchObject({ draftId: draft.draftId, state: "parked", draftVersion: draft.version + 1 });
    expect(after.version).toBeGreaterThan(before.version);
    expect(notify.mock.calls).toEqual([
      [{ type: "sale-draft.changed", registerId, version: after.draftVersion }],
      [{ type: "customer-display.changed", registerId, version: after.version }],
    ]);
  });

  it("空の会計から呼び戻すと顧客画面に復元した明細と合計を表示して通知する", async () => {
    const { app, draft, notify } = await setupDraftWithLine();
    const parked = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/park`, payload: { terminalId: registerId } });
    expect(parked.statusCode).toBe(201);
    const empty = await startDraft(app);
    expect(empty.statusCode).toBe(201);
    const before = (await app.inject(displayUrl)).json();
    expect(before).toMatchObject({ draftId: empty.json<SaleDraftDto>().draftId, lines: [], totals: { totalYen: 0 } });

    notify.mockClear();
    const resumed = await app.inject({
      method: "POST", url: `/api/v1/registers/${registerId}/parked-drafts/resume`,
      payload: { parkReference: parked.json<{ parkReference: string }>().parkReference, terminalId: registerId, eventId: catalog.eventId },
    });
    expect(resumed.statusCode).toBe(200);
    const restored = resumed.json<SaleDraftDto>();
    expect(restored.draftId).toBe(draft.draftId);

    const after = (await app.inject(displayUrl)).json();
    expect(after).toMatchObject({
      draftId: restored.draftId, draftVersion: restored.version, state: "editing",
      lines: draft.lines.map(({ lineId, productCode, quantity }) => ({ lineId, productCode, quantity })),
      totals: { totalYen: draft.calculation.totalYen },
    });
    expect(after.version).toBeGreaterThan(before.version);
    expect(notify.mock.calls).toEqual([
      [{ type: "sale-draft.changed", registerId, version: restored.version }],
      [{ type: "customer-display.changed", registerId, version: after.version }],
    ]);
  });
});

describe("在庫調整", () => {
  const adjust = (app: FastifyInstance, payload: Record<string, unknown>, headers?: Record<string, string>) => {
    const options: { method: "POST"; url: string; headers?: Record<string, string>; payload: Record<string, unknown> } = { method: "POST", url: "/api/v1/events/feature-event/inventory/adjustments", payload };
    if (headers) options.headers = headers;
    return app.inject(options);
  };

  async function sellOne(app: FastifyInstance): Promise<void> {
    const draft = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "feature-event", staffId: "001", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
    const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    const paid = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(line.json().version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 110 } });
    expect((await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "adjust-sale" }, payload: { version: paid.json().version } })).statusCode).toBe(201);
  }

  it("販売で減った後に目標数へ調整するとremainingが目標数になる", async () => {
    const { app, db } = await setup();
    await sellOne(app);
    const response = await adjust(app, { productCode: "00000001", newOnHand: 7, reason: "棚卸しで実在庫が多かった" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ productCode: "00000001", tracked: true, openingQuantity: 5, remaining: 7, reserved: 0, available: 7 });
    const inventory = (await app.inject({ method: "GET", url: "/api/v1/events/feature-event/inventory" })).json();
    expect(inventory.products).toContainEqual(expect.objectContaining({ productCode: "00000001", remaining: 7 }));
    expect(db.prepare("SELECT type,quantity_delta,transaction_line_id FROM inventory_movements WHERE type='adjustment'").get()).toEqual({ type: "adjustment", quantity_delta: 3, transaction_line_id: null });
    // F-031 修正後は on_hand も期首＋移動合計（＝remaining）と一致する（旧期待値2は on_hand が0始まりだった頃の値）
    expect(db.prepare("SELECT on_hand FROM inventory_balances WHERE event_id=? AND product_id=?").get("feature-event", "feature-event:00000001")).toEqual({ on_hand: 7 });
  });

  it("期首3を5に訂正してから4に調整しても在庫投影とAPIの残数が一致する", async () => {
    const db = openDatabase();
    const app = buildApp({ database: db });
    apps.push(app);
    const url = "/api/v1/events/feature-event/catalog";
    const initialCatalog = { ...catalog, products: catalog.products.map((product) =>
      product.productCode === "00000001" ? { ...product, inventory: { openingQuantity: 3 } } : product) };
    const balance = () => db.prepare("SELECT on_hand, version FROM inventory_balances WHERE event_id=? AND product_id=?").get("feature-event", "feature-event:00000001");
    const inventory = async () => {
      const response = await app.inject("/api/v1/events/feature-event/inventory");
      expect(response.statusCode).toBe(200);
      return response.json().products;
    };

    expect((await app.inject({ method: "PUT", url, payload: initialCatalog })).statusCode).toBe(200);
    expect(balance()).toEqual({ on_hand: 3, version: 1 });
    expect((await app.inject({ method: "PUT", url, payload: catalog })).statusCode).toBe(200);
    expect(await inventory()).toContainEqual(expect.objectContaining({ productCode: "00000001", openingQuantity: 5, remaining: 5 }));
    expect(balance()).toEqual({ on_hand: 5, version: 2 });

    const adjusted = await adjust(app, { productCode: "00000001", newOnHand: 4, reason: "棚卸し" });
    expect(adjusted.statusCode).toBe(200);
    expect(adjusted.json()).toMatchObject({ remaining: 4 });
    expect(await inventory()).toContainEqual(expect.objectContaining({ productCode: "00000001", openingQuantity: 5, remaining: 4 }));
    expect(balance()).toEqual({ on_hand: 4, version: 3 });
    expect(db.prepare("SELECT type, quantity_delta FROM inventory_movements").all()).toEqual([{ type: "adjustment", quantity_delta: -1 }]);
  });

  it("再取込で販売の移動と引当を引き継ぎ、同じ期首の再取込で重複させない", async () => {
    const { app, db } = await setup();
    await sellOne(app);
    const hold = await app.inject({ method: "POST", url: "/api/v1/holds", payload: {
      eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", lines: [{ productCode: "00000001", quantity: 2 }],
    } });
    expect(hold.statusCode).toBe(201);
    const balance = () => db.prepare("SELECT on_hand, reserved, version FROM inventory_balances WHERE event_id=? AND product_id=?").get("feature-event", "feature-event:00000001");
    const movements = () => db.prepare("SELECT inventory_movement_id, type, quantity_delta FROM inventory_movements").all();
    const holdLines = () => db.prepare("SELECT hold_id, product_code, quantity FROM hold_lines").all();
    const existingMovements = movements();
    const existingHoldLines = holdLines();
    expect(existingMovements).toEqual([{ inventory_movement_id: expect.any(String), type: "sale", quantity_delta: -1 }]);
    expect(existingHoldLines).toEqual([{ hold_id: hold.json().holdId, product_code: "00000001", quantity: 2 }]);
    expect(balance()).toEqual({ on_hand: 4, reserved: 2, version: 3 });

    const correctedCatalog = { ...catalog, products: catalog.products.map((product) =>
      product.productCode === "00000001" ? { ...product, inventory: { openingQuantity: 7 } } : product) };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await app.inject({ method: "PUT", url: "/api/v1/events/feature-event/catalog", payload: correctedCatalog })).statusCode).toBe(200);
      const inventory = await app.inject("/api/v1/events/feature-event/inventory");
      expect(inventory.statusCode).toBe(200);
      expect(inventory.json().products).toContainEqual({ productCode: "00000001", tracked: true, openingQuantity: 7, remaining: 6, reserved: 2, available: 4 });
      expect(balance()).toEqual({ on_hand: 6, reserved: 2, version: 4 });
      expect(movements()).toEqual(existingMovements);
      expect(holdLines()).toEqual(existingHoldLines);
    }
  });

  it("未追跡商品は400 INVENTORY_NOT_TRACKED", async () => {
    const { app } = await setup();
    const response = await adjust(app, { productCode: "00000002", newOnHand: 3, reason: "棚卸し" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVENTORY_NOT_TRACKED");
  });

  it("負数・非整数は400", async () => {
    const { app } = await setup();
    expect((await adjust(app, { productCode: "00000001", newOnHand: -1, reason: "棚卸し" })).statusCode).toBe(400);
    expect((await adjust(app, { productCode: "00000001", newOnHand: 2.5, reason: "棚卸し" })).statusCode).toBe(400);
  });

  it("理由なしは400", async () => {
    const { app } = await setup();
    expect((await adjust(app, { productCode: "00000001", newOnHand: 3 })).statusCode).toBe(400);
    expect((await adjust(app, { productCode: "00000001", newOnHand: 3, reason: " " })).statusCode).toBe(400);
  });

  it("audit_logに調整内容が記録される", async () => {
    const { app, db } = await setup();
    expect((await adjust(app, { productCode: "00000001", newOnHand: 8, reason: "棚卸し" })).statusCode).toBe(200);
    const row = db.prepare("SELECT action,detail_json FROM audit_log WHERE action='inventory_adjustment'").get() as { action: string; detail_json: string };
    expect(JSON.parse(row.detail_json)).toMatchObject({ productCode: "00000001", before: 5, after: 8, delta: 3, reason: "棚卸し" });
  });

  it("reservedは不変でavailableが連動する", async () => {
    const { app, db } = await setup();
    db.prepare("UPDATE inventory_balances SET reserved=1 WHERE event_id=? AND product_id=?").run("feature-event", "feature-event:00000001");
    const response = await adjust(app, { productCode: "00000001", newOnHand: 6, reason: "棚卸し" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ remaining: 6, reserved: 1, available: 5 });
    const inventory = (await app.inject({ method: "GET", url: "/api/v1/events/feature-event/inventory" })).json();
    expect(inventory.products).toContainEqual(expect.objectContaining({ productCode: "00000001", remaining: 6, reserved: 1, available: 5 }));
  });

  it("operator権限では403（manager必須）", async () => {
    const { app } = await setup();
    const response = await adjust(app, { productCode: "00000001", newOnHand: 3, reason: "棚卸し" }, { "x-pos-role": "operator" });
    expect(response.statusCode).toBe(403);
  });

  it("delta=0ではmovementを作らない", async () => {
    const { app, db } = await setup();
    const response = await adjust(app, { productCode: "00000001", newOnHand: 5, reason: "棚卸しで一致" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ remaining: 5 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_movements WHERE type='adjustment'").get()).toEqual({ count: 0 });
  });
});

describe("長い商品名の保留票（F-061）", () => {
  it("全角16文字の商品名でも保留できる", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    const longCatalog = { eventId: "longname-feature-event", event: { name: "長名イベント", businessDate: "2026-08-02", seller: { circleName: "試験サークル", space: "A01", receiptIssuerName: "試験" }, locale: { language: "ja", currency: "JPY", timezone: "Asia/Tokyo" } }, products: [{ productCode: "00000001", name: "あいうえおかきくけこさしすせそた", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], quickEntries: [], staffMembers: [{ responsibleNumber: "001", displayName: "試験管理者", role: "admin" }] };
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/longname-feature-event/catalog", payload: longCatalog })).statusCode).toBe(200);
    await openRegisterForTest(app, "longname-feature-event", "2026-08-02", "register-1");
    const draft = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "longname-feature-event", staffId: "001", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
    const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(line.statusCode).toBe(201);
    const parked = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/park`, payload: { terminalId: "register-1" } });
    expect(parked.statusCode).toBe(201);
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='park_ticket'").get()).toEqual({ count: 1 });
  });
});
