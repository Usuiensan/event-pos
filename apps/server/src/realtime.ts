import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { PosDatabase } from "./db.js";
import { CheckoutError, getRegisterSaleDraft, immediate, uuidV7 } from "./checkout-store.js";
import { requireAuthActor } from "./auth.js";

export const CUSTOMER_HEARTBEAT_TTL_MS = 5_000;

export type RealtimeNotification =
  | { type: "sale-draft.changed"; registerId: string; version: number }
  | { type: "customer-display.changed"; registerId: string; version: number }
  | { type: "transaction.finalized"; registerId: string; transactionId: string }
  | { type: "customer-display.availability.changed"; registerId: string }
  | { type: "audio-settings.changed"; registerId: string; version: number }
  | { type: "audio-announcement.changed"; registerId: string; sequence: number }
  | { type: "age-confirmation.changed"; registerId: string; requestId: string }
  | { type: "business-state.changed"; eventId: string; businessSessionId: string }
  | { type: "register-state.changed"; registerId: string; businessSessionId: string };

type Subscription = { socket: WebSocket; registerId: string; terminalId: string; role: "staff" | "customer"; connectedAt: number };
type Heartbeat = { terminalId: string; registerId: string; lastSeenMs: number };

export type CustomerDisplayAvailability = {
  available: boolean;
  terminalId?: string;
  lastSeen?: string;
  expiresAt?: string;
  heartbeatTtlMs: number;
};

export class RealtimeHub {
  readonly #subscriptions = new Set<Subscription>();
  readonly #heartbeats = new Map<string, Heartbeat>();

  constructor(private readonly now: () => number = Date.now, readonly heartbeatTtlMs = CUSTOMER_HEARTBEAT_TTL_MS) {}

