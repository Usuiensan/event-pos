import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { PosDatabase } from "./db.js";
import type { StaffRole } from "./business-store.js";
import { ensureInitialAdmin } from "./business-store.js";
import { uuidV7 } from "./ids.js";

export type AuthActor = { authSessionId: string; staffId: string; eventId: string; responsibleNumber: string; displayName: string; role: StaffRole; terminalId: string; csrfToken: string };
export type RequestLike = { method: string; headers: Record<string, string | string[] | undefined> };

const cookieName = "event_pos_session";
const roleRank: Record<StaffRole, number> = { operator: 1, manager: 2, admin: 3 };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function header(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function cookieValue(request: RequestLike): string | undefined {
  const cookie = header(request.headers.cookie);
  return cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

export function createAuthSession(db: PosDatabase, input: { eventId: string; responsibleNumber: string; terminalId: string }): { actor: AuthActor; token: string } {
  if (!/^\d{3}$/.test(input.responsibleNumber) || !input.eventId || !input.terminalId) throw new AuthError(400, "INVALID_SIGN_IN", "event、責任者番号、端末が必要です");
  const now = new Date().toISOString();
  if (input.responsibleNumber === "001") ensureInitialAdmin(db, input.eventId, now);
  const assignment = db.prepare(`SELECT staff_id,event_id,responsible_number,display_name,role FROM event_staff_assignments
    WHERE event_id=? AND responsible_number=? AND active=1 AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)`).get(input.eventId, input.responsibleNumber, now, now) as Record<string, unknown> | undefined;
  if (!assignment) throw new AuthError(401, "STAFF_SIGN_IN_FAILED", "有効な責任者番号ではありません");
  const token = randomBytes(32).toString("base64url"); const csrfToken = randomBytes(24).toString("base64url"); const id = uuidV7();
  db.prepare("INSERT INTO staff_auth_sessions(auth_session_id,token_sha256,csrf_token,staff_id,event_id,responsible_number,display_name,role,terminal_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, sha256(token), csrfToken, String(assignment.staff_id), String(assignment.event_id), String(assignment.responsible_number), String(assignment.display_name), String(assignment.role), input.terminalId, now);
  return { token, actor: { authSessionId: id, staffId: String(assignment.staff_id), eventId: String(assignment.event_id), responsibleNumber: String(assignment.responsible_number), displayName: String(assignment.display_name), role: assignment.role as StaffRole, terminalId: input.terminalId, csrfToken } };
}

export function findAuthActor(db: PosDatabase, request: RequestLike): AuthActor | undefined {
  const token = cookieValue(request);
  if (!token) return undefined;
  const row = db.prepare("SELECT * FROM staff_auth_sessions WHERE token_sha256=? AND revoked_at IS NULL").get(sha256(token)) as Record<string, unknown> | undefined;
  return row ? { authSessionId: String(row.auth_session_id), staffId: String(row.staff_id), eventId: String(row.event_id), responsibleNumber: String(row.responsible_number), displayName: String(row.display_name), role: row.role as StaffRole, terminalId: String(row.terminal_id), csrfToken: String(row.csrf_token) } : undefined;
}

export class AuthError extends Error { constructor(public readonly status: number, public readonly code: string, message: string) { super(message); } }

export function requireAuthActor(db: PosDatabase, request: RequestLike, minimumRole: StaffRole = "operator", enabled = true): AuthActor {
  if (!enabled) {
    const role = header(request.headers["x-pos-role"]); const actorId = header(request.headers["x-pos-actor-id"]) ?? "test-operator";
    const normalizedRole: StaffRole = role === "operator" || role === "admin" || role === "manager" ? role : "admin";
    if (roleRank[normalizedRole] < roleRank[minimumRole]) throw new AuthError(403, "FORBIDDEN", "この操作を行う権限がありません");
    return { authSessionId: "test-session", staffId: actorId, eventId: "", responsibleNumber: actorId, displayName: actorId, role: normalizedRole, terminalId: "test-terminal", csrfToken: "test-csrf" };
  }
  const actor = findAuthActor(db, request);
  if (!actor) throw new AuthError(401, "AUTH_REQUIRED", "責任者をサインオンしてください");
  if (roleRank[actor.role] < roleRank[minimumRole]) throw new AuthError(403, "FORBIDDEN", "この操作を行う権限がありません");
  const origin = header(request.headers.origin); const host = header(request.headers.host); const forwardedProto = header(request.headers["x-forwarded-proto"]);
  if (origin && host) {
    let originHost = ""; let originProtocol = "";
    try { const parsed = new URL(origin); originHost = parsed.host; originProtocol = parsed.protocol; } catch { throw new AuthError(403, "ORIGIN_REJECTED", "接続元を確認できません"); }
    const expectedProtocol = forwardedProto ? `${forwardedProto}:` : undefined;
    if (originHost !== host || (expectedProtocol && originProtocol !== expectedProtocol)) throw new AuthError(403, "ORIGIN_REJECTED", "許可されていない接続元です");
  }
  if (request.method !== "GET" && request.method !== "HEAD" && header(request.headers["x-csrf-token"]) !== actor.csrfToken) throw new AuthError(403, "CSRF_REJECTED", "画面の認証情報を更新してから再実行してください");
  return actor;
}

export function revokeAuthSession(db: PosDatabase, actor: AuthActor, reason = "signed_out"): void {
  db.prepare("UPDATE staff_auth_sessions SET revoked_at=?,revoke_reason=? WHERE auth_session_id=? AND revoked_at IS NULL").run(new Date().toISOString(), reason, actor.authSessionId);
}

export function setAuthCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.header("set-cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`);
}

export function clearAuthCookie(reply: FastifyReply, secure: boolean): void {
  reply.header("set-cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
}
