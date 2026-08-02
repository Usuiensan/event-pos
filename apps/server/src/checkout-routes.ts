import type { FastifyInstance, FastifyReply } from "fastify";
import type { ManualDiscountInput } from "@event-pos/contracts";
import { type PosDatabase } from "./db.js";
import {
  addAgeVerification,
  addDraftBundle,
  addDraftLine,
  addDraftPayment,
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

type PrintQueue = { trigger(): void };
export type CheckoutRouteOptions = { database: PosDatabase; printQueue?: PrintQueue; checkoutFailureInjector?: FailureInjector; realtimeHub?: RealtimeHub };

function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function ifMatch(headers: Record<string, string | string[] | undefined>): number {
  const raw = headerValue(headers["if-match"])?.replace(/^W\//, "").replace(/^"|"$/g, "");
  const version = Number(raw);
  if (!raw || !Number.isSafeInteger(version) || version < 1) throw new CheckoutError(428, "IF_MATCH_REQUIRED", "If-Matchに販売ドラフトのversionが必要です");
  return version;
}

function sendError(reply: FastifyReply, error: unknown, database?: PosDatabase, draftId?: string): unknown {
  if (error instanceof CheckoutError) {
    let details = error.details;
    if (error.code === "DRAFT_VERSION_CONFLICT" && database && draftId) {
      try { details = { ...details, latest: getSaleDraft(database, draftId) }; } catch { /* 元の競合エラーを返す */ }
    }
    return reply.code(error.status).send({ error: { code: error.code, message: error.message, details, requestId: reply.request.id } });
  }
  return reply.code(500).send({ error: { code: "CHECKOUT_INTERNAL_ERROR", message: "会計処理中に問題が発生しました。会計は確定していないため、画面を閉じずに責任者へ連絡してください。", details: {}, requestId: reply.request.id } });
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function notifyDraft(options: CheckoutRouteOptions, draft: ReturnType<typeof getSaleDraft>): void {
  options.realtimeHub?.notify({ type: "sale-draft.changed", registerId: draft.registerId, version: draft.version });
  const projectionVersion = getCustomerDisplayVersion(options.database, draft.registerId);
  if (projectionVersion !== undefined) options.realtimeHub?.notify({ type: "customer-display.changed", registerId: draft.registerId, version: projectionVersion });
}

function draftReply(reply: FastifyReply, draft: ReturnType<typeof getSaleDraft>): ReturnType<typeof getSaleDraft> {
  reply.header("etag", `"draft:${draft.draftId}:${draft.version}"`).header("cache-control", "no-store");
  return draft;
}

export function registerCheckoutRoutes(app: FastifyInstance, options: CheckoutRouteOptions): void {
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
    try { const draft = createSaleDraft(options.database, { ...request.body, registerId: request.params.registerId, terminalId: request.body.terminalId ?? request.params.registerId }); notifyDraft(options, draft); reply.header("etag", `"draft:${draft.draftId}:${draft.version}"`); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { draftId: string } }>("/api/v1/sale-drafts/:draftId", async (request, reply) => {
    try { return draftReply(reply, getSaleDraft(options.database, request.params.draftId)); } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { draftId: string }; Body: { productCode: string; quantity?: number; source?: "manual" | "scan"; productOptions?: Record<string, unknown> } }>("/api/v1/sale-drafts/:draftId/lines", async (request, reply) => {
    try { const draft = addDraftLine(options.database, request.params.draftId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { bundleId: string } }>("/api/v1/sale-drafts/:draftId/bundles", async (request, reply) => {
    try { const draft = addDraftBundle(options.database, request.params.draftId, ifMatch(request.headers), request.body.bundleId); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.patch<{ Params: { draftId: string; lineId: string }; Body: { quantity?: number; manualDiscount?: ManualDiscountInput | null } }>("/api/v1/sale-drafts/:draftId/lines/:lineId", async (request, reply) => {
    try { const draft = updateDraftLine(options.database, request.params.draftId, request.params.lineId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string; lineId: string } }>("/api/v1/sale-drafts/:draftId/lines/:lineId", async (request, reply) => {
    try { const draft = cancelDraftLine(options.database, request.params.draftId, request.params.lineId, ifMatch(request.headers)); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { kind: PaymentKind; amountYen?: number; tenderedYen?: number; referenceNote?: string } }>("/api/v1/sale-drafts/:draftId/payments", async (request, reply) => {
    try { const draft = addDraftPayment(options.database, request.params.draftId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string; paymentId: string } }>("/api/v1/sale-drafts/:draftId/payments/:paymentId", async (request, reply) => {
    try { const draft = removeDraftPayment(options.database, request.params.draftId, request.params.paymentId, ifMatch(request.headers)); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { minimumAge: 18 | 20; method: "appearance" | "id_visual" | "self_declaration"; result: "passed" | "failed"; confirmerId?: string; terminalId: string } }>("/api/v1/sale-drafts/:draftId/age-verifications", async (request, reply) => {
    if (!hasOnlyKeys(request.body, ["minimumAge", "method", "result", "confirmerId", "terminalId"])) return sendError(reply, new CheckoutError(400, "INVALID_AGE_VERIFICATION", "年齢確認には個人情報や未定義項目を送信できません"));
    try { const draft = addAgeVerification(options.database, request.params.draftId, ifMatch(request.headers), request.body); notifyDraft(options, draft); return reply.code(201).send(draft); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string } }>("/api/v1/sale-drafts/:draftId", async (request, reply) => {
    try { const draft = cancelSaleDraft(options.database, request.params.draftId, ifMatch(request.headers)); notifyDraft(options, draft); return draft; }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { version: number } }>("/api/v1/sale-drafts/:draftId/finalize", async (request, reply) => {
    const key = headerValue(request.headers["idempotency-key"]);
    try {
      const result = finalizeSale(options.database, request.params.draftId, request.body?.version, key ?? "", options.checkoutFailureInjector);
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
    if (!projection) return sendError(reply, new CheckoutError(404, "CUSTOMER_DISPLAY_STATE_NOT_FOUND", "顧客画面の状態が見つかりません"));
    reply.header("etag", `"customer-display:${registerId}:${String(projection.version)}"`).header("cache-control", "no-store");
    return projection;
  });
}
