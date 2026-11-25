import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildPrinterHost } from "@event-pos/printer-host/app";
import { FakeTransport } from "@event-pos/printer-host/transport";
import { buildApp } from "./app.js";
import type { SaleDraftDto } from "./checkout-store.js";
import { openDatabase } from "./db.js";
import { HttpPrinterHostClient } from "./printer-host-client.js";
import { openRegisterForTest } from "./test-support.js";

const apps: FastifyInstance[]=[];
afterEach(async()=>{while(apps.length)await apps.pop()!.close();});
const catalog={eventId:"hold-event",products:[{productCode:"00000001",name:"予約商品",priceInclTax:500,taxRate:10,taxCategory:"inclusive_10",saleState:"on_sale"}],quickEntries:[],staffMembers:[{responsibleNumber:"001",displayName:"担当",role:"operator"},{responsibleNumber:"002",displayName:"責任者",role:"manager"}]};
const trackedCatalog={...catalog,products:[{...catalog.products[0],inventory:{openingQuantity:10}}]};

async function preparePickup() {
  const db = openDatabase();
  const app = buildApp({ database: db });
  apps.push(app);
  const { eventId } = catalog;
  const productCode = "00000001";
  const registerId = "register-1";
  const businessDate = "2026-08-03";
  await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: trackedCatalog });
  await openRegisterForTest(app, eventId, businessDate, registerId);
  const hold = await app.inject({
    method: "POST", url: "/api/v1/holds",
    payload: { eventId, registerId, terminalId: registerId, lines: [{ productCode, quantity: 1 }, { productCode, quantity: 2 }] },
  });
  expect(hold.statusCode).toBe(201);
  const { holdId, publicReference } = hold.json();
  const startDraft = async () => {
    const response = await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId, staffId: "001", terminalId: registerId, businessDate } });
    expect(response.statusCode).toBe(201);
    return response.json<{ draftId: string; version: number }>();
  };
  const claim = (id: string, draft: { draftId: string; version: number }) =>
    app.inject({ method: "POST", url: `/api/v1/holds/${id}/claim`, payload: { draftId: draft.draftId, version: draft.version } });
  const claimed = await claim(holdId, await startDraft());
  expect(claimed.statusCode).toBe(200);
  const balance = () => db.prepare("SELECT on_hand, reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(eventId, `${eventId}:${productCode}`);
  expect(balance()).toEqual({ on_hand: 10, reserved: 0 });
  return { app, db, holdId, publicReference, draft: claimed.json<{ draftId: string; version: number }>(), startDraft, claim, balance };
}

