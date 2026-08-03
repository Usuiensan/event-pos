import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest } from "./test-support.js";

const apps: FastifyInstance[]=[];
afterEach(async()=>{while(apps.length)await apps.pop()!.close();});
const catalog={eventId:"hold-event",products:[{productCode:"00000001",name:"予約商品",priceInclTax:500,taxRate:10,taxCategory:"inclusive_10",saleState:"on_sale"}],quickEntries:[],staffMembers:[{responsibleNumber:"001",displayName:"担当",role:"operator"},{responsibleNumber:"002",displayName:"責任者",role:"manager"}]};

describe("取り置き",()=>{
  it("共通受付番号で在庫を予約し、claimと解除を追記的に管理する",async()=>{
    const db=openDatabase(); const app=buildApp({database:db});apps.push(app); await app.inject({method:"PUT",url:"/api/v1/events/hold-event/catalog",payload:catalog});
    const operator={}; await openRegisterForTest(app,catalog.eventId,"2026-08-03","register-1");
    const productId="hold-event:00000001"; db.prepare("UPDATE inventory_balances SET on_hand=3 WHERE event_id=? AND product_id=?").run(catalog.eventId,productId);
    const hold=await app.inject({method:"POST",url:"/api/v1/holds",headers:operator,payload:{eventId:catalog.eventId,registerId:"register-1",terminalId:"register-1",lines:[{productCode:"00000001",quantity:2}]}}); expect(hold.statusCode).toBe(201); expect(hold.json().publicReferenceDisplay).toMatch(/^1000-/);
    expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId,productId)).toMatchObject({reserved:2});
    const draft=(await app.inject({method:"POST",url:"/api/v1/registers/register-1/sale-drafts",headers:operator,payload:{eventId:catalog.eventId,staffId:"偽装",terminalId:"register-1",businessDate:"2026-08-03"}})).json();
    const claimed=await app.inject({method:"POST",url:`/api/v1/holds/${hold.json().holdId}/claim`,headers:operator,payload:{draftId:draft.draftId,version:draft.version}}); expect(claimed.statusCode).toBe(200); expect(claimed.json().lines[0].source).toBe("hold");
    expect(db.prepare("SELECT state FROM holds WHERE hold_id=?").get(hold.json().holdId)).toMatchObject({state:"claimed"}); expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId,productId)).toMatchObject({reserved:0});
    const second=await app.inject({method:"POST",url:"/api/v1/holds",headers:operator,payload:{eventId:catalog.eventId,registerId:"register-1",terminalId:"register-1",lines:[{productCode:"00000001",quantity:1}]}}); expect(second.statusCode).toBe(201);
    expect((await app.inject({method:"POST",url:`/api/v1/holds/${second.json().holdId}/release`,headers:operator,payload:{reason:"来場取消"}})).statusCode).toBe(200); expect(db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(catalog.eventId,productId)).toMatchObject({reserved:0});
  });
});
