import { canonicalizeReceiptDocument, type ReceiptDocument } from "@event-pos/receipt-ir";
import { bytesSha256, receiptDocumentToEscPos } from "@event-pos/escpos";
import { importEventCatalog } from "@event-pos/contracts";
import { formatPublicReference } from "@event-pos/contracts";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createPrintJob } from "./db.js";
import type { PosDatabase } from "./db.js";
import { CheckoutError, allocatePublicReference, getSaleDraft, restoreHoldsForCanceledDraft, updateProjection } from "./checkout-store.js";
import { notifyDraft } from "./checkout-routes.js";
import { assertRegisterOpen } from "./business-store.js";
import { AuthError, requireAuthActor } from "./auth.js";
import { uuidV7 } from "./ids.js";
import { formatJstDateTime } from "./time-format.js";
import { receiptRenderOptions } from "./receipt-render-config.js";
import type { RealtimeHub } from "./realtime.js";

type Options = { database: PosDatabase; authRequired: boolean; printQueue?: { trigger(): void }; realtimeHub?: RealtimeHub };
const yen = (value: number) => `¥${value.toLocaleString("ja-JP")}`;
const actorId = (request: any, authRequired: boolean, actor: any) => authRequired ? actor.responsibleNumber : request.headers["x-pos-actor-id"] ?? "unsigned-operator";
const error = (reply: any, e: unknown) => {
  if (e instanceof CheckoutError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details } });
  if (e instanceof AuthError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: {} } });
  return reply.code(500).send({ error: { code: "SERVER_FEATURE_ERROR", message: "処理に失敗しました", details: {} } });
};

function enqueueDocument(db: PosDatabase, input: { transactionId: string; printerId: string; documentType: string; kind?: "original" | "reprint"; document: ReceiptDocument; payload: Record<string, unknown>; createdAt: string }): string {
  const canonicalIr = canonicalizeReceiptDocument(input.document); const bytes = receiptDocumentToEscPos(input.document, [], receiptRenderOptions()); const jobId = `print:${input.documentType}:${randomUUID()}`;
  createPrintJob(db, { jobId, transactionId: input.transactionId, printerId: input.printerId, documentType: input.documentType, kind: input.kind ?? "original", payload: { ...input.payload, document: input.document, canonicalIr, escposBase64: Buffer.from(bytes).toString("base64") }, createdAt: input.createdAt, source: "event-pos", rendererVersion: `${input.documentType}-v1`, bytesSha256: bytesSha256(bytes), canonicalIr, irSha256: bytesSha256(new TextEncoder().encode(canonicalIr)), expectedBytesLength: bytes.length });
  return jobId;
}

