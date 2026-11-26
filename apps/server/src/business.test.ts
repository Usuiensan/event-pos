import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest, signInForTest } from "./test-support.js";
import { parsePublicReference, validatePublicReference } from "@event-pos/contracts";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const saved = await app.inject({
      method: "PUT", url: `/api/v1/events/${eventId}/catalog`,
      payload: { ...catalog, products: [{ ...catalog.products[0], inventory: { openingQuantity: 1 } }] },
    });
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
    const closingBlockers = async () => {
      const response = await app.inject({
        url: `/api/v1/operations/dashboard?eventId=${eventId}&businessDate=${businessDate}`,
        headers: { "x-pos-role": "manager", "x-pos-actor-id": "002" },
      });
      expect(response.statusCode).toBe(200);
      return response.json().holds.closingBlockers;
    };
    expect(await closingBlockers()).toMatchObject([{ holdId, state: "active" }]);
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
    expect(canceledLine.json().lines).toMatchObject([{ status: "canceled" }]);

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
    expect(await closingBlockers()).toMatchObject([{ holdId, state: "claimed" }]);

    const canceled = await app.inject({
      method: "DELETE", url: draftUrl, headers: { "if-match": String(canceledLine.json().version) },
    });
    expect(canceled.statusCode).toBe(200);
    expect(await closingBlockers()).toMatchObject([{ holdId, state: "active" }]);
    const inventory = await app.inject({ url: `/api/v1/events/${eventId}/inventory` });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json().products).toMatchObject([{ reserved: 1 }]);
    expect((await closeCash()).statusCode).toBe(201);
    const released = await app.inject({ method: "POST", url: `/api/v1/holds/${holdId}/release`, payload: { reason: "来場取消" } });
    expect(released.statusCode).toBe(200);
    expect((await closeBusiness()).statusCode).toBe(200);
  });

  it("支払い保存後に最後の明細を取り消すと明細0件・支払1件が残って精算を妨げ、支払取消と登録中止で解消できる（F-079）", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const { eventId } = catalog;
    const registerId = "register-1";
    const businessDate = "2026-08-03";
    await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: catalog });
    const sessionId = await openRegisterForTest(app, eventId, businessDate, registerId);
    const created = await app.inject({
      method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`,
      payload: { eventId, staffId: "001", terminalId: registerId, businessDate },
    });
    expect(created.statusCode).toBe(201);
    const { draftId, version } = created.json();
    const draftUrl = `/api/v1/sale-drafts/${draftId}`;
    const added = await app.inject({
      method: "POST", url: `${draftUrl}/lines`, headers: { "if-match": String(version) }, payload: { productCode: "00000001" },
    });
    expect(added.statusCode).toBe(201);
    const paid = await app.inject({
      method: "POST", url: `${draftUrl}/payments`, headers: { "if-match": String(added.json().version) },
      payload: { kind: "credit", amountYen: 100 },
    });
    expect(paid.statusCode).toBe(201);
    expect(paid.json().payments).toHaveLength(1);
    const canceledLine = await app.inject({
      method: "DELETE", url: `${draftUrl}/lines/${added.json().lines[0].lineId}`,
      headers: { "if-match": String(paid.json().version) },
    });
    expect(canceledLine.statusCode).toBe(200);
    expect(canceledLine.json().lines.filter((line: { status: string }) => line.status === "active")).toHaveLength(0);
    expect(canceledLine.json().payments).toHaveLength(1);

    const closeCash = (key: string) => app.inject({
      method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/closing`,
      headers: { "idempotency-key": key }, payload: { counted: [], carryoverYen: 0, terminalId: registerId },
    });
    const blocked = await closeCash("payment-only-closing");
    expect([blocked.statusCode, blocked.json().error?.code]).toEqual([409, "ACTIVE_DRAFTS_EXIST"]);

    // 明細0件でも支払取消は受理される（画面からは小計経由で到達する）
    const removed = await app.inject({
      method: "DELETE", url: `${draftUrl}/payments/${paid.json().payments[0].paymentId}`,
      headers: { "if-match": String(canceledLine.json().version) },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().payments).toHaveLength(0);
    const canceled = await app.inject({
      method: "DELETE", url: draftUrl, headers: { "if-match": String(removed.json().version) },
    });
    expect(canceled.statusCode).toBe(200);
    expect((await closeCash("payment-only-closing-2")).statusCode).toBe(201);
  });
});

