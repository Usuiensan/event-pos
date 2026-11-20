import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest } from "./test-support.js";

const apps: FastifyInstance[]=[];
afterEach(async()=>{while(apps.length)await apps.pop()!.close();});
const catalog={eventId:"hold-event",products:[{productCode:"00000001",name:"予約商品",priceInclTax:500,taxRate:10,taxCategory:"inclusive_10",saleState:"on_sale"}],quickEntries:[],staffMembers:[{responsibleNumber:"001",displayName:"担当",role:"operator"},{responsibleNumber:"002",displayName:"責任者",role:"manager"}]};
const trackedCatalog={...catalog,products:[{...catalog.products[0],inventory:{openingQuantity:10}}]};

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
});
