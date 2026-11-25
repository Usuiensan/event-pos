import type { EventCatalog, StaffMember } from "@event-pos/contracts";
import type { PosDatabase } from "./db.js";
import { CheckoutError } from "./checkout-store.js";
import { uuidV7 } from "./ids.js";

export type StaffRole = "operator" | "manager" | "admin";
export type BusinessSessionDto = {
  businessSessionId: string; eventId: string; businessDate: string; sessionNo: number; state: "open" | "closed";
  openedBy: string; openedTerminalId: string; openedAt: string; closedBy?: string; closedTerminalId?: string; closedAt?: string; reopenReason?: string;
};

function roleFor(member: StaffMember): StaffRole {
  if (member.role) return member.role;
  if (member.permissions?.includes("catalog_import")) return "admin";
  if (member.permissions?.includes("reprint")) return "manager";
  return "operator";
}

export function synchronizeCatalogStaff(db: PosDatabase, catalog: EventCatalog, now = new Date().toISOString()): void {
  const members = catalog.staffMembers?.some((member) => member.responsibleNumber === "001")
    ? catalog.staffMembers
    : [...(catalog.staffMembers ?? []), { responsibleNumber: "001", displayName: "管理者", role: "admin" as const }];
  const activeNumbers = new Set<string>();
  for (const member of members) {
    activeNumbers.add(member.responsibleNumber);
    const existing = db.prepare("SELECT assignment_id,staff_id FROM event_staff_assignments WHERE event_id=? AND responsible_number=?").get(catalog.eventId, member.responsibleNumber) as { assignment_id: string; staff_id: string } | undefined;
    const staffId = existing?.staff_id ?? uuidV7();
    if (!existing) db.prepare("INSERT INTO staff_members(staff_id,created_at) VALUES (?,?)").run(staffId, now);
    db.prepare(`INSERT INTO event_staff_assignments(assignment_id,staff_id,event_id,responsible_number,display_name,role,valid_from,active)
      VALUES (?,?,?,?,?,?,?,1)
      ON CONFLICT(event_id,responsible_number) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,active=1,valid_until=NULL`)
      .run(existing?.assignment_id ?? uuidV7(), staffId, catalog.eventId, member.responsibleNumber, member.displayName, roleFor(member), now);
  }
  const assignments = db.prepare("SELECT responsible_number FROM event_staff_assignments WHERE event_id=? AND active=1").all(catalog.eventId) as Array<{ responsible_number: string }>;
  for (const assignment of assignments) if (!activeNumbers.has(assignment.responsible_number)) db.prepare("UPDATE event_staff_assignments SET active=0,valid_until=? WHERE event_id=? AND responsible_number=?").run(now, catalog.eventId, assignment.responsible_number);
}

function businessFromRow(row: Record<string, unknown>): BusinessSessionDto {
  return {
    businessSessionId: String(row.business_session_id), eventId: String(row.event_id), businessDate: String(row.business_date), sessionNo: Number(row.session_no), state: row.state as "open" | "closed",
    openedBy: String(row.opened_by), openedTerminalId: String(row.opened_terminal_id), openedAt: String(row.opened_at),
    ...(row.closed_by ? { closedBy: String(row.closed_by) } : {}), ...(row.closed_terminal_id ? { closedTerminalId: String(row.closed_terminal_id) } : {}),
    ...(row.closed_at ? { closedAt: String(row.closed_at) } : {}), ...(row.reopen_reason ? { reopenReason: String(row.reopen_reason) } : {}),
  };
}

export function getOpenBusinessSession(db: PosDatabase, eventId: string): BusinessSessionDto | undefined {
  const row = db.prepare("SELECT * FROM business_sessions WHERE event_id=? AND state='open'").get(eventId) as Record<string, unknown> | undefined;
  return row ? businessFromRow(row) : undefined;
}

export function getBusinessSession(db: PosDatabase, businessSessionId: string): BusinessSessionDto | undefined {
  const row = db.prepare("SELECT * FROM business_sessions WHERE business_session_id=?").get(businessSessionId) as Record<string, unknown> | undefined;
  return row ? businessFromRow(row) : undefined;
}

export function openBusinessSession(db: PosDatabase, input: { eventId: string; businessDate: string; actorId: string; terminalId: string }): BusinessSessionDto {
  if (!input.eventId || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) || !input.actorId || !input.terminalId) throw new CheckoutError(400, "INVALID_BUSINESS_OPEN", "開局情報が不正です");
  const existing = getOpenBusinessSession(db, input.eventId);
  if (existing) return existing;
  const configuredManager = db.prepare("SELECT 1 FROM event_staff_assignments WHERE event_id=? AND active=1 AND role IN ('manager','admin') LIMIT 1").get(input.eventId);
  if (!configuredManager) throw new CheckoutError(409, "MANAGER_NOT_CONFIGURED", "開局前に責任者を1名以上設定してください");
  const maximum = Number((db.prepare("SELECT COALESCE(MAX(session_no),0) AS maximum FROM business_sessions WHERE event_id=?").get(input.eventId) as { maximum: number }).maximum);
  if (maximum >= 999) throw new CheckoutError(409, "BUSINESS_SESSION_LIMIT", "営業セッション番号が上限999に達しています");
  const now = new Date().toISOString(); const id = uuidV7();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO business_sessions(business_session_id,event_id,business_date,session_no,state,opened_by,opened_terminal_id,opened_at) VALUES (?,?,?,?,'open',?,?,?)").run(id, input.eventId, input.businessDate, maximum + 1, input.actorId, input.terminalId, now);
    db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'business_open','business_session',?,?,?)").run(input.eventId, id, JSON.stringify({ businessDate: input.businessDate, sessionNo: maximum + 1, actorId: input.actorId, terminalId: input.terminalId }), now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getBusinessSession(db, id)!;
}