describe("営業番号の2桁対応（F-060）", () => {
  it("10回目の営業でも下書き・会計確定・取り置きができ、受付番号は10桁になる", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const { eventId } = catalog;
    const registerId = "register-1";
    await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: catalog });
    for (let cycle = 1; cycle <= 9; cycle++) {
      const date = `2026-08-${String(cycle).padStart(2, "0")}`;
      const cashSessionId = await openRegisterForTest(app, eventId, date, registerId);
      expect((await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${cashSessionId}/checks/closing`, payload: { counted: [], terminalId: registerId } })).statusCode, `cycle ${cycle} closing`).toBe(201);
      const business = (await app.inject(`/api/v1/business-sessions/current?eventId=${eventId}`)).json().session;
      expect(business.sessionNo).toBe(cycle);
      expect((await app.inject({ method: "POST", url: `/api/v1/business-sessions/${business.businessSessionId}/close`, payload: { terminalId: registerId } })).statusCode, `cycle ${cycle} close`).toBe(200);
    }
    const date10 = "2026-08-10";
    await openRegisterForTest(app, eventId, date10, registerId);
    const business10 = (await app.inject(`/api/v1/business-sessions/current?eventId=${eventId}`)).json().session;
    expect(business10.sessionNo).toBe(10);
    const draftResponse = await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId, businessDate: date10, staffId: "001", terminalId: registerId } });
    expect(draftResponse.statusCode, draftResponse.body).toBe(201);
    const draft = draftResponse.json();
    expect(draft.sessionNo).toBe(10);
    const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(line.statusCode, line.body).toBe(201);
    const paid = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(line.json().version) }, payload: { kind: "cash", amountYen: 100, tenderedYen: 100 } });
    expect(paid.statusCode, paid.body).toBe(201);
    const sale = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "f060-sale" }, payload: { version: paid.json().version } });
    expect(sale.statusCode, sale.body).toBe(201);
    const reference = sale.json().publicReference as string;
    expect(reference).toHaveLength(10);
    expect(validatePublicReference(reference)).toBe(true);
    expect(parsePublicReference(reference)).toMatchObject({ session: 10, sequence: 1 });
    const hold = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId, registerId, terminalId: registerId, lines: [{ productCode: "00000001", quantity: 1 }] } });
    expect(hold.statusCode, hold.body).toBe(201);
    expect(validatePublicReference(String(hold.json().publicReference))).toBe(true);
  }, 120000);

  it("旧スキーマ（session_no 1〜9）のDBを開くと制約が移行され、既存行が残る", () => {
    const path = join(tmpdir(), `event-pos-f060-${process.pid}-${Date.now()}.sqlite`);
    try {
      const raw = new DatabaseSync(path);
      raw.exec(`CREATE TABLE sale_drafts (
        draft_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, register_id TEXT NOT NULL, staff_id TEXT NOT NULL,
        terminal_id TEXT NOT NULL, business_date TEXT NOT NULL, session_no INTEGER NOT NULL DEFAULT 1 CHECK(session_no BETWEEN 1 AND 9),
        cash_session_id TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        state TEXT NOT NULL CHECK(state IN ('editing','payment','finalizing','parked','completed','canceled')),
        park_reference TEXT, parked_at TEXT, completed_transaction_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE public_reference_counters (
        event_id TEXT NOT NULL, business_date TEXT NOT NULL,
        session_no INTEGER NOT NULL CHECK(session_no BETWEEN 1 AND 9),
        next_sequence INTEGER NOT NULL CHECK(next_sequence BETWEEN 1 AND 1000000),
        PRIMARY KEY(event_id, business_date, session_no)
      );
      INSERT INTO public_reference_counters VALUES ('legacy-event', '2026-08-02', 9, 5);`);
      raw.close();
      const db = openDatabase(path);
      expect(db.prepare("SELECT next_sequence FROM public_reference_counters WHERE event_id='legacy-event' AND session_no=9").get()).toEqual({ next_sequence: 5 });
      expect(() => db.prepare("INSERT INTO public_reference_counters (event_id,business_date,session_no,next_sequence) VALUES ('legacy-event','2026-08-02',10,1)").run()).not.toThrow();
      expect(() => db.prepare(`INSERT INTO sale_drafts (draft_id,event_id,register_id,staff_id,terminal_id,business_date,session_no,version,state,created_at,updated_at)
        VALUES ('d1','legacy-event','register-1','001','register-1','2026-08-02',10,1,'editing','2026-08-02T00:00:00.000Z','2026-08-02T00:00:00.000Z')`).run()).not.toThrow();
      db.close();
    } finally {
      rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    }
  });
});

describe("長い商品名の帳票（F-061）", () => {
  it("全角16文字の商品名でも領収書・中間計・精算が止まらない", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const eventId = "longname-event";
    const longCatalog = {
      eventId,
      event: { name: "長名イベント", businessDate: "2026-08-02", seller: { circleName: "検証サークル", space: "A01", receiptIssuerName: "検証" }, locale: { language: "ja", currency: "JPY", timezone: "Asia/Tokyo" } },
      products: [{ productCode: "00000001", name: "あいうえおかきくけこさしすせそた", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }],
      quickEntries: [],
      staffMembers: catalog.staffMembers,
    };
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: longCatalog })).statusCode).toBe(200);
    const registerId = "register-1";
    const cashSessionId = await openRegisterForTest(app, eventId, "2026-08-02", registerId);
    const draft = (await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId, businessDate: "2026-08-02", staffId: "001", terminalId: registerId } })).json();
    const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
    expect(line.statusCode).toBe(201);
    const paid = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(line.json().version) }, payload: { kind: "cash", amountYen: 100, tenderedYen: 100 } });
    expect(paid.statusCode).toBe(201);
    const sale = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "longname-sale" }, payload: { version: paid.json().version } });
    expect(sale.statusCode).toBe(201);
    const receipt = await app.inject({ method: "POST", url: `/api/v1/transactions/${sale.json().transactionId}/official-receipts`, payload: { payeeName: "山田", memo: "商品代", terminalId: registerId } });
    expect(receipt.statusCode).toBe(201);
    const interim = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${cashSessionId}/checks/interim`, payload: { counted: [{ denomination: 100, quantity: 1 }], terminalId: registerId } });
    expect(interim.statusCode).toBe(201);
    const closing = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${cashSessionId}/checks/closing`, headers: { "idempotency-key": "longname-closing" }, payload: { counted: [{ denomination: 100, quantity: 1 }], carryoverYen: 100, terminalId: registerId } });
    expect(closing.statusCode).toBe(201);
    expect((await app.inject(`/api/v1/cash-sessions/${cashSessionId}`)).json().state).toBe("closed");
  });
});

describe("イベント切替時の下書き（F-062）", () => {
  it("旧イベントの未確定下書きが新イベントの下書き作成を妨げず、旧セッションに戻れば再び見える", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const catalogA = { ...catalog, eventId: "switch-event-a" };
    const catalogB = { ...catalog, eventId: "switch-event-b" };
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/switch-event-a/catalog", payload: catalogA })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/switch-event-b/catalog", payload: catalogB })).statusCode).toBe(200);
    const registerId = "register-1";
    await openRegisterForTest(app, "switch-event-a", "2026-08-02", registerId);
    const draftA = (await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId: "switch-event-a", businessDate: "2026-08-02", staffId: "001", terminalId: registerId } })).json();
    const lineA = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draftA.draftId}/lines`, headers: { "if-match": String(draftA.version) }, payload: { productCode: "00000001" } });
    expect(lineA.statusCode).toBe(201);
    // イベントBへ切り替える（Aの営業は開いたまま、下書きは未確定のまま残す）
    await openRegisterForTest(app, "switch-event-b", "2026-08-02", registerId);
    const createdB = await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId: "switch-event-b", businessDate: "2026-08-02", staffId: "001", terminalId: registerId } });
    expect(createdB.statusCode).toBe(201);
    expect(createdB.json()).toMatchObject({ eventId: "switch-event-b" });
    expect(createdB.json().draftId).not.toBe(draftA.draftId);
    // 現在のセッション（B）の下書きが返り、Aの下書きは返らない
    const current = await app.inject(`/api/v1/registers/${registerId}/sale-draft`);
    expect(current.statusCode).toBe(200);
    expect(current.json().draftId).toBe(createdB.json().draftId);
    // Aの下書きは消えておらず、Aのセッションで作り直すと明細ごと戻る
    expect((await app.inject(`/api/v1/sale-drafts/${draftA.draftId}`)).json()).toMatchObject({ state: "editing" });
    const againA = await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId: "switch-event-a", businessDate: "2026-08-02", staffId: "001", terminalId: registerId } });
    expect(againA.statusCode).toBe(201);
    expect(againA.json().draftId).toBe(draftA.draftId);
    expect(againA.json().lines).toHaveLength(1);
  });

  it("旧形式のアクティブ下書き一意索引はセッション単位へ移行される", () => {
    const path = join(tmpdir(), `event-pos-f062-${Date.now()}.sqlite`);
    try {
      const db = openDatabase(path);
      db.exec("DROP INDEX ux_sale_drafts_active_register");
      db.exec("CREATE UNIQUE INDEX ux_sale_drafts_active_register ON sale_drafts(register_id) WHERE state IN ('editing','payment','finalizing')");
      db.close();
      const reopened = openDatabase(path);
      const index = reopened.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_sale_drafts_active_register'").get() as { sql: string };
      expect(index.sql).toContain("cash_session_id");
      reopened.close();
    } finally {
      rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    }
  });
});
