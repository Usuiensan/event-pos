import type { FastifyInstance, FastifyReply } from "fastify";
import type { ManualDiscountInput } from "@event-pos/contracts";
import { type PosDatabase } from "./db.js";
import {
  addAgeVerification,
  addDraftBundle,
  addDraftLine,
  addUnregisteredDraftLine,
  addPeriodicalDraftLine,
  addDraftPayment,
  claimHoldToDraft,
  cancelDraftLine,
  cancelSaleDraft,
  CheckoutError,
  createSaleDraft,
  finalizeSale,
  getCustomerDisplayProjection,
  getCustomerDisplayVersion,
  getRegisterSaleDraft,
  getSaleDraft,
  getTransactionSnapshot,
  removeDraftPayment,
  updateDraftLine,
  type FailureInjector,
  type PaymentKind,
} from "./checkout-store.js";
import type { RealtimeHub } from "./realtime.js";
import { createFullReturn, createManualRefund, searchReturnableTransactions } from "./returns.js";
import { AuthError, requireAuthActor } from "./auth.js";
import { assertRegisterOpen } from "./business-store.js";
import { carryHold, createHold, findHold, releaseHold, reprintHoldTicket, requestHoldCarryover } from "./holds.js";

type PrintQueue = { trigger(): void };
export type CheckoutRouteOptions = { database: PosDatabase; printQueue?: PrintQueue; checkoutFailureInjector?: FailureInjector; realtimeHub?: RealtimeHub; drawerEnabled?: boolean; authRequired?: boolean };

function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function ifMatch(headers: Record<string, string | string[] | undefined>): number {
  const raw = headerValue(headers["if-match"])?.replace(/^W\//, "").replace(/^"|"$/g, "");
  const version = Number(raw);
  if (!raw || !Number.isSafeInteger(version) || version < 1) throw new CheckoutError(428, "IF_MATCH_REQUIRED", "If-Matchに販売ドラフトのversionが必要です");
  return version;
}

function sendError(reply: FastifyReply, error: unknown, database?: PosDatabase, draftId?: string): unknown {
  if (error instanceof AuthError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: {}, requestId: reply.request.id } });
  if (error instanceof CheckoutError) {
    let details = error.details;
    if (error.code === "DRAFT_VERSION_CONFLICT" && database && draftId) {
      try { details = { ...details, latest: getSaleDraft(database, draftId) }; } catch { /* 元の競合エラーを返す */ }
    }
    return reply.code(error.status).send({ error: { code: error.code, message: error.message, details, requestId: reply.request.id } });
  }
  reply.log.error({ err: error, requestId: reply.request.id, draftId }, "CHECKOUT_INTERNAL_ERROR");
  return reply.code(500).send({ error: { code: "CHECKOUT_INTERNAL_ERROR", message: "会計処理中に問題が発生しました。会計は確定していないため、画面を閉じずに責任者へ連絡してください。", details: {}, requestId: reply.request.id } });
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}

export function notifyDraft(options: Pick<CheckoutRouteOptions, "database" | "realtimeHub">, draft: ReturnType<typeof getSaleDraft>): void {
  options.realtimeHub?.notify({ type: "sale-draft.changed", registerId: draft.registerId, version: draft.version });
  const projectionVersion = getCustomerDisplayVersion(options.database, draft.registerId);
  if (projectionVersion !== undefined) options.realtimeHub?.notify({ type: "customer-display.changed", registerId: draft.registerId, version: projectionVersion });
}

function draftReply(reply: FastifyReply, draft: ReturnType<typeof getSaleDraft>): ReturnType<typeof getSaleDraft> {
  reply.header("etag", `"draft:${draft.draftId}:${draft.version}"`).header("cache-control", "no-store");
  return draft;
}

