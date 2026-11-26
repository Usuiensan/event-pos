import type { FastifyInstance } from "fastify";
import { statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PrinterStatusObservation } from "@event-pos/contracts";
import type { PosDatabase } from "./db.js";
import type { RealtimeHub } from "./realtime.js";
import { AuthError, requireAuthActor } from "./auth.js";

const unknownObservation = (reason: string): PrinterStatusObservation => ({ observedAt: new Date().toISOString(), reachable: { support: "unknown", reason }, online: { support: "unknown", reason }, coverOpen: { support: "unknown", reason }, drawerOpen: { support: "unknown", reason }, paper: { support: "unknown", reason }, error: { support: "unknown", reason }, raw: null });
async function capacity(path: string | undefined) {
  if (!path) return { state: "unknown" as const, path: null, freeBytes: null, totalBytes: null, reason: "保存先未設定" };
  const requestedPath = resolve(path); let probePath = requestedPath;
  try { let value; while (true) { try { value = await statfs(probePath); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(probePath) === probePath) throw error; probePath = dirname(probePath); } } return { state: "ok" as const, path: requestedPath, freeBytes: Number(value.bavail) * Number(value.bsize), totalBytes: Number(value.blocks) * Number(value.bsize), reason: probePath === requestedPath ? null : `未作成のため ${probePath} の容量を表示` }; }
  catch (error) { return { state: "unknown" as const, path: resolve(path), freeBytes: null, totalBytes: null, reason: error instanceof Error ? error.message : "容量を取得できません" }; }
}