describe("取り置き",()=>{
  it("期首在庫と移動台帳を基準に取り置きを作成し、検索結果を画面用DTOで返す",async()=>{
    const db=openDatabase(); const app=buildApp({database:db});apps.push(app); await app.inject({method:"PUT",url:"/api/v1/events/hold-event/catalog",payload:trackedCatalog});
    expect(db.prepare("SELECT on_hand FROM inventory_balances WHERE event_id=? AND product_id=?").get("hold-event","hold-event:00000001")).toMatchObject({on_hand:10});
    await openRegisterForTest(app,catalog.eventId,"2026-08-03","register-1");
    db.prepare("UPDATE inventory_balances SET on_hand=0 WHERE event_id=? AND product_id=?").run(catalog.eventId,"hold-event:00000001");
    db.prepare("INSERT INTO inventory_movements (inventory_movement_id,event_id,product_id,type,quantity_delta,transaction_line_id,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)").run("movement-1",catalog.eventId,"hold-event:00000001","sale",-1,null,"test",new Date().toISOString());
    const hold=await app.inject({method:"POST",url:"/api/v1/holds",payload:{eventId:catalog.eventId,registerId:"register-1",terminalId:"register-1",lines:[{productCode:"00000001",quantity:1}]}});
    expect(hold.statusCode).toBe(201);
    const found=await app.inject({method:"GET",url:`/api/v1/holds/find?eventId=${catalog.eventId}&reference=${hold.json().publicReference}`});
    expect(found.statusCode).toBe(200); expect(found.json()).toMatchObject({holdId:hold.json().holdId,publicReference:hold.json().publicReference,publicReferenceDisplay:hold.json().publicReferenceDisplay,state:"active",lines:[{productCode:"00000001",name:"予約商品",quantity:1}]});
    expect(typeof found.json().lines).toBe("object"); expect(Array.isArray(found.json().lines)).toBe(true);
  });
  it("共通受付番号で在庫を予約し、claimと解除を追記的に管理する",async()=>{
    const db=openDatabase(); const app=buildApp({database:db});apps.push(app); await app.inject({method:"PUT",url:"/api/v1/events/hold-event/catalog",payload:catalog});
    const operator={}; await openRegisterForTest(app,catalog.eventId,"2026-08-03","register-1");
    const productId="hold-event:00000001"; db.prepare("UPDATE inventory_balances SET on_hand=3 WHERE event_id=? AND product_id=?").run(catalog.eventId,productId);
    const hold=await app.inject({method:"POST",url:"/api/v1/holds",headers:operator,payload:{eventId:catalog.eventId,registerId:"register-1",terminalId:"register-1",lines:[{productCode:"00000001",quantity:2}]}}); expect(hold.statusCode).toBe(201); expect(hold.json().publicReferenceDisplay).toMatch(/^1000-/);
    const ticket = db.prepare("SELECT kind,canonical_ir AS canonicalIr,escpos_bytes AS escposBytes FROM print_jobs WHERE job_id=?").get(hold.json().printJobId) as { kind: string; canonicalIr: string; escposBytes: Buffer };
    expect(ticket.kind).toBe("original"); expect(ticket.canonicalIr).toContain(`{BPS12${hold.json().publicReference}`); expect(ticket.escposBytes.length).toBeGreaterThan(0);
    const reprint = await app.inject({ method: "POST", url: `/api/v1/holds/${hold.json().holdId}/reprint`, headers: operator, payload: { terminalId: "register-1", reason: "紙切れ" } });
    expect(reprint.statusCode).toBe(201); expect(reprint.json().printJobId).not.toBe(hold.json().printJobId);
    expect(db.prepare("SELECT kind,source_job_id AS sourceJobId FROM print_jobs WHERE job_id=?").get(reprint.json().printJobId)).toMatchObject({ kind: "reprint", sourceJobId: hold.json().printJobId });
    expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId,productId)).toMatchObject({reserved:2});
    const draft=(await app.inject({method:"POST",url:"/api/v1/registers/register-1/sale-drafts",headers:operator,payload:{eventId:catalog.eventId,staffId:"偽装",terminalId:"register-1",businessDate:"2026-08-03"}})).json();
    const claimed=await app.inject({method:"POST",url:`/api/v1/holds/${hold.json().holdId}/claim`,headers:operator,payload:{draftId:draft.draftId,version:draft.version}}); expect(claimed.statusCode).toBe(200); expect(claimed.json().lines[0].source).toBe("hold");
    expect(db.prepare("SELECT state FROM holds WHERE hold_id=?").get(hold.json().holdId)).toMatchObject({state:"claimed"}); expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId,productId)).toMatchObject({reserved:0});
    const second=await app.inject({method:"POST",url:"/api/v1/holds",headers:operator,payload:{eventId:catalog.eventId,registerId:"register-1",terminalId:"register-1",lines:[{productCode:"00000001",quantity:1}]}}); expect(second.statusCode).toBe(201);
    expect((await app.inject({method:"POST",url:`/api/v1/holds/${second.json().holdId}/release`,headers:operator,payload:{reason:"来場取消"}})).statusCode).toBe(200); expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId,productId)).toMatchObject({reserved:0});
  });
  it("取り置き票は保存済み描画バイトで印刷され、初回と再印刷の両方が完了する", async () => {
    const db = openDatabase();
    const transport = new FakeTransport();
    const host = buildPrinterHost({ transport });
    apps.push(host);
    await host.listen({ host: "127.0.0.1", port: 0 });
    const address = host.server.address();
    if (!address || typeof address === "string") throw new Error("PrinterHost test portを取得できません");
    const app = buildApp({ database: db, printerHost: new HttpPrinterHostClient(`http://127.0.0.1:${address.port}`) });
    apps.push(app);
    await app.inject({ method: "PUT", url: "/api/v1/events/hold-event/catalog", payload: catalog });
    await openRegisterForTest(app, catalog.eventId, "2026-08-03", "register-1");
    const hold = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", lines: [{ productCode: "00000001", quantity: 2 }] } });
    expect(hold.statusCode).toBe(201);
    const reprint = await app.inject({ method: "POST", url: `/api/v1/holds/${hold.json().holdId}/reprint`, payload: { terminalId: "register-1", reason: "紙切れ" } });
    expect(reprint.statusCode).toBe(201);
    expect(reprint.json().printJobId).not.toBe(hold.json().printJobId);
    const jobIds = [hold.json().printJobId as string, reprint.json().printJobId as string];
    const [firstJobId, secondJobId] = jobIds;
    if (!firstJobId || !secondJobId) throw new Error("取り置き票のjobIdを取得できません");
    await vi.waitFor(() => expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE job_id IN (?,?) AND state='completed'").get(firstJobId, secondJobId)).toEqual({ count: 2 }), { timeout: 5_000 });
    for (const jobId of jobIds) {
      const row = db.prepare("SELECT escpos_bytes AS escposBytes FROM print_jobs WHERE job_id=?").get(jobId) as { escposBytes: Buffer };
      expect(row.escposBytes.length).toBeGreaterThan(0);
      expect(transport.sent.some((bytes) => Buffer.from(bytes).equals(row.escposBytes))).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS count FROM print_attempts WHERE job_id=? AND phase='postcheck_completed' AND accepted_bytes>0").get(jobId)).toEqual({ count: 1 });
    }
  });
  it.each(["editing", "parked"])("受取会計（%s）を中止すると引当が一度だけ戻り、同じ受付番号で再受取できる", async (state) => {
    const { app, db, holdId, publicReference, draft, startDraft, claim, balance } = await preparePickup();
    const draftUrl = `/api/v1/sale-drafts/${draft.draftId}`;
    let version = draft.version;
    if (state === "parked") {
      const parked = await app.inject({ method: "POST", url: `${draftUrl}/park`, payload: { terminalId: "register-1" } });
      expect(parked.statusCode).toBe(201);
      const current = (await app.inject({ method: "GET", url: draftUrl })).json();
      expect(current.state).toBe("parked");
      version = current.version;
    }
    const adjusted = await app.inject({
      method: "POST", url: `/api/v1/events/${catalog.eventId}/inventory/adjustments`,
      payload: { productCode: "00000001", newOnHand: 1, reason: "棚卸差異" },
    });
    expect(adjusted.statusCode).toBe(200);

    const canceled = await app.inject({ method: "DELETE", url: draftUrl, headers: { "if-match": String(version) } });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().state).toBe("canceled");
    expect(balance()).toEqual({ on_hand: 1, reserved: 3 });
    expect(db.prepare("SELECT claimed_draft_id, claimed_at FROM holds WHERE hold_id=?").get(holdId))
      .toEqual({ claimed_draft_id: null, claimed_at: null });
    const repeated = await app.inject({ method: "DELETE", url: draftUrl, headers: { "if-match": String(canceled.json().version) } });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().error.code).toBe("DRAFT_NOT_EDITABLE");
    expect(balance()).toEqual({ on_hand: 1, reserved: 3 });

    const found = await app.inject({ method: "GET", url: `/api/v1/holds/find?eventId=${catalog.eventId}&reference=${publicReference}` });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ holdId, publicReference, state: "active" });
    const retried = await claim(found.json().holdId, await startDraft());
    expect(retried.statusCode).toBe(200);
    expect(balance()).toEqual({ on_hand: 1, reserved: 0 });
  });

  it("確定した受取会計の取消は拒否され、取り置きと売上が保持される", async () => {
    const { app, db, holdId, draft, balance } = await preparePickup();
    const draftUrl = `/api/v1/sale-drafts/${draft.draftId}`;
    const paid = await app.inject({ method: "POST", url: `${draftUrl}/payments`, headers: { "if-match": String(draft.version) }, payload: { kind: "credit" } });
    expect(paid.statusCode).toBe(201);
    const finalized = await app.inject({ method: "POST", url: `${draftUrl}/finalize`, headers: { "idempotency-key": "hold-pickup-sale" }, payload: { version: paid.json().version } });
    expect(finalized.statusCode).toBe(201);
    const canceled = await app.inject({ method: "DELETE", url: draftUrl, headers: { "if-match": String(finalized.json().draftVersion) } });
    expect(canceled.statusCode).toBe(409);
    expect(canceled.json().error.code).toBe("DRAFT_NOT_EDITABLE");
    expect(db.prepare("SELECT state, claimed_draft_id FROM holds WHERE hold_id=?").get(holdId))
      .toEqual({ state: "claimed", claimed_draft_id: draft.draftId });
    expect(balance()).toEqual({ on_hand: 7, reserved: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE type='sale'").get()).toEqual({ count: 1 });
  });

  it("保留会計の呼び戻しで空の下書きを中止しても、受取会計の取り置きに影響しない", async () => {
    const { app, db, holdId, draft, startDraft, balance } = await preparePickup();
    const parked = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/park`, payload: { terminalId: "register-1" } });
    expect(parked.statusCode).toBe(201);
    const empty = await startDraft();
    const resumed = await app.inject({
      method: "POST", url: "/api/v1/registers/register-1/parked-drafts/resume",
      payload: { parkReference: parked.json().parkReference, terminalId: "register-1" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ draftId: draft.draftId, state: "editing" });
    expect(db.prepare("SELECT state FROM sale_drafts WHERE draft_id=?").get(empty.draftId)).toEqual({ state: "canceled" });
    expect(db.prepare("SELECT state, claimed_draft_id FROM holds WHERE hold_id=?").get(holdId))
      .toEqual({ state: "claimed", claimed_draft_id: draft.draftId });
    expect(balance()).toEqual({ on_hand: 10, reserved: 0 });
  });

  it("全明細を取り消した受取会計が呼び戻しで中止されると、取り置きの引当が戻り再受取できる", async () => {
    const { app, db, holdId, publicReference, draft, startDraft, claim, balance } = await preparePickup();
    const terminalId = "register-1";
    const park = async (draftId: string) => {
      const response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draftId}/park`, payload: { terminalId } });
      expect(response.statusCode).toBe(201);
      return response.json<{ parkReference: string }>().parkReference;
    };
    const resume = (parkReference: string) => app.inject({
      method: "POST", url: `/api/v1/registers/${terminalId}/parked-drafts/resume`, payload: { parkReference, terminalId },
    });
    const pickupReference = await park(draft.draftId);
    const otherDraft = await startDraft();
    const added = await app.inject({
      method: "POST", url: `/api/v1/sale-drafts/${otherDraft.draftId}/lines`,
      headers: { "if-match": String(otherDraft.version) }, payload: { productCode: "00000001" },
    });
    expect(added.statusCode).toBe(201);
    const otherReference = await park(otherDraft.draftId);
    const pickup = await resume(pickupReference);
    expect(pickup.statusCode).toBe(200);
    const { lines, version: pickupVersion } = pickup.json<SaleDraftDto>();
    expect(lines).toHaveLength(2);
    let version = pickupVersion;
    for (const { lineId } of lines) {
      const canceled = await app.inject({
        method: "DELETE", url: `/api/v1/sale-drafts/${draft.draftId}/lines/${lineId}`, headers: { "if-match": String(version) },
      });
      expect(canceled.statusCode).toBe(200);
      version = canceled.json<SaleDraftDto>().version;
    }
    expect(balance()).toEqual({ on_hand: 10, reserved: 0 });

    const resumed = await resume(otherReference);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ draftId: otherDraft.draftId, state: "editing" });
    expect(db.prepare("SELECT state FROM sale_drafts WHERE draft_id=?").get(draft.draftId)).toEqual({ state: "canceled" });
    const found = await app.inject({ method: "GET", url: `/api/v1/holds/find?eventId=${catalog.eventId}&reference=${publicReference}` });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ holdId, publicReference, state: "active" });
    expect(db.prepare("SELECT claimed_draft_id, claimed_at FROM holds WHERE hold_id=?").get(holdId))
      .toEqual({ claimed_draft_id: null, claimed_at: null });
    expect(balance()).toEqual({ on_hand: 10, reserved: 3 });
    const retried = await claim(found.json().holdId, resumed.json<SaleDraftDto>());
    expect(retried.statusCode).toBe(200);
    expect(balance()).toEqual({ on_hand: 10, reserved: 0 });
  });

  it("繰越予約は閉局阻害を解消し、次営業でも同じ受付番号を有効化する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    await app.inject({ method: "PUT", url: "/api/v1/events/hold-event/catalog", payload: catalog });
    await openRegisterForTest(app, catalog.eventId, "2026-08-03", "register-1");
    db.prepare("UPDATE inventory_balances SET on_hand=2 WHERE event_id=? AND product_id=?").run(catalog.eventId, "hold-event:00000001");
    const hold = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", lines: [{ productCode: "00000001", quantity: 1 }] } });
    const oldBusiness = (await app.inject({ method: "GET", url: `/api/v1/business-sessions/current?eventId=${catalog.eventId}` })).json().session.businessSessionId;
    const requested = await app.inject({ method: "POST", url: `/api/v1/holds/${hold.json().holdId}/carry-request`, payload: { terminalId: "register-1" } });
    if (requested.statusCode !== 200) throw new Error(requested.body);
    expect(db.prepare("SELECT state FROM holds WHERE hold_id=?").get(hold.json().holdId)).toMatchObject({ state: "carried" });
    db.prepare("UPDATE business_sessions SET state='closed' WHERE business_session_id=?").run(oldBusiness);
    const next = await app.inject({ method: "POST", url: "/api/v1/business-sessions", payload: { eventId: catalog.eventId, businessDate: "2026-08-04", terminalId: "register-1" } });
    expect(next.statusCode).toBe(201);
    const carried = await app.inject({ method: "POST", url: `/api/v1/holds/${hold.json().holdId}/carry`, payload: { businessSessionId: next.json().businessSessionId, terminalId: "register-1" } });
    expect(carried.statusCode).toBe(200); expect(carried.json()).toMatchObject({ state: "active" });
    expect(db.prepare("SELECT public_reference AS reference,business_session_id AS businessSessionId FROM holds WHERE hold_id=?").get(hold.json().holdId)).toMatchObject({ reference: hold.json().publicReference, businessSessionId: next.json().businessSessionId });
  });
  it("同じ商品を複数明細に分けても、在庫不足の判定は同一商品で合算される（F-036）", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    const limitedCatalog = { ...catalog, products: [{ ...catalog.products[0], inventory: { openingQuantity: 3 } }] };
    await app.inject({ method: "PUT", url: "/api/v1/events/hold-event/catalog", payload: limitedCatalog });
    await openRegisterForTest(app, catalog.eventId, "2026-08-03", "register-1");
    const productId = "hold-event:00000001";
    const split = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", lines: [{ productCode: "00000001", quantity: 2 }, { productCode: "00000001", quantity: 2 }] } });
    expect(split.statusCode).toBe(409); expect(split.json().error.code).toBe("HOLD_STOCK_SHORTAGE");
    expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId, productId)).toMatchObject({ reserved: 0 });
    const allowed = await app.inject({ method: "POST", url: "/api/v1/holds", payload: { eventId: catalog.eventId, registerId: "register-1", terminalId: "register-1", allowShortage: true, lines: [{ productCode: "00000001", quantity: 2 }, { productCode: "00000001", quantity: 2 }] } });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().lines.reduce((sum: number, line: { shortage: number }) => sum + line.shortage, 0)).toBe(1);
    expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId, productId)).toMatchObject({ reserved: 4 });
  });
});
