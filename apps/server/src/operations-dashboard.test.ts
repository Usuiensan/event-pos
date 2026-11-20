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
});