export function registerServerFeatureRoutes(app: FastifyInstance, options: Options): void {
  app.get<{ Params: { eventId: string } }>("/api/v1/events/:eventId/inventory", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "operator", options.authRequired);
      const rows = options.database.prepare(`SELECT json_extract(p.value,'$.productCode') AS product_code,
          json_extract(p.value,'$.inventory.openingQuantity') AS opening_quantity,
          COALESCE(m.quantity_delta,0) AS quantity_delta, COALESCE(b.reserved,0) AS reserved
        FROM event_catalogs c, json_each(c.catalog_json,'$.products') p
        LEFT JOIN (SELECT product_code,SUM(quantity_delta) quantity_delta FROM inventory_movements im JOIN event_products ep ON ep.product_id=im.product_id WHERE im.event_id=? GROUP BY product_code) m ON m.product_code=json_extract(p.value,'$.productCode')
        LEFT JOIN event_products ep ON ep.event_id=c.event_id AND ep.product_code=json_extract(p.value,'$.productCode')
        LEFT JOIN inventory_balances b ON b.event_id=c.event_id AND b.product_id=ep.product_id
        WHERE c.event_id=? ORDER BY product_code`).all(request.params.eventId, request.params.eventId) as Array<Record<string, unknown>>;
      return { products: rows.map((row) => {
        const tracked = row.opening_quantity !== null;
        if (!tracked) return { productCode: String(row.product_code), tracked: false, openingQuantity: null, remaining: null, reserved: null, available: null };
        const opening = Number(row.opening_quantity); const remaining = opening + Number(row.quantity_delta); const reserved = Number(row.reserved);
        return { productCode: String(row.product_code), tracked: true, openingQuantity: opening, remaining, reserved, available: remaining - reserved };
      }) };
    } catch (e) { return error(reply, e); }
  });

  app.post<{ Params: { eventId: string }; Body: { productCode?: unknown; newOnHand?: unknown; reason?: unknown } }>("/api/v1/events/:eventId/inventory/adjustments", async (request, reply) => {
    try {
      const auth = requireAuthActor(options.database, request, "manager", options.authRequired);
      const eventId = request.params.eventId; const body = request.body ?? {};
      if (typeof body.productCode !== "string" || !body.productCode) throw new CheckoutError(400, "INVENTORY_ADJUSTMENT_INVALID", "productCodeが必要です");
      const catalogRow = options.database.prepare("SELECT catalog_json FROM event_catalogs WHERE event_id=?").get(eventId) as { catalog_json: string } | undefined;
      const product = catalogRow ? importEventCatalog(catalogRow.catalog_json).products.find((item) => item.productCode === body.productCode) : undefined;
      if (!product) throw new CheckoutError(404, "PRODUCT_NOT_FOUND", "商品が見つかりません");
      const opening = product.inventory?.openingQuantity ?? null;
      if (opening === null) throw new CheckoutError(400, "INVENTORY_NOT_TRACKED", "在庫管理をしていない商品は調整できません");
      if (typeof body.newOnHand !== "number" || !Number.isSafeInteger(body.newOnHand) || body.newOnHand < 0) throw new CheckoutError(400, "INVENTORY_ADJUSTMENT_INVALID", "調整後の在庫数は0以上の整数で入力してください");
      if (typeof body.reason !== "string" || !body.reason.trim()) throw new CheckoutError(400, "INVENTORY_ADJUSTMENT_REASON_REQUIRED", "調整理由が必要です");
      const newOnHand = body.newOnHand; const reason = body.reason.trim(); const productId = `${eventId}:${product.productCode}`;
      const db = options.database; const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        const moved = db.prepare("SELECT COALESCE(SUM(quantity_delta),0) AS total FROM inventory_movements WHERE event_id=? AND product_id=?").get(eventId, productId) as { total: number };
        const before = opening + Number(moved.total); const delta = newOnHand - before;
        const balance = db.prepare("SELECT reserved FROM inventory_balances WHERE event_id=? AND product_id=?").get(eventId, productId) as { reserved: number } | undefined;
        const reserved = Number(balance?.reserved ?? 0);
        if (delta !== 0) {
          db.prepare("INSERT INTO inventory_movements (inventory_movement_id,event_id,product_id,type,quantity_delta,transaction_line_id,actor_id,created_at) VALUES (?,?,?,'adjustment',?,NULL,?,?)").run(uuidV7(), eventId, productId, delta, actorId(request, options.authRequired, auth), now);
          const updated = db.prepare("UPDATE inventory_balances SET on_hand=on_hand+?,version=version+1 WHERE event_id=? AND product_id=?").run(delta, eventId, productId);
          if (Number(updated.changes) === 0) db.prepare("INSERT INTO inventory_balances (event_id, product_id, on_hand, reserved, version) VALUES (?,?,?,0,1)").run(eventId, productId, newOnHand);
          db.prepare("INSERT INTO audit_log (event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'inventory_adjustment','product',?,?,?)").run(eventId, productId, JSON.stringify({ productCode: product.productCode, before, after: newOnHand, delta, reason }), now);
        }
        db.exec("COMMIT");
        return { productCode: product.productCode, tracked: true, openingQuantity: opening, remaining: newOnHand, reserved, available: newOnHand - reserved };
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    } catch (e) { return error(reply, e); }
  });

  app.post<{ Params: { transactionId: string }; Body: { payeeName?: string; memo?: string; terminalId: string } }>("/api/v1/transactions/:transactionId/official-receipts", async (request, reply) => {
    try {
      const auth = requireAuthActor(options.database, request, "operator", options.authRequired); const body = request.body ?? {};
      if (!body.terminalId) throw new CheckoutError(400, "RECEIPT_INPUT_INVALID", "terminalIdが必要です");
      const transaction = options.database.prepare("SELECT * FROM transactions WHERE transaction_id=? AND type='sale'").get(request.params.transactionId) as Record<string, unknown> | undefined;
      if (!transaction) throw new CheckoutError(404, "SALE_NOT_FOUND", "確定済み売上が見つかりません");
      const catalogRow = options.database.prepare("SELECT catalog_json FROM event_catalogs WHERE event_id=?").get(String(transaction.event_id)) as { catalog_json: string } | undefined;
      const catalog = catalogRow ? importEventCatalog(catalogRow.catalog_json) : undefined; const now = new Date().toISOString();
      const count = Number((options.database.prepare("SELECT COUNT(*) AS count FROM official_receipts WHERE transaction_id=?").get(request.params.transactionId) as { count: number }).count);
      const jst = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const taxes = options.database.prepare("SELECT tax_rate_bps,taxable_net_yen,tax_amount_yen FROM tax_summaries WHERE transaction_id=? ORDER BY tax_rate_bps DESC").all(request.params.transactionId) as Array<Record<string, unknown>>;
      const lines = options.database.prepare("SELECT product_name,quantity,net_yen FROM transaction_lines WHERE transaction_id=? ORDER BY line_no").all(request.params.transactionId) as Array<Record<string, unknown>>;
      const discounts = options.database.prepare("SELECT label_snapshot,amount_yen FROM applied_discounts WHERE transaction_id=? ORDER BY application_no").all(request.params.transactionId) as Array<Record<string, unknown>>;
      const issuer = catalog?.event?.seller?.circleName?.trim() || catalog?.event?.seller?.receiptIssuerName?.trim() || catalog?.event?.name?.trim() || String(transaction.event_id);
      const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes: [
        { kind: "reset" }, { kind: "align", value: "center" }, { kind: "emphasis", bold: true, underline: false, invert: false }, { kind: "text", value: "領収書" }, { kind: "emphasis", bold: false, underline: false, invert: false },
        ...(count ? [{ kind: "text" as const, value: "再発行" }] : []), { kind: "align", value: "left" }, { kind: "text", value: "宛名" }, { kind: "feed", lines: 3 }, { kind: "rule", style: "single" }, { kind: "feed", lines: 1 }, { kind: "text", value: "但し" }, { kind: "feed", lines: 2 }, { kind: "rule", style: "single" }, { kind: "feed", lines: 1 }, { kind: "text", value: `金額 ${yen(Number(transaction.total_yen))}` },
        ...taxes.map((tax) => ({ kind: "text" as const, value: `${Number(tax.tax_rate_bps) / 100}%対象 ${yen(Number(tax.taxable_net_yen))}（内消費税 ${yen(Number(tax.tax_amount_yen))}）` })), { kind: "text", value: `発行者 ${issuer}` }, { kind: "text", value: `発行日 ${jst}` }, { kind: "rule", style: "single" },
        ...lines.map((line) => ({ kind: "row" as const, left: String(line.product_name).slice(0, 18), right: `${Number(line.quantity)}点 ${yen(Number(line.net_yen))}` })),
        ...discounts.map((discount) => ({ kind: "row" as const, left: String(discount.label_snapshot), right: `-${yen(Number(discount.amount_yen))}` })),
        { kind: "row", left: "合計", right: yen(Number(transaction.total_yen)) }, { kind: "feed", lines: 6 }, { kind: "cut", mode: "partial" },
      ] };
      const receiptId = randomUUID(); const printJobId = enqueueDocument(options.database, { transactionId: request.params.transactionId, printerId: body.terminalId, documentType: "official_receipt", document, payload: { receiptId, payeeName: body.payeeName?.trim() ?? "", memo: body.memo?.trim() ?? "", amountYen: Number(transaction.total_yen), reissue: count > 0 }, createdAt: now });
      options.database.exec("BEGIN IMMEDIATE");
      try { options.database.prepare("INSERT INTO official_receipts(receipt_id,transaction_id,payee_name,memo,amount_yen,issued_by,terminal_id,print_job_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(receiptId, request.params.transactionId, body.payeeName?.trim() || null, body.memo?.trim() || null, Number(transaction.total_yen), actorId(request, options.authRequired, auth), body.terminalId, printJobId, now); options.database.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'official_receipt_issued','official_receipt',?,?,?)").run(String(transaction.event_id), receiptId, JSON.stringify({ transactionId: request.params.transactionId, printJobId, issuedBy: actorId(request, options.authRequired, auth), reissue: count > 0 }), now); options.database.exec("COMMIT");
      } catch (e) { options.database.exec("ROLLBACK"); throw e; }
      options.printQueue?.trigger(); return reply.code(201).send({ receiptId, printJobId, amountYen: Number(transaction.total_yen) });
    } catch (e) { return error(reply, e); }
  });

  app.post<{ Params: { draftId: string }; Body: { terminalId: string } }>("/api/v1/sale-drafts/:draftId/park", async (request, reply) => {
    try { const auth = requireAuthActor(options.database, request, "operator", options.authRequired); const draft = getSaleDraft(options.database, request.params.draftId); if (!request.body?.terminalId) throw new CheckoutError(400, "PARK_INPUT_INVALID", "terminalIdが必要です"); if (!draft.lines.some((line) => line.status === "active")) throw new CheckoutError(400, "PARK_EMPTY", "明細がない会計は保留できません"); if (!options.database.prepare("SELECT 1 FROM sale_drafts WHERE draft_id=? AND state IN ('editing','payment')").get(draft.draftId)) throw new CheckoutError(409, "DRAFT_NOT_EDITABLE", "この販売ドラフトは保留できません"); const register = assertRegisterOpen(options.database, draft.eventId, draft.registerId); const reference = allocatePublicReference(options.database, draft.eventId, register.businessDate, register.sessionNo); const now = new Date().toISOString();
      const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes: [{ kind: "reset" }, { kind: "align", value: "center" }, { kind: "emphasis", bold: true, underline: false, invert: false }, { kind: "text", value: "保留レシート" }, { kind: "emphasis", bold: false, underline: false, invert: false }, { kind: "barcode", value: `{BPS13${reference.raw}`, width: 3, height: 96, hri: "below" }, { kind: "align", value: "left" }, { kind: "text", value: `受付番号 ${reference.display}` }, ...draft.lines.filter((line) => line.status === "active").map((line) => ({ kind: "row" as const, left: line.name.slice(0, 18), right: `${line.quantity}点` })), { kind: "text", value: `合計 ${yen(draft.calculation.totalYen)}` }, { kind: "text", value: `作成 ${formatJstDateTime(now)}` }, { kind: "text", value: "精算のときにこのレシートをスキャンすると会計を呼び戻せます" }, { kind: "feed", lines: 5 }, { kind: "cut", mode: "partial" }] };
      const printJobId = enqueueDocument(options.database, { transactionId: `park:${draft.draftId}`, printerId: request.body.terminalId, documentType: "park_ticket", document, payload: { draftId: draft.draftId, parkReference: reference.raw, parkReferenceDisplay: reference.display }, createdAt: now });
      let parkedDraft: ReturnType<typeof updateProjection>;
      options.database.exec("BEGIN IMMEDIATE");
      try {
        options.database.prepare("UPDATE sale_drafts SET state='parked',park_reference=?,parked_at=?,version=version+1,updated_at=? WHERE draft_id=?").run(reference.raw, now, now, draft.draftId);
        parkedDraft = updateProjection(options.database, draft.draftId);
        options.database.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'sale_draft_parked','sale_draft',?,?,?)").run(draft.eventId, draft.draftId, JSON.stringify({ parkReference: reference.raw, printJobId, actorId: actorId(request, options.authRequired, auth), terminalId: request.body.terminalId }), now);
        options.database.exec("COMMIT");
      } catch (e) { options.database.exec("ROLLBACK"); throw e; }
      options.printQueue?.trigger();
      notifyDraft(options, parkedDraft);
      return reply.code(201).send({ draftId: draft.draftId, parkReference: reference.raw, parkReferenceDisplay: reference.display, printJobId });
    } catch (e) { return error(reply, e); }
  });

  app.get<{ Params: { registerId: string }; Querystring: { eventId?: string } }>("/api/v1/registers/:registerId/parked-drafts", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired); if (!request.query.eventId) throw new CheckoutError(400, "EVENT_ID_REQUIRED", "eventIdが必要です"); const session = assertRegisterOpen(options.database, request.query.eventId, request.params.registerId); const rows = options.database.prepare("SELECT draft_id,park_reference,parked_at FROM sale_drafts WHERE event_id=? AND register_id=? AND cash_session_id=? AND state='parked' ORDER BY parked_at").all(request.query.eventId, request.params.registerId, session.cashSessionId) as Array<Record<string, unknown>>; return rows.map((row) => { const draft = getSaleDraft(options.database, String(row.draft_id)); return { draftId: draft.draftId, parkReference: String(row.park_reference), parkReferenceDisplay: formatPublicReference(String(row.park_reference)), createdAt: String(row.parked_at), lineCount: draft.lines.filter((line) => line.status === "active").length, totalYen: draft.calculation.totalYen }; }); } catch (e) { return error(reply, e); }
  });

  app.post<{ Params: { registerId: string }; Body: { parkReference: string; terminalId: string } }>("/api/v1/registers/:registerId/parked-drafts/resume", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "operator", options.authRequired); if (!request.body?.parkReference || !request.body?.terminalId) throw new CheckoutError(400, "PARK_INPUT_INVALID", "parkReferenceとterminalIdが必要です"); const parked = options.database.prepare("SELECT * FROM sale_drafts WHERE register_id=? AND park_reference=? AND state='parked'").get(request.params.registerId, request.body.parkReference) as Record<string, unknown> | undefined; if (!parked) throw new CheckoutError(404, "PARK_NOT_FOUND", "保留会計が見つかりません"); const session = assertRegisterOpen(options.database, String(parked.event_id), request.params.registerId); if (parked.cash_session_id !== session.cashSessionId) throw new CheckoutError(404, "PARK_NOT_FOUND", "保留会計が見つかりません"); const active = options.database.prepare("SELECT d.* FROM sale_drafts d WHERE d.register_id=? AND d.cash_session_id=? AND d.state IN ('editing','payment','finalizing') LIMIT 1").get(request.params.registerId, session.cashSessionId) as Record<string, unknown> | undefined; if (active && (options.database.prepare("SELECT 1 FROM sale_draft_lines WHERE draft_id=? AND status='active' LIMIT 1").get(String(active.draft_id)) || options.database.prepare("SELECT 1 FROM draft_payments WHERE draft_id=? LIMIT 1").get(String(active.draft_id)))) throw new CheckoutError(409, "PARK_RESUME_BLOCKED", "現在の会計に明細または支払いがあるため呼び戻せません");
      const now = new Date().toISOString();
      const parkedDraftId = String(parked.draft_id);
      let resumedDraft: ReturnType<typeof updateProjection>;
      options.database.exec("BEGIN IMMEDIATE");
      try {
        if (active) {
          const draftId = String(active.draft_id);
          options.database.prepare("UPDATE sale_drafts SET state='canceled',version=version+1,updated_at=? WHERE draft_id=?").run(now, draftId);
          restoreHoldsForCanceledDraft(options.database, draftId, String(active.event_id));
        }
        options.database.prepare("UPDATE sale_drafts SET state='editing',park_reference=NULL,parked_at=NULL,version=version+1,updated_at=? WHERE draft_id=?").run(now, parkedDraftId);
        resumedDraft = updateProjection(options.database, parkedDraftId);
        options.database.exec("COMMIT");
      } catch (e) { options.database.exec("ROLLBACK"); throw e; }
      notifyDraft(options, resumedDraft);
      return resumedDraft;
    } catch (e) { return error(reply, e); }
  });
}
