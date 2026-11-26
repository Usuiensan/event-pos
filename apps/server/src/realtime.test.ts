import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { RealtimeHub } from "./realtime.js";
import { openRegisterForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const catalog = {
  eventId: "realtime-event",
  products: [{ productCode: "00000001", name: "商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }],
  quickEntries: [],
  staffMembers: [{ responsibleNumber: "001", displayName: "試験管理者", role: "admin" }],
};

async function setup(now = { value: Date.parse("2026-08-02T00:00:00.000Z") }) {
  const hub = new RealtimeHub(() => now.value, 5_000);
  const app = buildApp({ database: openDatabase(), realtimeHub: hub });
  apps.push(app);
  await app.ready();
  await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog });
  await openRegisterForTest(app, catalog.eventId, "2026-08-02", "register-1");
  const draft = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: catalog.eventId, staffId: "staff-1", terminalId: "register-1", businessDate: "2026-08-02" } })).json();
  return { app, hub, now, draft };
}

describe("顧客画面realtime境界", () => {
  it("draft未作成でも顧客画面は空のprojectionを返す", async () => {
    const app = buildApp({ database: openDatabase() });
    apps.push(app);
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/api/v1/customer-displays/customer-1?registerId=register-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ registerId: "register-1", version: 0, lines: [], totals: { totalYen: 0 }, payment: { state: "waiting", kinds: [] } });
  });

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

  it("4音量を独立保存し、年齢確認要求に個人情報を持たせない", async () => {
    const { app, draft } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/v1/registers/register-1/audio-settings" })).json()).toMatchObject({ tapVolume: 100, errorVolume: 100, systemErrorVolume: 100, speechVolume: 100, speakerId: 3, version: 0 });
    const saved = await app.inject({ method: "PUT", url: "/api/v1/registers/register-1/audio-settings", payload: { tapVolume: 12, errorVolume: 34, systemErrorVolume: 45, speechVolume: 56, speakerId: 114 } });
    expect(saved.json()).toMatchObject({ tapVolume: 12, errorVolume: 34, systemErrorVolume: 45, speechVolume: 56, speakerId: 114, version: 1 });
    expect((await app.inject({ method: "GET", url: "/api/v1/registers/register-1/audio-settings" })).json()).toMatchObject({ tapVolume: 12, errorVolume: 34, systemErrorVolume: 45, speechVolume: 56, speakerId: 114 });

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

  it("登録中止した会計の顧客projectionは空になる（F-040）", async () => {
    const { app, draft } = await setup();
    const added = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(added.statusCode).toBe(201);
    const before = (await app.inject({ method: "GET", url: "/api/v1/customer-displays/customer-1?registerId=register-1" })).json();
    expect(before.lines).toHaveLength(1);
    expect(before.totals.totalYen).toBe(100);
    const canceled = await app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${draft.draftId}`, headers: { "if-match": String(added.json().version) } });
    expect(canceled.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/v1/customer-displays/customer-1?registerId=register-1" })).json();
    expect(after).toMatchObject({ draftId: draft.draftId, state: "canceled", lines: [], discounts: [], totals: { subtotalYen: 0, discountYen: 0, taxYen: 0, totalYen: 0 }, payment: { state: "waiting", kinds: [] } });
    expect(after.version).toBeGreaterThan(before.version);
    // 中止した下書き自体の明細は残る（空になるのは顧客画面への射影だけ）
    const kept = (await app.inject({ method: "GET", url: `/api/v1/sale-drafts/${draft.draftId}` })).json();
    expect(kept.state).toBe("canceled");
    expect(kept.lines.filter((line: { status: string }) => line.status === "active")).toHaveLength(1);
  });

  it.each(["requested", "acknowledged"])("登録中止だけで顧客projectionを空にし、年齢確認要求（%s）を取り消す（F-056）", async (state) => {
    const { app, draft } = await setup();
    const draftUrl = `/api/v1/sale-drafts/${draft.draftId}`;
    const registerUrl = "/api/v1/registers/register-1";
    const statusUrl = `${registerUrl}/customer-display-status`;
    const added = await app.inject({ method: "POST", url: `${draftUrl}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(added.statusCode).toBe(201);
    const requested = await app.inject({ method: "POST", url: `${registerUrl}/age-confirmation-requests`, payload: { draftId: draft.draftId, minimumAge: 18 } });
    expect(requested.statusCode).toBe(201);
    const { requestId } = requested.json();
    const answerYes = () => app.inject({ method: "POST", url: "/api/v1/customer-displays/customer-1/age-confirmations", payload: { registerId: "register-1", requestId, response: "yes" } });
    if (state === "acknowledged") expect((await answerYes()).statusCode).toBe(201);
    const before = (await app.inject(statusUrl)).json().ageConfirmation;
    expect(before).toMatchObject({ requestId, draftId: draft.draftId, minimumAge: 18, state });

    const cancel = (version: number) => app.inject({ method: "DELETE", url: draftUrl, headers: { "if-match": String(version) } });
    const stale = await cancel(draft.version);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("DRAFT_VERSION_CONFLICT");
    expect((await app.inject(statusUrl)).json().ageConfirmation).toEqual(before);

    const draftCanceled = await cancel(added.json().version);
    expect(draftCanceled.statusCode).toBe(200);
    const projection = await app.inject("/api/v1/customer-displays/customer-1?registerId=register-1");
    expect(projection.json()).toMatchObject({ draftId: draft.draftId, state: "canceled", lines: [], totals: { totalYen: 0 } });
    const canceled = (await app.inject(statusUrl)).json().ageConfirmation;
    expect(canceled).toMatchObject({ requestId, draftId: draft.draftId, minimumAge: 18, state: "canceled", respondedAt: draftCanceled.json().updatedAt });

    const late = await answerYes();
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("AGE_CONFIRMATION_NOT_PENDING");
    expect((await app.inject(statusUrl)).json().ageConfirmation).toEqual(canceled);
  });

  it("同じレジの保留下書きを中止しても別の下書きの年齢確認要求は残る（F-056）", async () => {
    const { app, draft } = await setup();
    const draftUrl = `/api/v1/sale-drafts/${draft.draftId}`;
    const registerUrl = "/api/v1/registers/register-1";
    const added = await app.inject({ method: "POST", url: `${draftUrl}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(added.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${draftUrl}/park`, payload: { terminalId: "register-1" } })).statusCode).toBe(201);
    const parked = (await app.inject(draftUrl)).json();
    const next = await app.inject({ method: "POST", url: `${registerUrl}/sale-drafts`, payload: { eventId: catalog.eventId, staffId: "staff-1", businessDate: "2026-08-02" } });
    expect(next.statusCode).toBe(201);
    const requested = await app.inject({ method: "POST", url: `${registerUrl}/age-confirmation-requests`, payload: { draftId: next.json().draftId, minimumAge: 20 } });
    expect(requested.statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: draftUrl, headers: { "if-match": String(parked.version) } })).statusCode).toBe(200);
    expect((await app.inject(`${registerUrl}/customer-display-status`)).json().ageConfirmation).toEqual(requested.json());
  });

  it("呼戻しで空の下書きを中止しても年齢確認要求が残らない（F-056・呼戻し経路）", async () => {
    const { app, draft } = await setup();
    const draftUrl = `/api/v1/sale-drafts/${draft.draftId}`;
    const registerUrl = "/api/v1/registers/register-1";
    const statusUrl = `${registerUrl}/customer-display-status`;
    const added = await app.inject({ method: "POST", url: `${draftUrl}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(added.statusCode).toBe(201);
    const parkedResponse = await app.inject({ method: "POST", url: `${draftUrl}/park`, payload: { terminalId: "register-1" } });
    expect(parkedResponse.statusCode).toBe(201);
    const next = await app.inject({ method: "POST", url: `${registerUrl}/sale-drafts`, payload: { eventId: catalog.eventId, staffId: "staff-1", businessDate: "2026-08-02" } });
    expect(next.statusCode).toBe(201);
    const nextDraft = next.json();
    const nextAdded = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${nextDraft.draftId}/lines`, headers: { "if-match": String(nextDraft.version) }, payload: { productCode: "00000001" } });
    expect(nextAdded.statusCode).toBe(201);
    const requested = await app.inject({ method: "POST", url: `${registerUrl}/age-confirmation-requests`, payload: { draftId: nextDraft.draftId, minimumAge: 18 } });
    expect(requested.statusCode).toBe(201);
    const { requestId } = requested.json();
    const lineId = nextAdded.json().lines[0].lineId;
    const deleted = await app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${nextDraft.draftId}/lines/${lineId}`, headers: { "if-match": String(nextAdded.json().version) } });
    expect(deleted.statusCode).toBe(200);
    const resumed = await app.inject({ method: "POST", url: `${registerUrl}/parked-drafts/resume`, payload: { parkReference: parkedResponse.json().parkReference, terminalId: "register-1" } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().draftId).toBe(draft.draftId);
    const canceledDraft = (await app.inject(`/api/v1/sale-drafts/${nextDraft.draftId}`)).json();
    expect(canceledDraft.state).toBe("canceled");
    const ageConfirmation = (await app.inject(statusUrl)).json().ageConfirmation;
    expect(ageConfirmation).toMatchObject({ requestId, draftId: nextDraft.draftId, minimumAge: 18, state: "canceled" });
    expect(ageConfirmation.respondedAt).toBe(resumed.json().updatedAt);
  });
});