export function prepareCashSession(db: PosDatabase, input: { businessSessionId: string; cashboxId: string; actorId: string; terminalId: string }): string {
  const business = getBusinessSession(db, input.businessSessionId);
  if (!business || business.state !== "open") throw new CheckoutError(409, "BUSINESS_NOT_OPEN", "営業全体が開局されていません");
  const existing = db.prepare("SELECT session_id FROM cash_sessions WHERE business_session_id=? AND cashbox_id=?").get(input.businessSessionId, input.cashboxId) as { session_id: string } | undefined;
  if (existing) return existing.session_id;
  const id = business.sessionNo === 1 ? `checkout:${business.eventId}:${business.businessDate}:${input.cashboxId}` : `checkout:${business.eventId}:${business.businessDate}:${business.sessionNo}:${input.cashboxId}`; const now = new Date().toISOString();
  db.prepare("INSERT INTO cash_sessions(session_id,event_id,business_date,cashbox_id,state,created_at,business_session_id,opened_by,opened_terminal_id) VALUES (?,?,?,?,'preparing',?,?,?,?)")
    .run(id, business.eventId, business.businessDate, input.cashboxId, now, input.businessSessionId, input.actorId, input.terminalId);
  return id;
}

export function assertRegisterOpen(db: PosDatabase, eventId: string, registerId: string): { businessSessionId: string; cashSessionId: string; businessDate: string; sessionNo: number } {
  const row = db.prepare(`SELECT b.business_session_id,b.business_date,b.session_no,c.session_id,c.state,c.opening_yen
    FROM business_sessions b JOIN cash_sessions c ON c.business_session_id=b.business_session_id
    WHERE b.event_id=? AND b.state='open' AND c.cashbox_id=? ORDER BY b.opened_at DESC LIMIT 1`).get(eventId, registerId) as Record<string, unknown> | undefined;
  if (!row) throw new CheckoutError(409, "REGISTER_NOT_OPEN", "このレジは未開局です");
  if (row.state !== "open" || row.opening_yen === null) throw new CheckoutError(409, "REGISTER_NOT_OPEN", "準備金を確定してこのレジを開局してください");
  return { businessSessionId: String(row.business_session_id), cashSessionId: String(row.session_id), businessDate: String(row.business_date), sessionNo: Number(row.session_no) };
}

export function closeBusinessSession(db: PosDatabase, businessSessionId: string, input: { actorId: string; terminalId: string }): BusinessSessionDto {
  const business = getBusinessSession(db, businessSessionId);
  if (!business) throw new CheckoutError(404, "BUSINESS_SESSION_NOT_FOUND", "営業セッションが見つかりません");
  if (business.state === "closed") return business;
  const activeDraft = db.prepare(`SELECT d.draft_id FROM sale_drafts d WHERE d.event_id=? AND d.state IN ('editing','payment','finalizing','parked')
    AND (EXISTS (SELECT 1 FROM sale_draft_lines l WHERE l.draft_id=d.draft_id AND l.status='active')
      OR EXISTS (SELECT 1 FROM draft_payments p WHERE p.draft_id=d.draft_id)
      OR EXISTS (SELECT 1 FROM holds h WHERE h.claimed_draft_id=d.draft_id AND h.state='claimed')) LIMIT 1`).get(business.eventId);
  if (activeDraft) throw new CheckoutError(409, "ACTIVE_DRAFTS_EXIST", "未確定の会計が残っています");
  const activeHold = db.prepare("SELECT hold_id FROM holds WHERE business_session_id=? AND state='active' LIMIT 1").get(businessSessionId);
  if (activeHold) throw new CheckoutError(409, "ACTIVE_HOLDS_EXIST", "未解決の取り置きが残っています。解除または翌営業へ繰越してください");
  const openCashbox = db.prepare("SELECT cashbox_id FROM cash_sessions WHERE business_session_id=? AND state!='closed' LIMIT 1").get(businessSessionId);
  if (openCashbox) throw new CheckoutError(409, "REGISTER_NOT_CLOSED", "精算されていないレジがあります");
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE business_sessions SET state='closed',closed_by=?,closed_terminal_id=?,closed_at=? WHERE business_session_id=? AND state='open'").run(input.actorId, input.terminalId, now, businessSessionId);
    db.prepare("UPDATE staff_auth_sessions SET revoked_at=?,revoke_reason='business_closed' WHERE event_id=? AND revoked_at IS NULL").run(now, business.eventId);
    db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'business_close','business_session',?,?,?)").run(business.eventId, businessSessionId, JSON.stringify(input), now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getBusinessSession(db, businessSessionId)!;
}

