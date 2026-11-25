import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest } from "./test-support.js";

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
});
