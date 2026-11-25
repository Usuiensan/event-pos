import { CheckoutError, allocatePublicReference, uuidV7 } from "./checkout-store.js";
import type { PosDatabase } from "./db.js";
import { canonicalizeReceiptDocument, type ReceiptDocument } from "@event-pos/receipt-ir";
import { bytesSha256, receiptDocumentToEscPos, DEFAULT_FINISHING_POLICY } from "@event-pos/escpos";
import { formatJstDateTime } from "./time-format.js";
import { receiptRenderOptions, receiptRendererVersion } from "./receipt-render-config.js";

type HoldInput = { eventId: string; businessDate: string; sessionNo: number; businessSessionId?: string; actorId: string; terminalId: string; lines: Array<{ productCode: string; quantity: number }>; allowShortage?: boolean };

function createHoldTicket(db: PosDatabase, hold: { holdId: string; reference: string; display: string; terminalId: string; actorId: string; createdAt: string; lines: Array<{ name: string; quantity: number }> }, sourceJobId?: string): string {
  const barcode = `{BPS12${hold.reference}`; const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes: [{ kind: "reset" }, { kind: "align", value: "center" }, { kind: "emphasis", bold: true, underline: false, invert: false }, { kind: "text", value: "取り置き票" }, { kind: "emphasis", bold: false, underline: false, invert: false }, { kind: "barcode", value: barcode, width: 3, height: 96, hri: "below" }, { kind: "align", value: "left" }, { kind: "text", value: `受付番号 ${hold.display}` }, ...hold.lines.flatMap((line) => [{ kind: "row" as const, left: line.name.slice(0, 18), right: `${line.quantity}点` }]), { kind: "text", value: `作成 ${formatJstDateTime(hold.createdAt)}` }, { kind: "text", value: `担当 ${hold.actorId}` }, { kind: "feed", lines: 5 }, { kind: "cut", mode: "partial" }] };
  const canonicalIr = canonicalizeReceiptDocument(document); const bytes = receiptDocumentToEscPos(document, [], receiptRenderOptions()); const jobId = uuidV7(); const operationId = uuidV7(); const now = new Date().toISOString();
  db.prepare(`INSERT INTO print_jobs(job_id,operation_id,transaction_id,printer_id,document_type,kind,payload_json,created_at,state,updated_at,source,source_job_id,renderer_version,bytes_sha256,canonical_ir,ir_sha256,escpos_bytes,expected_bytes_length,finishing_policy_id,finishing_policy_version,delivery_certainty)
    VALUES (?,?,?,?,?,?,?,'pending',?,'event-pos',?,?,?,?,?,?,?,?,?,?,'not_sent')`).run(jobId,operationId,`hold:${hold.holdId}`,hold.terminalId,"hold_ticket",sourceJobId ? "reprint" : "original",JSON.stringify({ holdId: hold.holdId, publicReference: hold.reference, barcode }),hold.createdAt,now,sourceJobId ?? null,receiptRendererVersion(),bytesSha256(bytes),canonicalIr,bytesSha256(Buffer.from(canonicalIr)),Buffer.from(bytes),bytes.length,DEFAULT_FINISHING_POLICY.id,DEFAULT_FINISHING_POLICY.version);
  const sequence = Number((db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM printer_operations").get() as { next: number }).next); db.prepare("INSERT INTO printer_operations(operation_id,sequence,kind,printer_id,payload_ref,state,available_at,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,'print','receipt-1',?,'pending',?,0,4,?,?)").run(operationId,sequence,jobId,now,now,now); return jobId;
}

export function createHold(db: PosDatabase, input: HoldInput) {
  if (!input.lines.length || !input.actorId || !input.terminalId) throw new CheckoutError(400, "HOLD_INPUT_INVALID", "取り置き担当者・端末・明細が必要です");
  db.exec("BEGIN IMMEDIATE");
  try {
    const holdId = uuidV7(); const now = new Date().toISOString(); const reference = allocatePublicReference(db, input.eventId, input.businessDate, input.sessionNo);
    const stored: Array<{ productId: string; productCode: string; name: string; quantity: number; shortage: number }> = [];
    const claimedInCall = new Map<string, number>();
    for (const requested of input.lines) {
      if (!Number.isSafeInteger(requested.quantity) || requested.quantity < 1) throw new CheckoutError(400, "HOLD_QUANTITY_INVALID", "取り置き数は1以上の整数です");
      const product = db.prepare("SELECT product_id,product_code,name FROM event_products WHERE event_id=? AND product_code=?").get(input.eventId, requested.productCode) as { product_id: string; product_code: string; name: string } | undefined;
      if (!product) throw new CheckoutError(404, "PRODUCT_NOT_FOUND", "取り置き商品が見つかりません", { productCode: requested.productCode });
      const inventory = db.prepare(`SELECT json_extract(p.value,'$.inventory.openingQuantity') AS opening_quantity,
          COALESCE((SELECT SUM(quantity_delta) FROM inventory_movements WHERE event_id=? AND product_id=?),0) AS quantity_delta,
          COALESCE(b.reserved,0) AS reserved
        FROM event_catalogs c, json_each(c.catalog_json,'$.products') p
        LEFT JOIN inventory_balances b ON b.event_id=c.event_id AND b.product_id=?
        WHERE c.event_id=? AND json_extract(p.value,'$.productCode')=?`).get(input.eventId, product.product_id, product.product_id, input.eventId, product.product_code) as { opening_quantity: number | null; quantity_delta: number; reserved: number } | undefined;
      const remaining = inventory?.opening_quantity === null || inventory === undefined ? null : Number(inventory.opening_quantity) + Number(inventory.quantity_delta);
      const alreadyClaimed = claimedInCall.get(product.product_id) ?? 0;
      const shortage = remaining === null ? 0 : Math.max(0, alreadyClaimed + requested.quantity - (remaining - Number(inventory?.reserved ?? 0)));
      if (shortage && !input.allowShortage) throw new CheckoutError(409, "HOLD_STOCK_SHORTAGE", "在庫不足のため明示続行が必要です", { productCode: requested.productCode, shortage });
      claimedInCall.set(product.product_id, alreadyClaimed + requested.quantity);
      stored.push({ productId: product.product_id, productCode: product.product_code, name: product.name, quantity: requested.quantity, shortage });
    }
    db.prepare("INSERT INTO holds(hold_id,event_id,business_session_id,business_date,session_no,public_reference,public_reference_display,state,created_by,terminal_id,created_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?)").run(holdId,input.eventId,input.businessSessionId ?? null,input.businessDate,input.sessionNo,reference.raw,reference.display,input.actorId,input.terminalId,now);
    for (const line of stored) { db.prepare("INSERT INTO hold_lines(hold_line_id,hold_id,product_id,product_code,product_name,quantity,created_at) VALUES (?,?,?,?,?,?,?)").run(uuidV7(),holdId,line.productId,line.productCode,line.name,line.quantity,now); db.prepare("UPDATE inventory_balances SET reserved=reserved+?,version=version+1 WHERE event_id=? AND product_id=?").run(line.quantity,input.eventId,line.productId); }
    const printJobId = createHoldTicket(db,{holdId,reference:reference.raw,display:reference.display,terminalId:input.terminalId,actorId:input.actorId,createdAt:now,lines:stored}); db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'hold_created','hold',?,?,?)").run(input.eventId,holdId,JSON.stringify({ actorId: input.actorId, terminalId: input.terminalId, allowShortage: !!input.allowShortage, lines: stored, printJobId }),now);
    db.exec("COMMIT"); return { holdId, publicReference: reference.raw, publicReferenceDisplay: reference.display, state: "active" as const, lines: stored, printJobId };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function reprintHoldTicket(db: PosDatabase, holdId: string, actorId: string, terminalId: string, reason: string) { if (!reason.trim()) throw new CheckoutError(400,"HOLD_REPRINT_REASON_REQUIRED","再印刷理由が必要です"); db.exec("BEGIN IMMEDIATE"); try { const hold=db.prepare("SELECT * FROM holds WHERE hold_id=?").get(holdId) as Record<string, unknown> | undefined; if(!hold) throw new CheckoutError(404,"HOLD_NOT_FOUND","取り置きが見つかりません"); const lines=db.prepare("SELECT product_name,quantity FROM hold_lines WHERE hold_id=?").all(holdId) as Array<{product_name:string;quantity:number}>; const source=db.prepare("SELECT job_id FROM print_jobs WHERE transaction_id=? AND document_type='hold_ticket' ORDER BY created_at DESC LIMIT 1").get(`hold:${holdId}`) as {job_id:string}|undefined; const printJobId=createHoldTicket(db,{holdId,reference:String(hold.public_reference),display:String(hold.public_reference_display),terminalId,actorId,createdAt:new Date().toISOString(),lines:lines.map(line=>({name:line.product_name,quantity:line.quantity}))},source?.job_id); db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'hold_reprint','hold',?,?,?)").run(String(hold.event_id),holdId,JSON.stringify({actorId,reason:reason.trim(),printJobId}),new Date().toISOString()); db.exec("COMMIT");return{holdId,printJobId}; }catch(error){db.exec("ROLLBACK");throw error;} }

export function requestHoldCarryover(db: PosDatabase, holdId: string, actorId: string, terminalId: string) {
  db.exec("BEGIN IMMEDIATE"); try {
    const hold = db.prepare("SELECT event_id,state,business_session_id FROM holds WHERE hold_id=?").get(holdId) as { event_id: string; state: string; business_session_id: string | null } | undefined;
    if (!hold) throw new CheckoutError(404, "HOLD_NOT_FOUND", "取り置きが見つかりません");
    if (hold.state !== "active") throw new CheckoutError(409, "HOLD_NOT_CARRYABLE", "この取り置きは繰越予約できません");
    const existingRequest = db.prepare("SELECT hold_id FROM hold_carry_requests WHERE hold_id=?").get(holdId) as { hold_id: string } | undefined;
    if (existingRequest) throw new CheckoutError(409, "HOLD_NOT_CARRYABLE", "この取り置きはすでに翌営業への繰越予約があります。受取または解除をしてください");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO hold_carry_requests(hold_id,from_business_session_id,requested_by,terminal_id,requested_at) VALUES (?,?,?,?,?)").run(holdId, hold.business_session_id, actorId, terminalId, now);
    db.prepare("UPDATE holds SET state='carried' WHERE hold_id=?").run(holdId);
    db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'hold_carry_requested','hold',?,?,?)").run(hold.event_id, holdId, JSON.stringify({ actorId, terminalId }), now);
    db.exec("COMMIT"); return { holdId, state: "carried" as const };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function carryHold(db: PosDatabase, holdId: string, businessSessionId: string, actorId: string, terminalId: string) { db.exec("BEGIN IMMEDIATE"); try { const hold=db.prepare("SELECT event_id,state,business_session_id FROM holds WHERE hold_id=?").get(holdId) as {event_id:string;state:string;business_session_id:string|null}|undefined; if(!hold) throw new CheckoutError(404,"HOLD_NOT_FOUND","取り置きが見つかりません"); if(hold.state!=="carried") throw new CheckoutError(409,"HOLD_NOT_CARRYABLE","先に翌営業への繰越予約を行ってください"); const business=db.prepare("SELECT event_id,state FROM business_sessions WHERE business_session_id=?").get(businessSessionId) as {event_id:string;state:string}|undefined; if(!business||business.event_id!==hold.event_id||business.state!=="open") throw new CheckoutError(409,"BUSINESS_NOT_OPEN","繰越先の営業が開局していません"); const request=db.prepare("SELECT from_business_session_id FROM hold_carry_requests WHERE hold_id=?").get(holdId) as {from_business_session_id:string|null}|undefined; if(!request) throw new CheckoutError(409,"HOLD_NOT_CARRYABLE","繰越予約の記録が見つかりません"); const now=new Date().toISOString(); db.prepare("INSERT INTO hold_carryovers(carryover_id,hold_id,from_business_session_id,to_business_session_id,carried_by,terminal_id,carried_at) VALUES (?,?,?,?,?,?,?)").run(uuidV7(),holdId,request.from_business_session_id,businessSessionId,actorId,terminalId,now); db.prepare("UPDATE holds SET business_session_id=?,state='active' WHERE hold_id=?").run(businessSessionId,holdId); db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'hold_carried','hold',?,?,?)").run(hold.event_id,holdId,JSON.stringify({actorId,businessSessionId}),now); db.exec("COMMIT"); return {holdId,state:"active" as const}; }catch(error){db.exec("ROLLBACK");throw error;} }

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

export function findHold(db: PosDatabase, eventId: string, reference: string) {
  const hold = db.prepare("SELECT hold_id AS holdId,public_reference AS publicReference,public_reference_display AS publicReferenceDisplay,state FROM holds WHERE event_id=? AND (hold_id=? OR public_reference=? OR public_reference_display=?)").get(eventId, reference, reference, reference) as { holdId: string; publicReference: string; publicReferenceDisplay: string; state: "active" | "claimed" | "released" | "carried" } | undefined;
  if (!hold) return undefined;
  const lines = db.prepare("SELECT product_code AS productCode,product_name AS name,quantity FROM hold_lines WHERE hold_id=? ORDER BY created_at,hold_line_id").all(hold.holdId) as Array<{ productCode: string; name: string; quantity: number }>;
  return { ...hold, lines };
}