export function registerCheckoutRoutes(app: FastifyInstance, options: CheckoutRouteOptions): void {
  app.post<{ Body: { eventId?: string; registerId?: string; terminalId?: string; lines?: Array<{ productCode: string; quantity: number }>; allowShortage?: boolean } }>("/api/v1/holds", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const eventId = request.body?.eventId ?? actor.eventId; const registerId = request.body?.registerId ?? "";
      const state = assertRegisterOpen(options.database, eventId, registerId);
      const result = createHold(options.database, { eventId, businessDate: state.businessDate, sessionNo: state.sessionNo, businessSessionId: state.businessSessionId, actorId: options.authRequired ? actor.responsibleNumber : headerValue(request.headers["x-pos-actor-id"]) ?? "unsigned-operator", terminalId: request.body?.terminalId ?? registerId, lines: request.body?.lines ?? [], allowShortage: !!request.body?.allowShortage });
      options.printQueue?.trigger(); return reply.code(201).send(result);
    } catch (error) { return sendError(reply, error); }
  });
  app.get<{ Querystring: { eventId?: string; reference?: string } }>("/api/v1/holds/find", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); if (!request.query.eventId || !request.query.reference) throw new CheckoutError(400,"HOLD_QUERY_REQUIRED","eventIdと取り置き番号が必要です"); const hold = findHold(options.database,request.query.eventId,request.query.reference); return hold ?? sendError(reply,new CheckoutError(404,"HOLD_NOT_FOUND","取り置きが見つかりません")); } catch(error) { return sendError(reply,error); }
  });
  app.post<{ Params: { holdId: string }; Body: { draftId?: string; version?: number } }>("/api/v1/holds/:holdId/claim", async (request, reply) => {
    try { requireAuthActor(options.database,request,"operator",options.authRequired ?? false); const draftId=request.body?.draftId; const version=Number(request.body?.version); if (!draftId || !Number.isSafeInteger(version)) throw new CheckoutError(400,"HOLD_CLAIM_INPUT_INVALID","販売ドラフトとversionが必要です"); const draft=claimHoldToDraft(options.database,request.params.holdId,draftId,version); notifyDraft(options,draft); return reply.code(200).send(draft); } catch(error) { return sendError(reply,error,options.database,request.body?.draftId); }
  });
  app.post<{ Params: { holdId: string }; Body: { reason?: string } }>("/api/v1/holds/:holdId/release", async (request, reply) => {
    try { const actor=requireAuthActor(options.database,request,"manager",options.authRequired ?? false); return releaseHold(options.database,request.params.holdId,options.authRequired?actor.responsibleNumber:headerValue(request.headers["x-pos-actor-id"])??"unsigned-manager",request.body?.reason??""); } catch(error) { return sendError(reply,error); }
  });
  app.post<{ Params:{holdId:string}; Body:{terminalId?:string;reason?:string} }>("/api/v1/holds/:holdId/reprint",async(request,reply)=>{try{const actor=requireAuthActor(options.database,request,"operator",options.authRequired??false);const result=reprintHoldTicket(options.database,request.params.holdId,options.authRequired?actor.responsibleNumber:"operator",request.body?.terminalId??actor.terminalId,request.body?.reason??"");options.printQueue?.trigger();return reply.code(201).send(result);}catch(error){return sendError(reply,error);}});
  app.post<{ Params:{holdId:string}; Body:{businessSessionId?:string;terminalId?:string} }>("/api/v1/holds/:holdId/carry",async(request,reply)=>{try{const actor=requireAuthActor(options.database,request,"manager",options.authRequired??false);if(!request.body?.businessSessionId)throw new CheckoutError(400,"HOLD_CARRY_INPUT_INVALID","繰越先営業が必要です");return carryHold(options.database,request.params.holdId,request.body.businessSessionId,options.authRequired?actor.responsibleNumber:"manager",request.body.terminalId??actor.terminalId);}catch(error){return sendError(reply,error);}});
  app.post<{ Params:{holdId:string}; Body:{terminalId?:string} }>("/api/v1/holds/:holdId/carry-request",async(request,reply)=>{try{const actor=requireAuthActor(options.database,request,"manager",options.authRequired??false);return requestHoldCarryover(options.database,request.params.holdId,options.authRequired?actor.responsibleNumber:"manager",request.body?.terminalId??actor.terminalId);}catch(error){return sendError(reply,error);}});
  app.get<{ Querystring: { eventId?: string; query?: string } }>("/api/v1/transactions/returnable", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "operator", options.authRequired ?? false);
      if (!request.query.eventId || !request.query.query?.trim()) throw new CheckoutError(400, "RETURN_QUERY_REQUIRED", "eventIdと検索語が必要です");
      if (options.authRequired && actor.eventId !== request.query.eventId) throw new AuthError(403, "FORBIDDEN", "このイベントの取引を検索する権限がありません");
      return { transactions: searchReturnableTransactions(options.database, request.query.eventId, request.query.query) };
    } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { transactionId: string }; Body: { cashSessionId?: string; terminalId?: string; reason?: string; externalResults?: Record<string, "completed" | "failed" | "unknown"> } }>("/api/v1/transactions/:transactionId/full-return", async (request, reply) => {
    let actor; try { actor = requireAuthActor(options.database, request, "operator", options.authRequired ?? false); } catch (error) { return sendError(reply, error); }
    const actorId = options.authRequired ? actor.responsibleNumber : headerValue(request.headers["x-pos-actor-id"]) ?? "unsigned-operator"; const key = headerValue(request.headers["idempotency-key"]);
    try { const result = createFullReturn(options.database, { originalTransactionId: request.params.transactionId, cashSessionId: request.body?.cashSessionId ?? "", actorId, terminalId: request.body?.terminalId ?? "", reason: request.body?.reason ?? "", idempotencyKey: key ?? "", ...(request.body?.externalResults ? { externalResults: request.body.externalResults } : {}) }); options.printQueue?.trigger(); return reply.code(201).send(result); }
    catch (error) { return sendError(reply, error instanceof CheckoutError ? error : new CheckoutError(500, "RETURN_FAILED", error instanceof Error ? error.message : "返品処理に失敗しました")); }
  });
  app.post<{ Body: { eventId?: string; cashSessionId?: string; terminalId?: string; description?: string; amountYen?: number; productCode?: string; quantity?: number; confirmWithoutProductCode?: boolean; paymentKind?: "cash" | "credit" | "accounts_receivable"; reason?: string } }>("/api/v1/refunds/manual", async (request, reply) => {
    let actor; try { actor = requireAuthActor(options.database, request, "operator", options.authRequired ?? false); } catch (error) { return sendError(reply, error); }
    const actorId = options.authRequired ? actor.responsibleNumber : headerValue(request.headers["x-pos-actor-id"]) ?? "unsigned-operator"; const key = headerValue(request.headers["idempotency-key"]);
    try { const result = createManualRefund(options.database, { eventId: request.body?.eventId ?? "", cashSessionId: request.body?.cashSessionId ?? "", actorId, terminalId: request.body?.terminalId ?? "", description: request.body?.description ?? "", amountYen: Number(request.body?.amountYen), ...(request.body?.productCode ? { productCode: request.body.productCode } : {}), ...(request.body?.quantity ? { quantity: request.body.quantity } : {}), ...(request.body?.reason ? { reason: request.body.reason } : {}), ...(request.body?.confirmWithoutProductCode === true ? { confirmWithoutProductCode: true } : {}), paymentKind: request.body?.paymentKind ?? "cash", idempotencyKey: key ?? "" }); options.printQueue?.trigger(); return reply.code(201).send(result); }
    catch (error) { return sendError(reply, error instanceof CheckoutError ? error : new CheckoutError(500, "MANUAL_REFUND_FAILED", error instanceof Error ? error.message : "例外返金に失敗しました")); }
  });
  app.get<{ Querystring: { eventId?: string; code?: string } }>("/api/v1/products", async (request, reply) => {
    if (!request.query.eventId || !request.query.code) return sendError(reply, new CheckoutError(400, "PRODUCT_QUERY_REQUIRED", "eventIdとcodeが必要です"));
    const row = options.database.prepare("SELECT product_code AS productCode,name,price_incl_tax AS priceInclTax,price_excl_tax AS priceExclTax,tax_rate_bps AS taxRateBps,tax_category AS taxCategory,age_requirement AS ageRequirement,sale_state AS saleState FROM event_products WHERE event_id=? AND product_code=?").get(request.query.eventId, request.query.code);
    return row ?? sendError(reply, new CheckoutError(404, "PRODUCT_NOT_FOUND", "商品コードが見つかりません"));
  });

  app.get<{ Params: { registerId: string } }>("/api/v1/registers/:registerId/sale-draft", async (request, reply) => {
    const draft = getRegisterSaleDraft(options.database, request.params.registerId);
    return draft ? draftReply(reply, draft) : sendError(reply, new CheckoutError(404, "DRAFT_NOT_FOUND", "販売ドラフトが見つかりません"));
  });

  app.post<{ Params: { registerId: string }; Body: { eventId: string; staffId: string; terminalId?: string; businessDate: string; sessionNo?: number } }>("/api/v1/registers/:registerId/sale-drafts", async (request, reply) => {
    try { const actor = requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = createSaleDraft(options.database, { ...request.body, ...(options.authRequired ? { staffId: actor.responsibleNumber } : {}), registerId: request.params.registerId, terminalId: request.body.terminalId ?? request.params.registerId }); notifyDraft(options, draft); reply.header("etag", `"draft:${draft.draftId}:${draft.version}"`); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { draftId: string } }>("/api/v1/sale-drafts/:draftId", async (request, reply) => {
    try { return draftReply(reply, getSaleDraft(options.database, request.params.draftId)); } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { draftId: string }; Body: { productCode: string; quantity?: number; source?: "manual" | "scan"; productOptions?: Record<string, unknown> } }>("/api/v1/sale-drafts/:draftId/lines", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = addDraftLine(options.database, request.params.draftId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });
  app.post<{ Params: { draftId: string }; Body: { productCode?: string; priceInclTax?: number; taxRate?: number } }>("/api/v1/sale-drafts/:draftId/unregistered-lines", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "operator", options.authRequired ?? false);
      const taxRate = Number(request.body?.taxRate);
      const draft = addUnregisteredDraftLine(options.database, request.params.draftId, ifMatch(request.headers), { productCode: request.body?.productCode ?? "", priceInclTax: Number(request.body?.priceInclTax), taxRate: taxRate as 0 | 8 | 10, actorId: options.authRequired ? actor.responsibleNumber : headerValue(request.headers["x-pos-actor-id"]) ?? "unsigned-operator" });
      notifyDraft(options, draft); return reply.code(201).send(draft);
    } catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });
  app.post<{ Params: { draftId: string }; Body: { code?: string } }>("/api/v1/sale-drafts/:draftId/periodicals", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = addPeriodicalDraftLine(options.database, request.params.draftId, ifMatch(request.headers), request.body?.code ?? ""); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { bundleId: string } }>("/api/v1/sale-drafts/:draftId/bundles", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = addDraftBundle(options.database, request.params.draftId, ifMatch(request.headers), request.body.bundleId); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.patch<{ Params: { draftId: string; lineId: string }; Body: { quantity?: number; manualDiscount?: ManualDiscountInput | null } }>("/api/v1/sale-drafts/:draftId/lines/:lineId", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = updateDraftLine(options.database, request.params.draftId, request.params.lineId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string; lineId: string } }>("/api/v1/sale-drafts/:draftId/lines/:lineId", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = cancelDraftLine(options.database, request.params.draftId, request.params.lineId, ifMatch(request.headers)); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { kind: PaymentKind; amountYen?: number; tenderedYen?: number; referenceNote?: string } }>("/api/v1/sale-drafts/:draftId/payments", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = addDraftPayment(options.database, request.params.draftId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string; paymentId: string } }>("/api/v1/sale-drafts/:draftId/payments/:paymentId", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = removeDraftPayment(options.database, request.params.draftId, request.params.paymentId, ifMatch(request.headers)); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { minimumAge: 18 | 20; method: "appearance" | "id_visual" | "self_declaration"; result: "passed" | "failed"; confirmerId?: string; terminalId: string } }>("/api/v1/sale-drafts/:draftId/age-verifications", async (request, reply) => {
    if (!hasOnlyKeys(request.body, ["minimumAge", "method", "result", "confirmerId", "terminalId"])) return sendError(reply, new CheckoutError(400, "INVALID_AGE_VERIFICATION", "年齢確認には個人情報や未定義項目を送信できません"));
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = addAgeVerification(options.database, request.params.draftId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string } }>("/api/v1/sale-drafts/:draftId", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired ?? false); const draft = cancelSaleDraft(options.database, request.params.draftId, ifMatch(request.headers)); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { version: number } }>("/api/v1/sale-drafts/:draftId/finalize", async (request, reply) => {
    const key = headerValue(request.headers["idempotency-key"]);
    try {
      requireAuthActor(options.database, request, "operator", options.authRequired ?? false);
      const result = finalizeSale(options.database, request.params.draftId, request.body?.version, key ?? "", options.checkoutFailureInjector, options.drawerEnabled ?? false);
      const completedDraft = getSaleDraft(options.database, request.params.draftId);
      notifyDraft(options, completedDraft);
      options.realtimeHub?.notify({ type: "transaction.finalized", registerId: completedDraft.registerId, transactionId: result.transactionId });
      options.printQueue?.trigger();
      return reply.code(201).send(result);
    } catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.get<{ Params: { transactionId: string } }>("/api/v1/transactions/:transactionId", async (request, reply) => {
    const transaction = getTransactionSnapshot(options.database, request.params.transactionId);
    if (!transaction) return sendError(reply, new CheckoutError(404, "TRANSACTION_NOT_FOUND", "取引が見つかりません"));
    reply.header("etag", `"transaction:${request.params.transactionId}"`).header("cache-control", "no-store");
    return transaction;
  });

  app.get<{ Params: { terminalId: string }; Querystring: { registerId?: string } }>("/api/v1/customer-displays/:terminalId", async (request, reply) => {
    const registerId = request.query.registerId ?? request.params.terminalId;
    const projection = getCustomerDisplayProjection(options.database, registerId);
    if (!projection) return { registerId, draftId: `customer-display:${registerId}`, version: 0, draftVersion: 0, state: "editing", lines: [], discounts: [], totals: { subtotalYen: 0, discountYen: 0, taxYen: 0, totalYen: 0 }, payment: { state: "waiting", kinds: [] } };
    reply.header("etag", `"customer-display:${registerId}:${String(projection.version)}"`).header("cache-control", "no-store");
    return projection;
  });
}
