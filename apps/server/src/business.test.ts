import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest, signInForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const catalog = {
  eventId: "business-event",
  products: [{ productCode: "00000001", name: "商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }],
  quickEntries: [],
  staffMembers: [
    { responsibleNumber: "001", displayName: "販売担当", role: "operator" },
    { responsibleNumber: "002", displayName: "責任者", role: "manager" },
    { responsibleNumber: "003", displayName: "管理者", role: "admin" },
  ],
};

describe("営業状態と担当者session", () => {
  it.each(["2026-08-03", "2026-08-04"])("旧営業の空の下書きを引き継がず %s のレジに新規作成する", async (nextDate) => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const { eventId } = catalog;
    const registerId = "register-1";
    const firstDate = "2026-08-03";
    await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: catalog });
    const cashSessionId = await openRegisterForTest(app, eventId, firstDate, registerId);
    const business = (await app.inject(`/api/v1/business-sessions/current?eventId=${eventId}`)).json().session;
    const registerUrl = `/api/v1/registers/${registerId}`;
    const start = (businessDate: string) => app.inject({ method: "POST", url: `${registerUrl}/sale-drafts`, payload: { eventId, businessDate, staffId: "001" } });
    const first = await start(firstDate);
    expect(first.statusCode).toBe(201);
    const old = first.json();
    expect(old).toMatchObject({ lines: [], payments: [] });
    const ageUrl = `${registerUrl}/age-confirmation-requests`;
    const requestAge = (draftId: string) => app.inject({ method: "POST", url: ageUrl, payload: { draftId, minimumAge: 18 } });
    const ageRequest = await requestAge(old.draftId);
    expect(ageRequest.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${cashSessionId}/checks/closing`, payload: { counted: [], terminalId: registerId } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/business-sessions/${business.businessSessionId}/close`, payload: { terminalId: registerId } })).statusCode).toBe(200);
    const whileClosed = await start(firstDate);
    expect(whileClosed.statusCode).toBe(409);
    expect(whileClosed.json()).toMatchObject({ error: { code: "REGISTER_NOT_OPEN" } });

    await openRegisterForTest(app, eventId, nextDate, registerId);
    expect((await app.inject(`${registerUrl}/sale-draft`)).statusCode).toBe(404);
    expect((await requestAge(old.draftId)).json().error.code).toBe("DRAFT_NOT_EDITABLE");
    const oldUrl = `/api/v1/sale-drafts/${old.draftId}`;
    const add = (draftId: string, version: number) => app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draftId}/lines`, headers: { "if-match": String(version) }, payload: { productCode: "00000001" } });
    expect((await add(old.draftId, old.version)).json().error.code).toBe("BUSINESS_CLOSED");
    expect((await app.inject({ method: "DELETE", url: oldUrl, headers: { "if-match": String(old.version) } })).json().error.code).toBe("BUSINESS_CLOSED");

    const created = await Promise.all([start(nextDate), start(nextDate)]);
    for (const response of created) expect(response.statusCode, response.body).toBe(201);
    const next = created[0]!.json();
    expect(next).toMatchObject({ businessDate: nextDate, sessionNo: 2 });
    expect(next.draftId).not.toBe(old.draftId);
    expect(created[1]!.json().draftId).toBe(next.draftId);
    expect((await app.inject(oldUrl)).json()).toMatchObject({ state: "canceled", version: old.version + 1 });
    expect((await add(old.draftId, old.version + 1)).json().error.code).toBe("DRAFT_NOT_EDITABLE");
    expect((await app.inject(`${registerUrl}/customer-display-status`)).json().ageConfirmation).toMatchObject({ requestId: ageRequest.json().requestId, state: "canceled" });
    expect((await app.inject(`/api/v1/customer-displays/customer-1?registerId=${registerId}`)).json()).toMatchObject({ draftId: next.draftId, lines: [], totals: { totalYen: 0 } });
    expect((await add(next.draftId, next.version)).statusCode).toBe(201);
  });

  it("001が未設定のカタログでは管理者を自動登録する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true }); apps.push(app);
    const initialCatalog = { ...catalog, staffMembers: [{ responsibleNumber: "002", displayName: "責任者", role: "manager" as const }] };
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${initialCatalog.eventId}/catalog`, payload: initialCatalog })).statusCode).toBe(200);
    const signIn = await app.inject({ method: "POST", url: "/api/v1/auth/sessions", payload: { eventId: initialCatalog.eventId, responsibleNumber: "001", terminalId: "register-1" } });
    expect(signIn.statusCode).toBe(201);
    expect(signIn.json().actor).toMatchObject({ responsibleNumber: "001", displayName: "管理者", role: "admin" });
  });

  it("空DBでも001の初回サインオンで管理者を自動登録する", async () => {
    const app = buildApp({ database: openDatabase(), requireAuth: true }); apps.push(app);
    const signIn = await app.inject({ method: "POST", url: "/api/v1/auth/sessions", payload: { eventId: "empty-event", responsibleNumber: "001", terminalId: "register-1" } });
    expect(signIn.statusCode).toBe(201);
    expect(signIn.json().actor).toMatchObject({ eventId: "empty-event", responsibleNumber: "001", displayName: "管理者", role: "admin" });
  });

  it("未開局の商品登録を拒否し、二段階開局後だけ販売を許可する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true }); apps.push(app);
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/business-event/catalog", payload: catalog })).statusCode).toBe(200);
    const operator = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    const manager = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "002", terminalId: "manager-1" });

    expect((await app.inject({ method: "POST", url: "/api/v1/business-sessions", headers: { cookie: operator.cookie }, payload: { eventId: catalog.eventId, businessDate: "2026-08-03" } })).statusCode).toBe(403);
    const foreignOrigin = await app.inject({ method: "POST", url: "/api/v1/business-sessions", headers: { ...operator, host: "pos.example.test", origin: "https://attacker.example.test" }, payload: { eventId: catalog.eventId, businessDate: "2026-08-03" } });
    expect(foreignOrigin.statusCode).toBe(403); expect(foreignOrigin.json().error.code).toBe("ORIGIN_REJECTED");
    const opened = await app.inject({ method: "POST", url: "/api/v1/business-sessions", headers: operator, payload: { eventId: catalog.eventId, businessDate: "2026-08-03", terminalId: "register-1" } });
    expect(opened.statusCode).toBe(201); expect(opened.json()).toMatchObject({ sessionNo: 1, state: "open" });

    const beforePrepare = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", headers: operator, payload: { eventId: catalog.eventId, staffId: "偽装", terminalId: "register-1", businessDate: "2026-08-03", sessionNo: 9 } });
    expect(beforePrepare.statusCode).toBe(409); expect(beforePrepare.json().error.code).toBe("REGISTER_NOT_OPEN");

    const prepared = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${opened.json().businessSessionId}/registers/register-1/prepare`, headers: operator, payload: { terminalId: "register-1" } });
    const sessionId = prepared.json().sessionId as string;
    const beforeOpeningCash = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", headers: operator, payload: { eventId: catalog.eventId, staffId: "001", terminalId: "register-1", businessDate: "2026-08-03" } });
    expect(beforeOpeningCash.statusCode).toBe(409); expect(beforeOpeningCash.json().error.code).toBe("REGISTER_NOT_OPEN");
    expect((await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/opening`, headers: { ...operator, "idempotency-key": "opening-1" }, payload: { counted: [{ denomination: 1000, quantity: 1 }], terminalId: "register-1" } })).statusCode).toBe(201);

    const draftResponse = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", headers: operator, payload: { eventId: catalog.eventId, staffId: "偽装", terminalId: "register-1", businessDate: "2099-01-01", sessionNo: 9 } });
    expect(draftResponse.statusCode).toBe(201); const draft = draftResponse.json();
    expect(draft).toMatchObject({ staffId: "001", businessDate: "2026-08-03", sessionNo: 1 });
    expect((await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { ...operator, "if-match": String(draft.version) }, payload: { productCode: "00000001" } })).statusCode).toBe(201);

    const closingBlocked = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/closing`, headers: { ...manager, "idempotency-key": "closing-blocked" }, payload: { counted: [{ denomination: 1000, quantity: 1 }], carryoverYen: 1000 } });
    expect(closingBlocked.statusCode).toBe(409); expect(closingBlocked.json().error.code).toBe("ACTIVE_DRAFTS_EXIST");
    expect((db.prepare("SELECT state FROM cash_sessions WHERE session_id=?").get(sessionId) as { state: string }).state).toBe("open");

    expect((await app.inject({ method: "DELETE", url: `/api/v1/sale-drafts/${draft.draftId}`, headers: { ...operator, "if-match": String(draft.version + 1) } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/closing`, headers: { ...manager, "idempotency-key": "closing-1" }, payload: { counted: [{ denomination: 1000, quantity: 1 }], carryoverYen: 1000 } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/business-sessions/${opened.json().businessSessionId}/close`, headers: manager, payload: { terminalId: "manager-1" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: operator.cookie } })).statusCode).toBe(401);
  });

  it("責任者だけが閉局済み営業を同じ番号で再開できる", async () => {
    const app = buildApp({ database: openDatabase(), requireAuth: true }); apps.push(app);
    await app.inject({ method: "PUT", url: "/api/v1/events/business-event/catalog", payload: catalog });
    const operator = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    const manager = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "002", terminalId: "manager-1" });
    const opened = await app.inject({ method: "POST", url: "/api/v1/business-sessions", headers: operator, payload: { eventId: catalog.eventId, businessDate: "2026-08-03" } });
    expect((await app.inject({ method: "POST", url: `/api/v1/business-sessions/${opened.json().businessSessionId}/close`, headers: manager, payload: {} })).statusCode).toBe(200);
    const operatorAfterClose = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    expect((await app.inject({ method: "POST", url: `/api/v1/business-sessions/${opened.json().businessSessionId}/reopen`, headers: operatorAfterClose, payload: { reason: "誤締め" } })).statusCode).toBe(403);
    const managerAfterClose = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "002", terminalId: "manager-1" });
    const reopened = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${opened.json().businessSessionId}/reopen`, headers: managerAfterClose, payload: { reason: "誤締め" } });
    expect(reopened.statusCode).toBe(200); expect(reopened.json()).toMatchObject({ sessionNo: 1, state: "open", reopenReason: "誤締め" });
  });

  it("明細も支払もない空ドラフトは精算を妨げない", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true }); apps.push(app);
    await app.inject({ method: "PUT", url: "/api/v1/events/business-event/catalog", payload: catalog });
    const operator = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    const manager = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "002", terminalId: "manager-1" });
    const business = await app.inject({ method: "POST", url: "/api/v1/business-sessions", headers: operator, payload: { eventId: catalog.eventId, businessDate: "2026-08-03", terminalId: "register-1" } });
    const prepared = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${business.json().businessSessionId}/registers/register-1/prepare`, headers: operator, payload: { terminalId: "register-1" } });
    const sessionId = prepared.json().sessionId as string;
    await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${sessionId}/checks/opening`, headers: { ...operator, "idempotency-key": "empty-opening" }, payload: { counted: [{ denomination: 1000, quantity: 1 }], terminalId: "register-1" } });
    expect((await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", headers: operator, payload: { eventId: catalog.eventId, staffId: "001", terminalId: "register-1", businessDate: "2026-08-03" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${sessionId}/checks/closing`, headers: { ...manager, "idempotency-key": "empty-closing" }, payload: { counted: [{ denomination: 1000, quantity: 1 }], carryoverYen: 1000, terminalId: "register-1" } })).statusCode).toBe(201);
  });

  it("受取会計は全明細を取り消しても登録中止までレジの精算と営業の閉局を妨げる", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const { eventId } = catalog;
    const registerId = "register-1";
    const businessDate = "2026-08-03";
    const saved = await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: catalog });
    expect(saved.statusCode).toBe(200);
    const sessionId = await openRegisterForTest(app, eventId, businessDate, registerId);
    const business = await app.inject({ url: `/api/v1/business-sessions/current?eventId=${eventId}` });
    const { businessSessionId } = business.json().session;
    const hold = await app.inject({
      method: "POST", url: "/api/v1/holds",
      payload: { eventId, registerId, terminalId: registerId, lines: [{ productCode: "00000001", quantity: 1 }] },
    });
    expect(hold.statusCode).toBe(201);
    const { holdId } = hold.json();
    const created = await app.inject({
      method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`,
      payload: { eventId, staffId: "001", terminalId: registerId, businessDate },
    });
    expect(created.statusCode).toBe(201);
    const { draftId, version } = created.json();
    const pickup = await app.inject({ method: "POST", url: `/api/v1/holds/${holdId}/claim`, payload: { draftId, version } });
    expect(pickup.statusCode).toBe(200);
    const draftUrl = `/api/v1/sale-drafts/${draftId}`;
    const canceledLine = await app.inject({
      method: "DELETE", url: `${draftUrl}/lines/${pickup.json().lines[0].lineId}`,
      headers: { "if-match": String(pickup.json().version) },
    });
    expect(canceledLine.statusCode).toBe(200);

    const closeBusiness = () => app.inject({
      method: "POST", url: `/api/v1/business-sessions/${businessSessionId}/close`, payload: { terminalId: registerId },
    });
    const closeCash = () => app.inject({
      method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/closing`,
      headers: { "idempotency-key": "pickup-closing" }, payload: { counted: [], carryoverYen: 0, terminalId: registerId },
    });
    const blockedBusiness = await closeBusiness();
    const blockedCash = await closeCash();
    expect([
      [blockedBusiness.statusCode, blockedBusiness.json().error?.code],
      [blockedCash.statusCode, blockedCash.json().error?.code],
    ]).toEqual([[409, "ACTIVE_DRAFTS_EXIST"], [409, "ACTIVE_DRAFTS_EXIST"]]);

    const canceled = await app.inject({
      method: "DELETE", url: draftUrl, headers: { "if-match": String(canceledLine.json().version) },
    });
    expect(canceled.statusCode).toBe(200);
    expect((await closeCash()).statusCode).toBe(201);
    const released = await app.inject({ method: "POST", url: `/api/v1/holds/${holdId}/release`, payload: { reason: "来場取消" } });
    expect(released.statusCode).toBe(200);
    expect((await closeBusiness()).statusCode).toBe(200);
  });
});
