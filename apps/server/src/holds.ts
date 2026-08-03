import { CheckoutError, allocatePublicReference, uuidV7 } from "./checkout-store.js";
import type { PosDatabase } from "./db.js";

type HoldInput = { eventId: string; businessDate: string; sessionNo: number; businessSessionId?: string; actorId: string; terminalId: string; lines: Array<{ productCode: string; quantity: number }>; allowShortage?: boolean };

export function createHold(db: PosDatabase, input: HoldInput) {
  if (!input.lines.length || !input.actorId || !input.terminalId) throw new CheckoutError(400, "HOLD_INPUT_INVALID", "取り置き担当者・端末・明細が必要です");
  db.exec("BEGIN IMMEDIATE");
  try {
    const holdId = uuidV7(); const now = new Date().toISOString(); const reference = allocatePublicReference(db, input.eventId, input.businessDate, input.sessionNo);
    const stored: Array<{ productId: string; productCode: string; name: string; quantity: number; shortage: number }> = [];
    for (const requested of input.lines) {
      if (!Number.isSafeInteger(requested.quantity) || requested.quantity < 1) throw new CheckoutError(400, "HOLD_QUANTITY_INVALID", "取り置き数は1以上の整数です");
      const product = db.prepare("SELECT product_id,product_code,name FROM event_products WHERE event_id=? AND product_code=?").get(input.eventId, requested.productCode) as { product_id: string; product_code: string; name: string } | undefined;
      if (!product) throw new CheckoutError(404, "PRODUCT_NOT_FOUND", "取り置き商品が見つかりません", { productCode: requested.productCode });
      const balance = db.prepare("SELECT on_hand,reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(input.eventId, product.product_id) as { on_hand: number; reserved: number } | undefined;
      const shortage = Math.max(0, requested.quantity - (Number(balance?.on_hand ?? 0) - Number(balance?.reserved ?? 0)));
      if (shortage && !input.allowShortage) throw new CheckoutError(409, "HOLD_STOCK_SHORTAGE", "在庫不足のため明示続行が必要です", { productCode: requested.productCode, shortage });
      stored.push({ productId: product.product_id, productCode: product.product_code, name: product.name, quantity: requested.quantity, shortage });
    }
    db.prepare("INSERT INTO holds(hold_id,event_id,business_session_id,business_date,session_no,public_reference,public_reference_display,state,created_by,terminal_id,created_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?)").run(holdId,input.eventId,input.businessSessionId ?? null,input.businessDate,input.sessionNo,reference.raw,reference.display,input.actorId,input.terminalId,now);
    for (const line of stored) { db.prepare("INSERT INTO hold_lines(hold_line_id,hold_id,product_id,product_code,product_name,quantity,created_at) VALUES (?,?,?,?,?,?,?)").run(uuidV7(),holdId,line.productId,line.productCode,line.name,line.quantity,now); db.prepare("UPDATE inventory_balances SET reserved=reserved+?,version=version+1 WHERE event_id=? AND product_id=?").run(line.quantity,input.eventId,line.productId); }
    db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'hold_created','hold',?,?,?)").run(input.eventId,holdId,JSON.stringify({ actorId: input.actorId, terminalId: input.terminalId, allowShortage: !!input.allowShortage, lines: stored }),now);
    db.exec("COMMIT"); return { holdId, publicReference: reference.raw, publicReferenceDisplay: reference.display, state: "active" as const, lines: stored };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function releaseHold(db: PosDatabase, holdId: string, actorId: string, reason: string) {
  if (!reason.trim()) throw new CheckoutError(400, "HOLD_RELEASE_REASON_REQUIRED", "取り置き解除理由が必要です");
  db.exec("BEGIN IMMEDIATE"); try {
    const hold = db.prepare("SELECT event_id,state FROM holds WHERE hold_id=?").get(holdId) as { event_id: string; state: string } | undefined;
    if (!hold) throw new CheckoutError(404, "HOLD_NOT_FOUND", "取り置きが見つかりません"); if (hold.state !== "active") throw new CheckoutError(409, "HOLD_NOT_RELEASABLE", "この取り置きは解除できません");
    for (const line of db.prepare("SELECT product_id,quantity FROM hold_lines WHERE hold_id=?").all(holdId) as Array<{ product_id: string; quantity: number }>) db.prepare("UPDATE inventory_balances SET reserved=reserved-?,version=version+1 WHERE event_id=? AND product_id=? AND reserved>=?").run(line.quantity,hold.event_id,line.product_id,line.quantity);
    db.prepare("UPDATE holds SET state='released',released_by=?,released_at=?,release_reason=? WHERE hold_id=?").run(actorId,new Date().toISOString(),reason.trim(),holdId);
    db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'hold_released','hold',?,?,?)").run(hold.event_id,holdId,JSON.stringify({actorId,reason:reason.trim()}),new Date().toISOString()); db.exec("COMMIT"); return { holdId,state:"released" as const };
  } catch(error) { db.exec("ROLLBACK"); throw error; }
}

export function findHold(db: PosDatabase, eventId: string, reference: string) { return db.prepare("SELECT h.*,json_group_array(json_object('productCode',l.product_code,'name',l.product_name,'quantity',l.quantity)) AS lines FROM holds h LEFT JOIN hold_lines l ON l.hold_id=h.hold_id WHERE h.event_id=? AND (h.hold_id=? OR h.public_reference=? OR h.public_reference_display=?) GROUP BY h.hold_id").get(eventId,reference,reference,reference); }
