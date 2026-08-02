import type { FastifyInstance, FastifyReply } from "fastify";
import type { ManualDiscountInput } from "@event-pos/contracts";
import { getPrintJob, updatePrintJob, type PosDatabase } from "./db.js";
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
  getRegisterSaleDraft,
  getSaleDraft,
  getTransactionSnapshot,
  removeDraftPayment,
  updateDraftLine,
  type FailureInjector,
  type PaymentKind,
} from "./checkout-store.js";

type PrinterHost = { accept(job: NonNullable<ReturnType<typeof getPrintJob>>): Promise<void> };
export type CheckoutRouteOptions = { database: PosDatabase; printerHost?: PrinterHost; checkoutFailureInjector?: FailureInjector };

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
  const message = error instanceof Error ? error.message : "会計処理に失敗しました";
  return reply.code(500).send({ error: { code: "CHECKOUT_INTERNAL_ERROR", message, details: {}, requestId: reply.request.id } });
}

function hasOnlyKeys(value: unknown, allowed: readonly string[]): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}

export function registerCheckoutRoutes(app: FastifyInstance, options: CheckoutRouteOptions): void {
  app.get<{ Querystring: { eventId?: string; code?: string } }>("/api/v1/products", async (request, reply) => {
    if (!request.query.eventId || !request.query.code) return sendError(reply, new CheckoutError(400, "PRODUCT_QUERY_REQUIRED", "eventIdとcodeが必要です"));
    const row = options.database.prepare("SELECT product_code AS productCode,name,price_incl_tax AS priceInclTax,price_excl_tax AS priceExclTax,tax_rate_bps AS taxRateBps,tax_category AS taxCategory,age_requirement AS ageRequirement,sale_state AS saleState FROM event_products WHERE event_id=? AND product_code=?").get(request.query.eventId, request.query.code);
    return row ?? sendError(reply, new CheckoutError(404, "PRODUCT_NOT_FOUND", "商品コードが見つかりません"));
  });

  app.get<{ Params: { registerId: string } }>("/api/v1/registers/:registerId/sale-draft", async (request, reply) => {
    const draft = getRegisterSaleDraft(options.database, request.params.registerId);
    return draft ?? sendError(reply, new CheckoutError(404, "DRAFT_NOT_FOUND", "販売ドラフトが見つかりません"));
  });

  app.post<{ Params: { registerId: string }; Body: { eventId: string; staffId: string; terminalId?: string; businessDate: string; sessionNo?: number } }>("/api/v1/registers/:registerId/sale-drafts", async (request, reply) => {
    try { return reply.code(201).send(createSaleDraft(options.database, { ...request.body, registerId: request.params.registerId, terminalId: request.body.terminalId ?? request.params.registerId })); }
    catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { draftId: string } }>("/api/v1/sale-drafts/:draftId", async (request, reply) => {
    try { return getSaleDraft(options.database, request.params.draftId); } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { draftId: string }; Body: { productCode: string; quantity?: number; source?: "manual" | "scan" } }>("/api/v1/sale-drafts/:draftId/lines", async (request, reply) => {
    try { return reply.code(201).send(addDraftLine(options.database, request.params.draftId, ifMatch(request.headers), request.body)); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { bundleId: string } }>("/api/v1/sale-drafts/:draftId/bundles", async (request, reply) => {
    try { return reply.code(201).send(addDraftBundle(options.database, request.params.draftId, ifMatch(request.headers), request.body.bundleId)); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.patch<{ Params: { draftId: string; lineId: string }; Body: { quantity?: number; manualDiscount?: ManualDiscountInput | null } }>("/api/v1/sale-drafts/:draftId/lines/:lineId", async (request, reply) => {
    try { return updateDraftLine(options.database, request.params.draftId, request.params.lineId, ifMatch(request.headers), request.body); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string; lineId: string } }>("/api/v1/sale-drafts/:draftId/lines/:lineId", async (request, reply) => {
    try { return cancelDraftLine(options.database, request.params.draftId, request.params.lineId, ifMatch(request.headers)); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { kind: PaymentKind; amountYen?: number; tenderedYen?: number; referenceNote?: string } }>("/api/v1/sale-drafts/:draftId/payments", async (request, reply) => {
    try { return reply.code(201).send(addDraftPayment(options.database, request.params.draftId, ifMatch(request.headers), request.body)); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string; paymentId: string } }>("/api/v1/sale-drafts/:draftId/payments/:paymentId", async (request, reply) => {
    try { return removeDraftPayment(options.database, request.params.draftId, request.params.paymentId, ifMatch(request.headers)); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { minimumAge: 18 | 20; method: "appearance" | "id_visual" | "self_declaration"; result: "passed" | "failed"; confirmerId?: string; terminalId: string } }>("/api/v1/sale-drafts/:draftId/age-verifications", async (request, reply) => {
    if (!hasOnlyKeys(request.body, ["minimumAge", "method", "result", "confirmerId", "terminalId"])) return sendError(reply, new CheckoutError(400, "INVALID_AGE_VERIFICATION", "年齢確認には個人情報や未定義項目を送信できません"));
    try { return reply.code(201).send(addAgeVerification(options.database, request.params.draftId, ifMatch(request.headers), request.body)); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.delete<{ Params: { draftId: string } }>("/api/v1/sale-drafts/:draftId", async (request, reply) => {
    try { return cancelSaleDraft(options.database, request.params.draftId, ifMatch(request.headers)); }
    catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.post<{ Params: { draftId: string }; Body: { version: number } }>("/api/v1/sale-drafts/:draftId/finalize", async (request, reply) => {
    const key = headerValue(request.headers["idempotency-key"]);
    try {
      const result = finalizeSale(options.database, request.params.draftId, request.body?.version, key ?? "", options.checkoutFailureInjector);
      const job = getPrintJob(options.database, result.printJobId);
      if (job && options.printerHost) void options.printerHost.accept(job).catch((error) => { updatePrintJob(options.database, job.jobId, { state: "failed", errorMessage: error instanceof Error ? error.message : "プリンターホストへの送信に失敗しました" }); });
      return reply.code(201).send(result);
    } catch (error) { return sendError(reply, error, options.database, request.params.draftId); }
  });

  app.get<{ Params: { transactionId: string } }>("/api/v1/transactions/:transactionId", async (request, reply) => getTransactionSnapshot(options.database, request.params.transactionId) ?? sendError(reply, new CheckoutError(404, "TRANSACTION_NOT_FOUND", "取引が見つかりません")));

  app.get<{ Params: { terminalId: string }; Querystring: { registerId?: string } }>("/api/v1/customer-displays/:terminalId", async (request, reply) => {
    const registerId = request.query.registerId ?? request.params.terminalId;
    return getCustomerDisplayProjection(options.database, registerId) ?? sendError(reply, new CheckoutError(404, "CUSTOMER_DISPLAY_STATE_NOT_FOUND", "顧客画面の状態が見つかりません"));
  });
}
