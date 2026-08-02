import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { RealtimeHub } from "./realtime.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const catalog = {
  eventId: "realtime-event",
  products: [{ productCode: "00000001", name: "商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }],
  quickEntries: [],
};

async function setup(now = { value: Date.parse("2026-08-02T00:00:00.000Z") }) {
  const hub = new RealtimeHub(() => now.value, 5_000);
  const app = buildApp({ database: openDatabase(), realtimeHub: hub });
  apps.push(app);
  await app.ready();
  await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog });
  const draft = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: catalog.eventId, staffId: "staff-1", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
  return { app, hub, now, draft };
}

describe("顧客画面realtime境界", () => {
  it("heartbeat期限と音声の単一配送先をサーバーで決定する", async () => {
    const { app, now } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/v1/registers/register-1/customer-display-status" })).json()).toMatchObject({ available: false, heartbeatTtlMs: 5_000 });
    expect((await app.inject({ method: "POST", url: "/api/v1/customer-displays/customer-1/heartbeat", payload: { registerId: "register-1" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/registers/register-1/customer-display-status" })).json()).toMatchObject({ available: true, terminalId: "customer-1" });

    const customerAnnouncement = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/audio-announcements", payload: { text: "ひゃく えん" } });
    expect(customerAnnouncement.json()).toMatchObject({ targetRole: "customer", targetTerminalId: "customer-1" });
    const pending = await app.inject({ method: "GET", url: "/api/v1/customer-displays/customer-1/audio-announcements?registerId=register-1" });
    expect(pending.json().announcements).toHaveLength(1);
    const sequence = pending.json().announcements[0].sequence;
    await app.inject({ method: "POST", url: `/api/v1/customer-displays/customer-1/audio-announcements/${sequence}/ack` });
    expect((await app.inject({ method: "GET", url: "/api/v1/customer-displays/customer-1/audio-announcements?registerId=register-1" })).json().announcements).toEqual([]);

    now.value += 5_001;
    expect((await app.inject({ method: "GET", url: "/api/v1/registers/register-1/customer-display-status" })).json().available).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/v1/registers/register-1/audio-announcements", payload: { text: "レシートをお受け取りください" } })).json()).toMatchObject({ targetRole: "staff" });
  });

  it("3音量を独立保存し、年齢確認要求に個人情報を持たせない", async () => {
    const { app, draft } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/v1/registers/register-1/audio-settings" })).json()).toMatchObject({ tapVolume: 100, errorVolume: 100, speechVolume: 100, speakerId: 3, version: 0 });
    const saved = await app.inject({ method: "PUT", url: "/api/v1/registers/register-1/audio-settings", payload: { tapVolume: 12, errorVolume: 34, speechVolume: 56, speakerId: 114 } });
    expect(saved.json()).toMatchObject({ tapVolume: 12, errorVolume: 34, speechVolume: 56, speakerId: 114, version: 1 });
    expect((await app.inject({ method: "GET", url: "/api/v1/registers/register-1/audio-settings" })).json()).toMatchObject({ tapVolume: 12, errorVolume: 34, speechVolume: 56, speakerId: 114 });

    const requested = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/age-confirmation-requests", payload: { draftId: draft.draftId, minimumAge: 20 } });
    expect(requested.json()).toMatchObject({ minimumAge: 20, state: "requested" });
    expect(requested.body).not.toContain("birth");
    const acknowledged = await app.inject({ method: "POST", url: "/api/v1/customer-displays/customer-1/age-confirmations", payload: { registerId: "register-1", requestId: requested.json().requestId, response: "yes" } });
    expect(acknowledged.json()).toMatchObject({ state: "acknowledged" });
  });

  it("WebSocket本文を小さい通知に限定し、RESTへ再取得させる", async () => {
    const { app, draft } = await setup();
    const ws = await app.injectWS("/api/v1/events?registerId=register-1&terminalId=staff-1&role=staff");
    const notification = new Promise<Record<string, unknown>>((resolve) => ws.on("message", (data) => { const value = JSON.parse(data.toString()) as Record<string, unknown>; if (value.type === "sale-draft.changed") resolve(value); }));
    const changed = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(changed.statusCode).toBe(201);
    expect(await notification).toEqual({ type: "sale-draft.changed", registerId: "register-1", version: 2 });
    expect(changed.headers.etag).toBeUndefined();
    const refreshed = await app.inject({ method: "GET", url: `/api/v1/sale-drafts/${draft.draftId}` });
    expect(refreshed.headers.etag).toBe('"draft:' + draft.draftId + ':2"');
    expect(refreshed.json().lines).toHaveLength(1);
    ws.terminate();
  });

  it("顧客projection versionを新規draft後も単調増加させる", async () => {
    const { app, draft } = await setup();
    const first = (await app.inject({ method: "GET", url: "/api/v1/customer-displays/customer-1?registerId=register-1" })).json();
    await app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${draft.draftId}`, headers: { "if-match": String(draft.version) } });
    const next = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: catalog.eventId, staffId: "staff-1", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
    const second = (await app.inject({ method: "GET", url: "/api/v1/customer-displays/customer-1?registerId=register-1" })).json();
    expect(second.version).toBeGreaterThan(first.version);
    expect(second.draftId).toBe(next.draftId);
  });
});
