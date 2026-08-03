import type { FastifyInstance, FastifyReply } from "fastify";
import type { PosDatabase } from "./db.js";
import { AuthError, clearAuthCookie, createAuthSession, findAuthActor, requireAuthActor, revokeAuthSession, setAuthCookie } from "./auth.js";
import { CheckoutError } from "./checkout-store.js";
import { closeBusinessSession, getBusinessSession, getOpenBusinessSession, openBusinessSession, prepareCashSession, reopenBusinessSession } from "./business-store.js";
import type { RealtimeHub } from "./realtime.js";

export type BusinessRouteOptions = { database: PosDatabase; authRequired: boolean; secureCookie: boolean; realtimeHub?: RealtimeHub };

function errorReply(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AuthError || error instanceof CheckoutError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: {}, requestId: reply.request.id } });
  return reply.code(500).send({ error: { code: "BUSINESS_INTERNAL_ERROR", message: "営業状態の処理に失敗しました", details: {}, requestId: reply.request.id } });
}

export function registerBusinessRoutes(app: FastifyInstance, options: BusinessRouteOptions): void {
  app.post<{ Body: { eventId?: string; responsibleNumber?: string; terminalId?: string } }>("/api/v1/auth/sessions", async (request, reply) => {
    try {
      const created = createAuthSession(options.database, { eventId: request.body?.eventId ?? "", responsibleNumber: request.body?.responsibleNumber ?? "", terminalId: request.body?.terminalId ?? "" });
      setAuthCookie(reply, created.token, options.secureCookie);
      return reply.code(201).send({ actor: created.actor });
    } catch (error) { return errorReply(reply, error); }
  });
  app.get("/api/v1/auth/session", async (request, reply) => {
    const actor = findAuthActor(options.database, request);
    return actor ? { actor } : reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "責任者をサインオンしてください", details: {}, requestId: request.id } });
  });
  app.delete("/api/v1/auth/session", async (request, reply) => {
    try { const actor = requireAuthActor(options.database, request, "operator", options.authRequired); revokeAuthSession(options.database, actor); clearAuthCookie(reply, options.secureCookie); return reply.code(204).send(); }
    catch (error) { return errorReply(reply, error); }
  });

  app.get<{ Querystring: { eventId?: string } }>("/api/v1/business-sessions/current", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.authRequired); if (!request.query.eventId) throw new CheckoutError(400, "EVENT_ID_REQUIRED", "eventIdが必要です"); return { session: getOpenBusinessSession(options.database, request.query.eventId) ?? null }; }
    catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Body: { eventId?: string; businessDate?: string; terminalId?: string } }>("/api/v1/business-sessions", async (request, reply) => {
    try { const actor = requireAuthActor(options.database, request, "operator", options.authRequired); const session = openBusinessSession(options.database, { eventId: request.body?.eventId ?? actor.eventId, businessDate: request.body?.businessDate ?? "", actorId: actor.staffId, terminalId: request.body?.terminalId ?? actor.terminalId }); options.realtimeHub?.notifyAll({ type: "business-state.changed", eventId: session.eventId, businessSessionId: session.businessSessionId }); return reply.code(201).send(session); }
    catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { businessSessionId: string }; Body: { terminalId?: string } }>("/api/v1/business-sessions/:businessSessionId/close", async (request, reply) => {
    try { const actor = requireAuthActor(options.database, request, "manager", options.authRequired); const session = closeBusinessSession(options.database, request.params.businessSessionId, { actorId: actor.staffId, terminalId: request.body?.terminalId ?? actor.terminalId }); options.realtimeHub?.notifyAll({ type: "business-state.changed", eventId: session.eventId, businessSessionId: session.businessSessionId }); return session; }
    catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { businessSessionId: string }; Body: { reason?: string; terminalId?: string } }>("/api/v1/business-sessions/:businessSessionId/reopen", async (request, reply) => {
    try { const actor = requireAuthActor(options.database, request, "manager", options.authRequired); const session = reopenBusinessSession(options.database, request.params.businessSessionId, { actorId: actor.staffId, terminalId: request.body?.terminalId ?? actor.terminalId, reason: request.body?.reason ?? "" }); options.realtimeHub?.notifyAll({ type: "business-state.changed", eventId: session.eventId, businessSessionId: session.businessSessionId }); return session; }
    catch (error) { return errorReply(reply, error); }
  });
  app.get<{ Params: { businessSessionId: string }; Querystring: { registerId?: string } }>("/api/v1/business-sessions/:businessSessionId/register-state", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "operator", options.authRequired);
      const business = getBusinessSession(options.database, request.params.businessSessionId); if (!business) throw new CheckoutError(404, "BUSINESS_SESSION_NOT_FOUND", "営業セッションが見つかりません");
      const cash = request.query.registerId ? options.database.prepare("SELECT session_id,cashbox_id,state,opening_yen,closing_yen,created_at FROM cash_sessions WHERE business_session_id=? AND cashbox_id=?").get(request.params.businessSessionId, request.query.registerId) : undefined;
      return { business, cashSession: cash ?? null };
    } catch (error) { return errorReply(reply, error); }
  });
  app.post<{ Params: { businessSessionId: string; registerId: string }; Body: { terminalId?: string } }>("/api/v1/business-sessions/:businessSessionId/registers/:registerId/prepare", async (request, reply) => {
    try { const actor = requireAuthActor(options.database, request, "operator", options.authRequired); const sessionId = prepareCashSession(options.database, { businessSessionId: request.params.businessSessionId, cashboxId: request.params.registerId, actorId: actor.staffId, terminalId: request.body?.terminalId ?? actor.terminalId }); options.realtimeHub?.notifyAll({ type: "register-state.changed", registerId: request.params.registerId, businessSessionId: request.params.businessSessionId }); return reply.code(201).send({ sessionId }); }
    catch (error) { return errorReply(reply, error); }
  });
}
