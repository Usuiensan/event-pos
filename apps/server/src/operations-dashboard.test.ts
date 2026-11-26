import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest, signInForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

describe("責任者運用ダッシュボード", () => {
  it("取り置き不足を期首在庫と移動台帳のremainingで判定する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    const catalog = { eventId: "dashboard-event", products: [{ productCode: "00000001", name: "予約商品", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", inventory: { openingQuantity: 10 } }], quickEntries: [], staffMembers: [] };
    await app.inject({ method: "PUT", url: "/api/v1/events/dashboard-event/catalog", payload: catalog });
    await openRegisterForTest(app, catalog.eventId, "2026-08-03", "register-1");
    const hold = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", lines: [{ productCode: "00000001", quantity: 1 }] } });
    expect(hold.statusCode).toBe(201);
    db.prepare("UPDATE inventory_balances SET on_hand=0 WHERE event_id=? AND product_id=?").run(catalog.eventId, "dashboard-event:00000001");
    const response = await app.inject({ method: "GET", url: "/api/v1/operations/dashboard?eventId=dashboard-event&businessDate=2026-08-03", headers: { "x-pos-role": "manager", "x-pos-actor-id": "002" } });
    expect(response.statusCode).toBe(200); expect(response.json().holds.confirmationRequired).toEqual([]);
  });

  it("在庫ちょうど全量の取り置きは不足にせず、引当超過で不足にする", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    const catalog = { eventId: "dashboard-full-event", products: [{ productCode: "00000001", name: "予約商品", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", inventory: { openingQuantity: 10 } }], quickEntries: [], staffMembers: [] };
    await app.inject({ method: "PUT", url: "/api/v1/events/dashboard-full-event/catalog", payload: catalog });
    await openRegisterForTest(app, catalog.eventId, "2026-08-03", "register-1");
    const full = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", lines: [{ productCode: "00000001", quantity: 10 }] } });
    expect(full.statusCode).toBe(201);
    const headers = { "x-pos-role": "manager", "x-pos-actor-id": "002" };
    const okResponse = await app.inject({ method: "GET", url: "/api/v1/operations/dashboard?eventId=dashboard-full-event&businessDate=2026-08-03", headers });
    expect(okResponse.statusCode).toBe(200); expect(okResponse.json().holds.confirmationRequired).toEqual([]);
    const over = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", allowShortage: true, lines: [{ productCode: "00000001", quantity: 1 }] } });
    expect(over.statusCode).toBe(201);
    const overResponse = await app.inject({ method: "GET", url: "/api/v1/operations/dashboard?eventId=dashboard-full-event&businessDate=2026-08-03", headers });
    expect(overResponse.statusCode).toBe(200); expect(overResponse.json().holds.confirmationRequired.length).toBeGreaterThan(0);
  });

  it("権限を要求し、DB・印刷・容量・現金・端末を一括取得する", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app); await app.ready();
    expect((await app.inject({ method: "GET", url: "/api/v1/operations/dashboard?eventId=e1&businessDate=2026-08-03" })).statusCode).toBe(401);
    await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "e1", staffId: "001", terminalId: "register-1", businessDate: "2026-08-03" } });
    const ws = await app.injectWS("/api/v1/events?registerId=register-1&terminalId=register-1&role=staff");
    const response = await app.inject({ method: "GET", url: "/api/v1/operations/dashboard?eventId=e1&businessDate=2026-08-03", headers: { "x-pos-role": "manager", "x-pos-actor-id": "001" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ database: { state: "ready" }, printerHost: { connected: null }, printJobs: { pending: 0, failed: 0, unknown: 0, lastSuccessfulAt: null }, storage: { database: { state: "unknown" }, artifacts: { state: "unknown" } }, lastBackup: null, registers: [{ registerId: "register-1", connected: true, terminalId: "register-1", customerDisplay: { available: false } }] });
    ws.terminate();
  });
  it("認証必須時は偽ヘッダーを拒否し、managerセッションだけを通す（F-069）", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true }); apps.push(app);
    const catalog = { eventId: "dashboard-auth-event", products: [], quickEntries: [], staffMembers: [{ responsibleNumber: "001", displayName: "管理者", role: "admin" }, { responsibleNumber: "002", displayName: "責任者", role: "manager" }] };
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/dashboard-auth-event/catalog", payload: catalog })).statusCode).toBe(200);
    const url = "/api/v1/operations/dashboard?eventId=dashboard-auth-event&businessDate=2026-08-03";
    expect((await app.inject({ method: "GET", url, headers: { "x-pos-role": "manager", "x-pos-actor-id": "002" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const manager = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "002", terminalId: "register-1" });
    const ok = await app.inject({ method: "GET", url, headers: manager });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("翌営業へ繰り越した取り置きは、繰越先の当日一覧に閉局阻害として出る（F-039）", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    const catalog = { eventId: "dashboard-carry-event", products: [{ productCode: "00000001", name: "予約商品", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], quickEntries: [], staffMembers: [{ responsibleNumber: "001", displayName: "担当", role: "operator" }, { responsibleNumber: "002", displayName: "責任者", role: "manager" }] };
    await app.inject({ method: "PUT", url: "/api/v1/events/dashboard-carry-event/catalog", payload: catalog });
    await openRegisterForTest(app, catalog.eventId, "2026-08-03", "register-1");
    const headers = { "x-pos-role": "manager", "x-pos-actor-id": "002" };
    const dashboard = async (date: string) => (await app.inject({ method: "GET", url: `/api/v1/operations/dashboard?eventId=${catalog.eventId}&businessDate=${date}`, headers })).json();
    const blockerIds = async (date: string) => (await dashboard(date)).holds.closingBlockers.map((item: { holdId: string }) => item.holdId);
    const hold = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", lines: [{ productCode: "00000001", quantity: 1 }] } });
    expect(hold.statusCode).toBe(201);
    expect(await blockerIds("2026-08-03")).toContain(hold.json().holdId);
    const requested = await app.inject({ method: "POST", url: `/api/v1/holds/${hold.json().holdId}/carry-request`, payload: { terminalId: "register-1" } });
    expect(requested.statusCode).toBe(200);
    const oldBusiness = (await app.inject({ method: "GET", url: `/api/v1/business-sessions/current?eventId=${catalog.eventId}` })).json().session.businessSessionId;
    db.prepare("UPDATE business_sessions SET state='closed' WHERE business_session_id=?").run(oldBusiness);
    const next = await app.inject({ method: "POST", url: "/api/v1/business-sessions", payload: { eventId: catalog.eventId, businessDate: "2026-08-04", terminalId: "register-1" } });
    expect(next.statusCode).toBe(201);
    const carried = await app.inject({ method: "POST", url: `/api/v1/holds/${hold.json().holdId}/carry`, payload: { businessSessionId: next.json().businessSessionId, terminalId: "register-1" } });
    expect(carried.statusCode).toBe(200);
    expect(await blockerIds("2026-08-04")).toContain(hold.json().holdId);
    expect(await blockerIds("2026-08-03")).not.toContain(hold.json().holdId);
    const close = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${next.json().businessSessionId}/close`, payload: { terminalId: "register-1" } });
    expect(close.statusCode).toBe(409); expect(close.json().error.code).toBe("ACTIVE_HOLDS_EXIST");
  });

  it("受取直後と保留中は閉局阻害一覧に表示し、受取会計の確定後に消す（F-054）", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const eventId = "dashboard-pickup";
    const businessDate = "2026-08-03";
    const registerId = "register-1";
    const productCode = "00000001";
    const saved = await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: {
      eventId, products: [{ productCode, name: "予約商品", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], quickEntries: [], staffMembers: [],
    } });
    expect(saved.statusCode).toBe(200);
    await openRegisterForTest(app, eventId, businessDate, registerId);
    const hold = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId, registerId, terminalId: registerId, lines: [{ productCode, quantity: 1 }] } });
    expect(hold.statusCode).toBe(201);
    const { holdId } = hold.json();
    const started = await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId, businessDate, terminalId: registerId, staffId: "002" } });
    expect(started.statusCode).toBe(201);
    const { draftId, version } = started.json();
    const claimed = await app.inject({ method: "POST", url: `/api/v1/holds/${holdId}/claim`, payload: { draftId, version } });
    expect(claimed.statusCode).toBe(200);
    const closingBlockers = async (date = businessDate) => {
      const response = await app.inject({ url: `/api/v1/operations/dashboard?eventId=${eventId}&businessDate=${date}`, headers: { "x-pos-role": "manager", "x-pos-actor-id": "002" } });
      expect(response.statusCode).toBe(200);
      return response.json().holds.closingBlockers;
    };
    expect(await closingBlockers()).toMatchObject([{ holdId, state: "claimed" }]);
    expect(await closingBlockers("2026-08-04")).toEqual([]);

    const draftUrl = `/api/v1/sale-drafts/${draftId}`;
    const parked = await app.inject({ method: "POST", url: `${draftUrl}/park`, payload: { terminalId: registerId } });
    expect(parked.statusCode).toBe(201);
    expect(await closingBlockers()).toMatchObject([{ holdId, state: "claimed" }]);

    const resumed = await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/parked-drafts/resume`, payload: { parkReference: parked.json().parkReference, terminalId: registerId } });
    expect(resumed.statusCode).toBe(200);
    const paid = await app.inject({ method: "POST", url: `${draftUrl}/payments`, headers: { "if-match": String(resumed.json().version) }, payload: { kind: "credit" } });
    expect(paid.statusCode).toBe(201);
    expect(await closingBlockers()).toMatchObject([{ holdId, state: "claimed" }]);
    const finalized = await app.inject({ method: "POST", url: `${draftUrl}/finalize`, headers: { "idempotency-key": "dashboard-pickup-finalize" }, payload: { version: paid.json().version } });
    expect(finalized.statusCode).toBe(201);
    expect(await closingBlockers()).toEqual([]);
  });

  it("同じ現金箱の点検を営業ごとの現金セッションに紐づける（F-055）", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const eventId = "dashboard-cash";
    const businessDate = "2026-08-03";
    const registerId = "register-1";
    const saved = await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: { eventId, products: [], quickEntries: [], staffMembers: [] } });
    expect(saved.statusCode).toBe(200);
    const firstId = await openRegisterForTest(app, eventId, businessDate, registerId);
    const current = await app.inject({ url: `/api/v1/business-sessions/current?eventId=${eventId}` });
    expect(current.statusCode).toBe(200);
    const { businessSessionId } = current.json().session;
    for (const kind of ["interim", "closing"]) {
      const result = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${firstId}/checks/${kind}`, payload: { counted: [], terminalId: registerId } });
      expect(result.statusCode).toBe(201);
    }
    const closed = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${businessSessionId}/close`, payload: { terminalId: registerId } });
    expect(closed.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/api/v1/business-sessions", payload: { eventId, businessDate, terminalId: registerId } });
    expect(second.statusCode).toBe(201);
    expect(second.json().sessionNo).toBe(2);
    const prepared = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${second.json().businessSessionId}/registers/${registerId}/prepare`, payload: { terminalId: registerId } });
    expect(prepared.statusCode).toBe(201);
    const secondId = prepared.json().sessionId;

    const cashStatus = async () => {
      const response = await app.inject({ url: `/api/v1/operations/dashboard?eventId=${eventId}&businessDate=${businessDate}`, headers: { "x-pos-role": "manager", "x-pos-actor-id": "002" } });
      expect(response.statusCode).toBe(200);
      return response.json().cash;
    };
    const before = await cashStatus();
    expect(before.sessions).toHaveLength(2);
    expect(before.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: firstId, cashboxId: registerId, state: "closed" }),
      expect.objectContaining({ sessionId: secondId, cashboxId: registerId, state: "preparing" }),
    ]));
    expect(before.checks.map(({ sessionId, kind }: { sessionId: string; kind: string }) => `${sessionId}:${kind}`).sort()).toEqual([`${firstId}:closing`, `${firstId}:interim`, `${firstId}:opening`]);

    const opened = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${secondId}/checks/opening`, payload: { counted: [], terminalId: registerId } });
    expect(opened.statusCode).toBe(201);
    const after = await cashStatus();
    expect(after.sessions).toEqual(before.sessions.map((session: { sessionId: string }) => session.sessionId === secondId ? { ...session, state: "open", openingYen: 0 } : session));
    expect(after.checks).toHaveLength(before.checks.length + 1);
    expect(after.checks).toEqual(expect.arrayContaining([...before.checks, expect.objectContaining({ sessionId: secondId, kind: "opening" })]));
  });
});
