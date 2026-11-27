import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest } from "./test-support.js";

// F-080: 同一レジで別イベントの営業が同時開局しているとき、下書き・保留呼戻し・顧客表示が
// 現在のイベント／現金セッションの範囲を超えて混ざらないこと。
const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const baseCatalog = {
  products: [{ productCode: "00000001", name: "10%商品", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", departmentId: "001" }],
  quickEntries: [],
  autoDiscountRules: [],
  departments: [{ departmentId: "001", code: "001", name: "第一部門", settlementOwnerId: "001", enabled: true }],
  staffMembers: [{ responsibleNumber: "001", displayName: "試験管理者", role: "admin" }],
};
const EVENT_A = "scope-event-a";
const EVENT_B = "scope-event-b";
const registerId = "register-1";

async function installAndOpen(app: FastifyInstance, eventId: string, ageCheck?: "18" | "20"): Promise<void> {
  const products = baseCatalog.products.map((product) => ({ ...product, ageCheck }));
  expect((await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: { ...baseCatalog, eventId, products } })).statusCode).toBe(200);
  await openRegisterForTest(app, eventId, "2026-08-02", registerId);
}

async function startDraftWithLine(app: FastifyInstance, eventId: string): Promise<{ draftId: string; version: number }> {
  const draft = (await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId, businessDate: "2026-08-02", staffId: "001", terminalId: registerId } })).json();
  const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
  expect(line.statusCode).toBe(201);
  return { draftId: draft.draftId, version: line.json().version };
}