export function registerOperationsDashboard(app: FastifyInstance, options: { database: PosDatabase; realtimeHub: RealtimeHub; artifactRoot?: string; printerStatus?: () => Promise<PrinterStatusObservation>; authRequired?: boolean }): void {
  app.get<{ Querystring: { eventId?: string; businessDate?: string } }>("/api/v1/operations/dashboard", async (request, reply) => {
    if (options.authRequired) {
      // 認証必須時はセッション担当者を正とし、旧ヘッダーは見ない
      try { requireAuthActor(options.database, request, "manager", true); }
      catch (err) { return reply.code(err instanceof AuthError ? err.status : 401).send({ error: { code: err instanceof AuthError ? err.code : "AUTH_REQUIRED", message: err instanceof Error ? err.message : "責任者をサインオンしてください" } }); }
    } else {
      const actorId = request.headers["x-pos-actor-id"]; const role = request.headers["x-pos-role"];
      if (!actorId || role !== "manager") return reply.code(role ? 403 : 401).send({ error: { code: "DASHBOARD_MANAGER_REQUIRED", message: "責任者権限が必要です" } });
    }
    if (!request.query.eventId || !request.query.businessDate) return reply.code(400).send({ error: { code: "DASHBOARD_SCOPE_REQUIRED", message: "eventIdとbusinessDateが必要です" } });
    let databaseState: "ready" | "not_ready" = "ready"; let databaseReason: string | null = null;
    try { const result = options.database.prepare("PRAGMA quick_check").get() as { quick_check?: string }; if (result.quick_check !== "ok") { databaseState = "not_ready"; databaseReason = result.quick_check ?? "quick_check失敗"; } }
    catch (error) { databaseState = "not_ready"; databaseReason = error instanceof Error ? error.message : "DB確認失敗"; }
    const dbFile = (options.database.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find((item) => item.name === "main")?.file;
    const [databaseStorage, artifactStorage, printer] = await Promise.all([capacity(dbFile ? dirname(dbFile) : undefined), capacity(options.artifactRoot), options.printerStatus?.().catch((error) => unknownObservation(error instanceof Error ? error.message : "PrinterHost確認失敗")) ?? Promise.resolve(unknownObservation("PrinterHost未設定"))]);
    const printCounts = options.database.prepare(`SELECT
      SUM(CASE WHEN state IN ('pending','retry_wait','sending') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state IN ('failed','device_fault') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN delivery_certainty='unknown' THEN 1 ELSE 0 END) AS unknown_count
      FROM print_jobs`).get() as Record<string, number | null>;
    const lastPrint = options.database.prepare("SELECT MAX(updated_at) AS value FROM print_jobs WHERE state='completed'").get() as { value: string | null };
    const lastBackup = options.database.prepare("SELECT completed_at AS completedAt,artifact_id AS artifactId FROM backup_artifacts WHERE state='completed' ORDER BY completed_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    const cash = options.database.prepare(`SELECT session_id AS sessionId,cashbox_id AS cashboxId,state,opening_yen AS openingYen,closing_yen AS closingYen,created_at AS createdAt
      FROM cash_sessions WHERE event_id=? AND business_date=? ORDER BY cashbox_id`).all(request.query.eventId, request.query.businessDate);
    const checks = options.database.prepare(`SELECT cc.session_id AS sessionId,cs.cashbox_id AS cashboxId,cc.kind,MAX(cc.created_at) AS createdAt
      FROM cash_checks cc JOIN cash_sessions cs ON cs.session_id=cc.session_id
      WHERE cs.event_id=? AND cs.business_date=? GROUP BY cc.session_id,cc.kind`).all(request.query.eventId, request.query.businessDate);
    const holds = options.database.prepare(`SELECT h.hold_id AS holdId,h.public_reference_display AS publicReferenceDisplay,h.state,h.business_session_id AS businessSessionId,h.created_at AS createdAt,
      EXISTS(SELECT 1 FROM print_jobs p WHERE p.transaction_id='hold:' || h.hold_id AND p.document_type='hold_ticket' AND (p.state IN ('failed','device_fault') OR p.delivery_certainty='unknown')) AS printAttention,
      EXISTS(SELECT 1 FROM hold_lines l
        JOIN inventory_balances i ON i.event_id=h.event_id AND i.product_id=l.product_id
        JOIN json_each((SELECT catalog_json FROM event_catalogs WHERE event_id=h.event_id),'$.products') p ON json_extract(p.value,'$.productCode')=l.product_code
        WHERE l.hold_id=h.hold_id AND json_extract(p.value,'$.inventory.openingQuantity') IS NOT NULL
          AND (CAST(json_extract(p.value,'$.inventory.openingQuantity') AS INTEGER)
            + COALESCE((SELECT SUM(quantity_delta) FROM inventory_movements m WHERE m.event_id=h.event_id AND m.product_id=l.product_id),0)
            - i.reserved) < 0) AS shortage
      FROM holds h WHERE h.event_id=? AND (
        (h.state IN ('active','carried') AND EXISTS(SELECT 1 FROM business_sessions b
          WHERE b.business_session_id=h.business_session_id AND b.event_id=h.event_id AND b.business_date=?))
        OR (h.state='claimed' AND EXISTS(SELECT 1 FROM sale_drafts d
          WHERE d.draft_id=h.claimed_draft_id AND d.event_id=h.event_id AND d.business_date=?
            AND d.state IN ('editing','payment','finalizing','parked')))
      ) ORDER BY h.created_at`).all(request.query.eventId, request.query.businessDate, request.query.businessDate) as Array<Record<string, unknown>>;
    const connections = options.realtimeHub.connections();
    const registerIds = [...new Set([...(options.database.prepare("SELECT DISTINCT register_id AS registerId FROM sale_drafts WHERE event_id=?").all(request.query.eventId) as Array<{ registerId: string }>).map((row) => row.registerId), ...connections.map((item) => item.registerId)])].sort();
    return { observedAt: new Date().toISOString(), database: { state: databaseState, reason: databaseReason }, printerHost: { connected: printer.reachable.support === "supported" ? printer.reachable.value === true : null, observation: printer }, printJobs: { pending: Number(printCounts.pending ?? 0), failed: Number(printCounts.failed ?? 0), unknown: Number(printCounts.unknown_count ?? 0), lastSuccessfulAt: lastPrint.value }, storage: { database: databaseStorage, artifacts: artifactStorage }, lastBackup: lastBackup ?? null, cash: { sessions: cash, checks }, holds: { closingBlockers: holds.filter((hold) => hold.state === "active" || hold.state === "claimed"), confirmationRequired: holds.filter((hold) => hold.state !== "claimed" && (Boolean(hold.printAttention) || Boolean(hold.shortage) || hold.state === "carried")) }, registers: registerIds.map((registerId) => { const active = connections.filter((item) => item.registerId === registerId && item.role === "staff").sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0]; return { registerId, connected: Boolean(active), terminalId: active?.terminalId ?? null, lastCommunicationAt: active?.connectedAt ?? null, customerDisplay: options.realtimeHub.availability(registerId) }; }) };
  });
}
