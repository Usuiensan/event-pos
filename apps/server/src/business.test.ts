import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { signInForTest } from "./test-support.js";

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
  it("001が未設定のカタログでは管理者を自動登録する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true }); apps.push(app);
    const initialCatalog = { ...catalog, staffMembers: [{ responsibleNumber: "002", displayName: "責任者", role: "manager" as const }] };
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${initialCatalog.eventId}/catalog`, payload: initialCatalog })).statusCode).toBe(200);
    const signIn = await app.inject({ method: "POST", url: "/api/v1/auth/sessions", payload: { eventId: initialCatalog.eventId, responsibleNumber: "001", terminalId: "register-1" } });
    expect(signIn.statusCode).toBe(201);
    expect(signIn.json().actor).toMatchObject({ responsibleNumber: "001", displayName: "管理者", role: "admin" });
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
});