async function parkDraft(app: FastifyInstance, draftId: string): Promise<string> {
  const parked = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draftId}/park`, payload: { terminalId: registerId } });
  expect(parked.statusCode).toBe(201);
  return parked.json().parkReference as string;
}

describe("別イベント間の下書き・保留・顧客表示の範囲（F-080）", () => {
  it("同じ保留番号が両イベントにあっても、呼戻しは指定したイベントの保留だけを返す", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    await installAndOpen(app, EVENT_A);
    const draftA = await startDraftWithLine(app, EVENT_A);
    const referenceA = await parkDraft(app, draftA.draftId);
    await installAndOpen(app, EVENT_B);
    const draftB = await startDraftWithLine(app, EVENT_B);
    const referenceB = await parkDraft(app, draftB.draftId);
    // 採番はイベント別なので、同じレジ・同じ営業番号では保留番号が一致する
    expect(referenceA).toBe(referenceB);

    const resume = (eventId?: string) => app.inject({
      method: "POST", url: `/api/v1/registers/${registerId}/parked-drafts/resume`,
      payload: { terminalId: registerId, parkReference: referenceB, ...(eventId ? { eventId } : {}) },
    });
    // eventId がなければ、どのイベントの保留か確定できないため拒否する
    const withoutEvent = await resume();
    expect(withoutEvent.statusCode).toBe(400);
    expect(withoutEvent.json().error.code).toBe("EVENT_ID_REQUIRED");
    // 新イベント(B)を指定すると B の保留が返り、旧イベント(A)の下書きは返らない
    const resumedB = await resume(EVENT_B);
    expect(resumedB.statusCode).toBe(200);
    expect(resumedB.json()).toMatchObject({ draftId: draftB.draftId, eventId: EVENT_B, state: "editing" });
    // A の保留は残っており、A を指定すれば従来どおり呼び戻せる
    const resumedA = await resume(EVENT_A);
    expect(resumedA.statusCode).toBe(200);
    expect(resumedA.json()).toMatchObject({ draftId: draftA.draftId, eventId: EVENT_A, state: "editing" });
  });

  it("下書きGETは eventId 指定でそのイベントの下書きを返し、未指定時は従来どおり最新開局を返す", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    await installAndOpen(app, EVENT_A);
    const draftA = await startDraftWithLine(app, EVENT_A);
    await installAndOpen(app, EVENT_B);
    const draftB = await startDraftWithLine(app, EVENT_B);

    const forA = await app.inject(`/api/v1/registers/${registerId}/sale-draft?eventId=${EVENT_A}`);
    expect(forA.statusCode).toBe(200);
    expect(forA.json().draftId).toBe(draftA.draftId);
    const forB = await app.inject(`/api/v1/registers/${registerId}/sale-draft?eventId=${EVENT_B}`);
    expect(forB.statusCode).toBe(200);
    expect(forB.json().draftId).toBe(draftB.draftId);
    const unscoped = await app.inject(`/api/v1/registers/${registerId}/sale-draft`);
    expect(unscoped.statusCode).toBe(200);
    expect(unscoped.json().draftId).toBe(draftB.draftId);
  });

  it("顧客表示は eventId 指定でそのイベントの射影だけを返し、別イベントの更新で消えない", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    await installAndOpen(app, EVENT_A);
    const draftA = await startDraftWithLine(app, EVENT_A);
    await installAndOpen(app, EVENT_B);
    const draftB = await startDraftWithLine(app, EVENT_B);

    const display = (eventId: string) => app.inject(`/api/v1/customer-displays/customer-1?registerId=${registerId}&eventId=${eventId}`);
    expect((await display(EVENT_A)).json()).toMatchObject({ draftId: draftA.draftId, totals: { totalYen: 110 } });
    expect((await display(EVENT_B)).json()).toMatchObject({ draftId: draftB.draftId, totals: { totalYen: 110 } });

    // B の下書きを更新しても A の射影は残る
    const updatedB = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draftB.draftId}/lines`, headers: { "if-match": String(draftB.version) }, payload: { productCode: "00000001" } });
    expect(updatedB.statusCode).toBe(201);
    expect((await display(EVENT_B)).json()).toMatchObject({ draftId: draftB.draftId, totals: { totalYen: 220 } });
    expect((await display(EVENT_A)).json()).toMatchObject({ draftId: draftA.draftId, totals: { totalYen: 110 } });
  });

  it("旧形式の顧客表示テーブルはセッション単位へ移行され、既存行が残る", () => {
    const path = join(tmpdir(), `event-pos-f080-${Date.now()}.sqlite`);
    try {
      const db = openDatabase(path);
      db.exec("DROP TABLE customer_display_states");
      db.exec(`CREATE TABLE customer_display_states (
        register_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
        public_projection_json TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      db.prepare("INSERT INTO customer_display_states (register_id,version,public_projection_json,updated_at) VALUES ('register-1',3,?,?)")
        .run(JSON.stringify({ registerId: "register-1", draftId: "unknown-draft", version: 3 }), "2026-08-02T00:00:00.000Z");
      db.close();
      const reopened = openDatabase(path);
      const table = reopened.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='customer_display_states'").get() as { sql: string };
      expect(table.sql).toContain("cash_session_id");
      expect(reopened.prepare("SELECT register_id,cash_session_id,event_id,version FROM customer_display_states").get())
        .toEqual({ register_id: "register-1", cash_session_id: "", event_id: null, version: 3 });
      reopened.close();
    } finally {
      rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    }
  });
});

it("同じレジの18歳と20歳の年齢確認要求をイベントごとに作成・表示できる（F-102）", async () => {
  const app = buildApp({ database: openDatabase() }); apps.push(app);
  await installAndOpen(app, EVENT_A, "18");
  const draftA = await startDraftWithLine(app, EVENT_A);
  await installAndOpen(app, EVENT_B, "20");
  const draftB = await startDraftWithLine(app, EVENT_B);

  const registerUrl = `/api/v1/registers/${registerId}`;
  const customerUrl = "/api/v1/customer-displays/customer-1";
  const requestAge = async (draftId: string, minimumAge: 18 | 20) => {
    const response = await app.inject({ method: "POST", url: `${registerUrl}/age-confirmation-requests`, payload: { draftId, minimumAge } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ draftId, minimumAge, state: "requested" });
    return response.json();
  };
  const status = async (eventId?: string) => (await app.inject(`${registerUrl}/customer-display-status${eventId ? `?eventId=${eventId}` : ""}`)).json();
  const notice = async (eventId: string) => (await status(eventId)).ageConfirmation;
  const requestB = await requestAge(draftB.draftId, 20);
  const requestA = await requestAge(draftA.draftId, 18);
  for (const [eventId, request] of [[EVENT_A, requestA], [EVENT_B, requestB]] as const) {
    const draft = await app.inject(`${registerUrl}/sale-draft?eventId=${eventId}`);
    expect(draft.json()).toMatchObject({ draftId: request.draftId, pendingAgeVerification: request.minimumAge });
    const projection = await app.inject(`${customerUrl}?registerId=${registerId}&eventId=${eventId}`);
    expect(projection.json().draftId).toBe(request.draftId);
    expect(await notice(eventId)).toEqual(request);
  }
  expect((await app.inject({ method: "POST", url: `${customerUrl}/heartbeat`, payload: { registerId } })).statusCode).toBe(204);
  expect(await status()).toMatchObject({ available: true, ageConfirmation: null });

  const replacementA = await requestAge(draftA.draftId, 18);
  expect(replacementA.requestId).not.toBe(requestA.requestId);
  expect(await notice(EVENT_A)).toEqual(replacementA);
  expect(await notice(EVENT_B)).toEqual(requestB);

  const answer = (requestId: string) => app.inject({ method: "POST", url: `${customerUrl}/age-confirmations`, payload: { registerId, requestId, response: "yes" } });
  expect((await answer(requestA.requestId)).json().error.code).toBe("AGE_CONFIRMATION_NOT_PENDING");
  const acknowledgedB = await answer(requestB.requestId);
  expect(acknowledgedB.statusCode).toBe(201);
  expect(acknowledgedB.json()).toMatchObject({ requestId: requestB.requestId, draftId: draftB.draftId, minimumAge: 20, state: "acknowledged" });
  expect((await app.inject(`${registerUrl}/sale-draft?eventId=${EVENT_B}`)).json()).toMatchObject({ pendingAgeVerification: 20, ageVerifications: [] });
  expect(await notice(EVENT_A)).toEqual(replacementA);

  expect((await app.inject({ method: "DELETE", url: `${registerUrl}/age-confirmation-requests/${replacementA.requestId}` })).statusCode).toBe(204);
  expect(await notice(EVENT_A)).toMatchObject({ requestId: replacementA.requestId, state: "canceled" });
  expect(await notice(EVENT_B)).toEqual(acknowledgedB.json());
});