export function ensureInitialAdmin(db: PosDatabase, eventId: string, now = new Date().toISOString()): void {
  const existing = db.prepare("SELECT 1 FROM event_staff_assignments WHERE event_id=? AND responsible_number='001' LIMIT 1").get(eventId);
  if (existing) return;
  const staffId = uuidV7(); const assignmentId = uuidV7();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO staff_members(staff_id,created_at) VALUES (?,?)").run(staffId, now);
    db.prepare("INSERT INTO event_staff_assignments(assignment_id,staff_id,event_id,responsible_number,display_name,role,valid_from,active) VALUES (?,?,?,'001','管理者','admin',?,1)").run(assignmentId, staffId, eventId, now);
    db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'initial_admin_created','event_staff_assignment',?,?,?)").run(eventId, assignmentId, JSON.stringify({ responsibleNumber: "001", displayName: "管理者", role: "admin" }), now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function cancelBusinessOpening(db: PosDatabase, businessSessionId: string, input: { actorId: string; terminalId: string; reason: string }): BusinessSessionDto {
  const business = getBusinessSession(db, businessSessionId);
  if (!business) throw new CheckoutError(404, "BUSINESS_SESSION_NOT_FOUND", "営業セッションが見つかりません");
  if (business.state !== "open") throw new CheckoutError(409, "BUSINESS_NOT_OPEN", "営業開始中の営業セッションではありません");
  if (!input.reason.trim()) throw new CheckoutError(400, "CANCEL_OPENING_REASON_REQUIRED", "開局取消理由が必要です");
  const activeDraft = db.prepare(`SELECT d.draft_id FROM sale_drafts d WHERE d.event_id=? AND d.state IN ('editing','payment','finalizing','parked')
    AND (EXISTS (SELECT 1 FROM sale_draft_lines l WHERE l.draft_id=d.draft_id AND l.status='active')
      OR EXISTS (SELECT 1 FROM draft_payments p WHERE p.draft_id=d.draft_id)) LIMIT 1`).get(business.eventId);
  if (activeDraft) throw new CheckoutError(409, "ACTIVE_DRAFTS_EXIST", "未確定の会計が残っています");
  const activeHold = db.prepare("SELECT hold_id FROM holds WHERE business_session_id=? AND state='active' LIMIT 1").get(businessSessionId);
  if (activeHold) throw new CheckoutError(409, "ACTIVE_HOLDS_EXIST", "未解決の取り置きが残っています");
  const confirmed = db.prepare("SELECT cashbox_id FROM cash_sessions WHERE business_session_id=? AND (state='open' OR opening_yen IS NOT NULL) LIMIT 1").get(businessSessionId);
  if (confirmed) throw new CheckoutError(409, "OPENING_ALREADY_CONFIRMED", "準備金確定後は開局取消できません。レジ精算・営業終了を使用してください");
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE cash_sessions SET state='closed',closed_by=?,closed_terminal_id=?,closed_at=? WHERE business_session_id=? AND state='preparing'").run(input.actorId, input.terminalId, now, businessSessionId);
    db.prepare("UPDATE business_sessions SET state='closed',closed_by=?,closed_terminal_id=?,closed_at=? WHERE business_session_id=? AND state='open'").run(input.actorId, input.terminalId, now, businessSessionId);
    db.prepare("UPDATE staff_auth_sessions SET revoked_at=?,revoke_reason='business_opening_cancelled' WHERE event_id=? AND revoked_at IS NULL").run(now, business.eventId);
    db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'business_opening_cancelled','business_session',?,?,?)").run(business.eventId, businessSessionId, JSON.stringify(input), now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getBusinessSession(db, businessSessionId)!;
}

export function reopenBusinessSession(db: PosDatabase, businessSessionId: string, input: { actorId: string; terminalId: string; reason: string }): BusinessSessionDto {
  const business = getBusinessSession(db, businessSessionId);
  if (!business) throw new CheckoutError(404, "BUSINESS_SESSION_NOT_FOUND", "営業セッションが見つかりません");
  if (!input.reason.trim()) throw new CheckoutError(400, "REOPEN_REASON_REQUIRED", "再開理由が必要です");
  if (getOpenBusinessSession(db, business.eventId)) throw new CheckoutError(409, "BUSINESS_ALREADY_OPEN", "別の営業セッションが開局中です");
  const now = new Date().toISOString();
  db.prepare("UPDATE business_sessions SET state='open',closed_by=NULL,closed_terminal_id=NULL,closed_at=NULL,reopen_reason=? WHERE business_session_id=?").run(input.reason.trim(), businessSessionId);
  db.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'business_reopen','business_session',?,?,?)").run(business.eventId, businessSessionId, JSON.stringify(input), now);
  return getBusinessSession(db, businessSessionId)!;
}