  subscribe(socket: WebSocket, scope: Omit<Subscription, "socket" | "connectedAt">): void {
    const subscription = { socket, ...scope, connectedAt: this.now() };
    this.#subscriptions.add(subscription);
    socket.once("close", () => this.#subscriptions.delete(subscription));
    socket.once("error", () => this.#subscriptions.delete(subscription));
  }

  connections(): Array<{ registerId: string; terminalId: string; role: "staff" | "customer"; connectedAt: string }> {
    return [...this.#subscriptions]
      .filter((subscription) => subscription.socket.readyState === 1)
      .map(({ registerId, terminalId, role, connectedAt }) => ({ registerId, terminalId, role, connectedAt: new Date(connectedAt).toISOString() }));
  }

  notify(notification: RealtimeNotification): void {
    if (!("registerId" in notification)) return this.notifyAll(notification);
    const payload = JSON.stringify(notification);
    for (const subscription of this.#subscriptions) {
      if (subscription.registerId !== notification.registerId || subscription.socket.readyState !== 1) continue;
      subscription.socket.send(payload);
    }
  }

  notifyAll(notification: RealtimeNotification): void {
    const payload = JSON.stringify(notification);
    for (const subscription of this.#subscriptions) if (subscription.socket.readyState === 1) subscription.socket.send(payload);
  }

  heartbeat(terminalId: string, registerId: string): CustomerDisplayAvailability {
    const before = this.availability(registerId).available;
    this.#heartbeats.set(terminalId, { terminalId, registerId, lastSeenMs: this.now() });
    const after = this.availability(registerId);
    if (!before && after.available) this.notify({ type: "customer-display.availability.changed", registerId });
    return after;
  }

  availability(registerId: string): CustomerDisplayAvailability {
    const now = this.now();
    const active = [...this.#heartbeats.values()]
      .filter((heartbeat) => heartbeat.registerId === registerId && now - heartbeat.lastSeenMs <= this.heartbeatTtlMs)
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs)[0];
    if (!active) return { available: false, heartbeatTtlMs: this.heartbeatTtlMs };
    return {
      available: true,
      terminalId: active.terminalId,
      lastSeen: new Date(active.lastSeenMs).toISOString(),
      expiresAt: new Date(active.lastSeenMs + this.heartbeatTtlMs).toISOString(),
      heartbeatTtlMs: this.heartbeatTtlMs,
    };
  }
}

export type AudioSettings = { tapVolume: number; errorVolume: number; systemErrorVolume: number; speechVolume: number; speakerId: number; version: number; updatedAt: string };

function audioSettings(db: PosDatabase, registerId: string): AudioSettings {
  const row = db.prepare("SELECT tap_volume,error_volume,system_error_volume,speech_volume,speaker_id,version,updated_at FROM register_audio_settings WHERE register_id=?").get(registerId) as Record<string, unknown> | undefined;
  if (!row) return { tapVolume: 100, errorVolume: 100, systemErrorVolume: 100, speechVolume: 100, speakerId: 3, version: 0, updatedAt: new Date(0).toISOString() };
  return { tapVolume: Number(row.tap_volume), errorVolume: Number(row.error_volume), systemErrorVolume: Number(row.system_error_volume), speechVolume: Number(row.speech_volume), speakerId: Number(row.speaker_id), version: Number(row.version), updatedAt: String(row.updated_at) };
}

function saveAudioSettings(db: PosDatabase, registerId: string, input: Omit<AudioSettings, "version" | "updatedAt">): AudioSettings {
  const systemErrorVolume = input.systemErrorVolume ?? input.errorVolume;
  for (const value of [input.tapVolume, input.errorVolume, systemErrorVolume, input.speechVolume]) if (!Number.isInteger(value) || value < 0 || value > 100) throw new CheckoutError(400, "INVALID_AUDIO_VOLUME", "音量は0～100の整数で指定してください");
  if (!Number.isInteger(input.speakerId) || input.speakerId < 1) throw new CheckoutError(400, "INVALID_SPEAKER", "音声話者が不正です");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO register_audio_settings (register_id,tap_volume,error_volume,system_error_volume,speech_volume,speaker_id,version,updated_at)
    VALUES (?,?,?,?,?,?,1,?) ON CONFLICT(register_id) DO UPDATE SET tap_volume=excluded.tap_volume,error_volume=excluded.error_volume,system_error_volume=excluded.system_error_volume,speech_volume=excluded.speech_volume,speaker_id=excluded.speaker_id,version=register_audio_settings.version+1,updated_at=excluded.updated_at`)
    .run(registerId, input.tapVolume, input.errorVolume, systemErrorVolume, input.speechVolume, input.speakerId, now);
  return audioSettings(db, registerId);
}

const ageRequestColumns = `request_id AS requestId,register_id AS registerId,draft_id AS draftId,
  minimum_age AS minimumAge,state,requested_at AS requestedAt,responded_at AS respondedAt`;

function currentAgeRequest(db: PosDatabase, registerId: string, eventId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT ${ageRequestColumns} FROM age_confirmation_requests
    WHERE register_id=? AND draft_id IN (
      SELECT d.draft_id FROM sale_drafts d
      JOIN cash_sessions c ON c.session_id=d.cash_session_id
      JOIN business_sessions b ON b.business_session_id=c.business_session_id AND b.event_id=d.event_id
      WHERE d.register_id=? AND d.event_id=? AND c.cashbox_id=d.register_id
        AND b.state='open' AND c.state='open' AND c.opening_yen IS NOT NULL
    ) ORDER BY requested_at DESC, rowid DESC LIMIT 1`).get(registerId, registerId, eventId);
}

function createAgeRequest(db: PosDatabase, registerId: string, draftId: string, minimumAge: 18 | 20): Record<string, unknown> {
  return immediate(db, () => {
    const scope = db.prepare("SELECT event_id,cash_session_id FROM sale_drafts WHERE draft_id=? AND register_id=?")
      .get(draftId, registerId) as { event_id: string; cash_session_id: string | null } | undefined;
    const draft = scope && getRegisterSaleDraft(db, registerId, scope.event_id);
    if (!scope || !draft || draft.draftId !== draftId || !["editing", "payment"].includes(draft.state)) throw new CheckoutError(409, "DRAFT_NOT_EDITABLE", "年齢確認を要求できる販売ドラフトがありません");
    if (![18, 20].includes(minimumAge)) throw new CheckoutError(400, "INVALID_AGE_REQUIREMENT", "年齢確認条件が不正です");
    const now = new Date().toISOString();
    db.prepare(`UPDATE age_confirmation_requests SET state='canceled',responded_at=?
      WHERE register_id=? AND state IN ('requested','acknowledged') AND draft_id IN (
        SELECT draft_id FROM sale_drafts WHERE register_id=? AND event_id=? AND cash_session_id=?
      )`).run(now, registerId, registerId, scope.event_id, scope.cash_session_id);
    return db.prepare(`INSERT INTO age_confirmation_requests (request_id,register_id,draft_id,minimum_age,state,requested_at)
      VALUES (?,?,?,?,'requested',?) RETURNING ${ageRequestColumns}`).get(uuidV7(), registerId, draftId, minimumAge, now)!;
  });
}

function acknowledgeAgeRequest(db: PosDatabase, registerId: string, requestId: string): Record<string, unknown> {
  const request = db.prepare(`UPDATE age_confirmation_requests SET state='acknowledged',responded_at=?
    WHERE request_id=? AND register_id=? AND state='requested' RETURNING ${ageRequestColumns}`)
    .get(new Date().toISOString(), requestId, registerId);
  if (!request) throw new CheckoutError(409, "AGE_CONFIRMATION_NOT_PENDING", "年齢確認要求はすでに更新されています");
  return request;
}

function sendError(reply: { code(status: number): { send(value: unknown): unknown }; request: { id: string } }, error: unknown): unknown {
  if (error instanceof CheckoutError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details, requestId: reply.request.id } });
  return reply.code(500).send({ error: { code: "REALTIME_INTERNAL_ERROR", message: error instanceof Error ? error.message : "端末同期に失敗しました", details: {}, requestId: reply.request.id } });
}

export function registerRealtimeRoutes(app: FastifyInstance, database: PosDatabase, hub: RealtimeHub, authRequired = false): void {
  app.get<{ Querystring: { registerId?: string; terminalId?: string; role?: string } }>("/api/v1/events", { websocket: true }, (socket, request) => {
    const { registerId, terminalId, role } = request.query;
    if (!registerId || !terminalId || (role !== "staff" && role !== "customer")) return socket.close(1008, "端末scopeが不正です");
    if (role === "staff") {
      try { requireAuthActor(database, request, "operator", authRequired); } catch { return socket.close(1008, "担当者認証が必要です"); }
    }
    hub.subscribe(socket, { registerId, terminalId, role });
    socket.send(JSON.stringify({ type: "connected", registerId }));
  });

  app.post<{ Params: { terminalId: string }; Body: { registerId?: string } }>("/api/v1/customer-displays/:terminalId/heartbeat", async (request, reply) => {
    if (!request.body?.registerId) return reply.code(400).send({ error: { code: "REGISTER_ID_REQUIRED", message: "registerIdが必要です" } });
    hub.heartbeat(request.params.terminalId, request.body.registerId);
    return reply.code(204).send();
  });

  app.get<{ Params: { registerId: string }; Querystring: { eventId?: string } }>("/api/v1/registers/:registerId/customer-display-status", async (request) => {
    const { registerId } = request.params;
    const { eventId } = request.query;
    return {
      registerId,
      ...hub.availability(registerId),
      ageConfirmation: eventId ? currentAgeRequest(database, registerId, eventId) ?? null : null,
    };
  });

  app.get<{ Params: { registerId: string } }>("/api/v1/registers/:registerId/audio-settings", async (request, reply) => {
    const settings = audioSettings(database, request.params.registerId);
    reply.header("etag", `"audio:${request.params.registerId}:${settings.version}"`).header("cache-control", "no-store");
    return settings;
  });

  app.put<{ Params: { registerId: string }; Body: Omit<AudioSettings, "version" | "updatedAt"> }>("/api/v1/registers/:registerId/audio-settings", async (request, reply) => {
    try {
      const settings = saveAudioSettings(database, request.params.registerId, request.body);
      hub.notify({ type: "audio-settings.changed", registerId: request.params.registerId, version: settings.version });
      return settings;
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { registerId: string }; Body: { text?: string } }>("/api/v1/registers/:registerId/audio-announcements", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text || text.length > 200) return reply.code(400).send({ error: { code: "INVALID_ANNOUNCEMENT", message: "読み上げ文は1～200文字で指定してください" } });
    const availability = hub.availability(request.params.registerId);
    const targetRole = availability.available ? "customer" : "staff";
    const now = new Date().toISOString();
    const result = database.prepare("INSERT INTO audio_announcements (announcement_id,register_id,target_role,target_terminal_id,text,created_at,acknowledged_at) VALUES (?,?,?,?,?,?,?)")
      .run(uuidV7(), request.params.registerId, targetRole, availability.terminalId ?? null, text, now, targetRole === "staff" ? now : null);
    const sequence = Number(result.lastInsertRowid);
    if (targetRole === "customer") hub.notify({ type: "audio-announcement.changed", registerId: request.params.registerId, sequence });
    return reply.code(201).send({ sequence, targetRole, ...(availability.terminalId ? { targetTerminalId: availability.terminalId } : {}) });
  });

  app.get<{ Params: { terminalId: string }; Querystring: { registerId?: string; after?: string } }>("/api/v1/customer-displays/:terminalId/audio-announcements", async (request) => {
    const after = Number(request.query.after ?? 0);
    const rows = database.prepare("SELECT sequence,announcement_id AS announcementId,text,created_at AS createdAt FROM audio_announcements WHERE register_id=? AND target_role='customer' AND target_terminal_id=? AND acknowledged_at IS NULL AND sequence>? ORDER BY sequence LIMIT 20")
      .all(request.query.registerId ?? "", request.params.terminalId, Number.isSafeInteger(after) && after >= 0 ? after : 0);
    return { announcements: rows };
  });

  app.post<{ Params: { terminalId: string; sequence: string } }>("/api/v1/customer-displays/:terminalId/audio-announcements/:sequence/ack", async (request, reply) => {
    const sequence = Number(request.params.sequence);
    if (!Number.isSafeInteger(sequence)) return reply.code(400).send({ error: { code: "INVALID_ANNOUNCEMENT", message: "音声通知番号が不正です" } });
    database.prepare("UPDATE audio_announcements SET acknowledged_at=? WHERE sequence=? AND target_terminal_id=? AND acknowledged_at IS NULL").run(new Date().toISOString(), sequence, request.params.terminalId);
    return reply.code(204).send();
  });

  app.post<{ Params: { registerId: string }; Body: { draftId?: string; minimumAge?: 18 | 20 } }>("/api/v1/registers/:registerId/age-confirmation-requests", async (request, reply) => {
    try {
      const ageRequest = createAgeRequest(database, request.params.registerId, request.body?.draftId ?? "", request.body?.minimumAge ?? 20);
      hub.notify({ type: "age-confirmation.changed", registerId: request.params.registerId, requestId: String(ageRequest.requestId) });
      return reply.code(201).send(ageRequest);
    } catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Params: { registerId: string; requestId: string } }>("/api/v1/registers/:registerId/age-confirmation-requests/:requestId", async (request, reply) => {
    database.prepare("UPDATE age_confirmation_requests SET state='canceled',responded_at=? WHERE request_id=? AND register_id=? AND state IN ('requested','acknowledged')").run(new Date().toISOString(), request.params.requestId, request.params.registerId);
    hub.notify({ type: "age-confirmation.changed", registerId: request.params.registerId, requestId: request.params.requestId });
    return reply.code(204).send();
  });

  app.post<{ Params: { terminalId: string }; Body: { registerId?: string; requestId?: string; response?: "yes" } }>("/api/v1/customer-displays/:terminalId/age-confirmations", async (request, reply) => {
    if (request.body?.response !== "yes" || !request.body.registerId || !request.body.requestId) return reply.code(400).send({ error: { code: "INVALID_AGE_CONFIRMATION", message: "年齢確認応答が不正です" } });
    try {
      const ageRequest = acknowledgeAgeRequest(database, request.body.registerId, request.body.requestId);
      hub.notify({ type: "age-confirmation.changed", registerId: request.body.registerId, requestId: request.body.requestId });
      return reply.code(201).send(ageRequest);
    } catch (error) { return sendError(reply, error); }
  });
}
