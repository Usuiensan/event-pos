import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

describe("責任者運用ダッシュボード", () => {
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
