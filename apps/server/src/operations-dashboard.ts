import type { FastifyInstance } from "fastify";
import { statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PrinterStatusObservation } from "@event-pos/contracts";
import type { PosDatabase } from "./db.js";
import type { RealtimeHub } from "./realtime.js";

const unknownObservation = (reason: string): PrinterStatusObservation => ({ observedAt: new Date().toISOString(), reachable: { support: "unknown", reason }, online: { support: "unknown", reason }, coverOpen: { support: "unknown", reason }, paper: { support: "unknown", reason }, error: { support: "unknown", reason }, raw: null });
async function capacity(path: string | undefined) {
  if (!path) return { state: "unknown" as const, path: null, freeBytes: null, totalBytes: null, reason: "保存先未設定" };
  try { const value = await statfs(resolve(path)); return { state: "ok" as const, path: resolve(path), freeBytes: Number(value.bavail) * Number(value.bsize), totalBytes: Number(value.blocks) * Number(value.bsize), reason: null }; }
  catch (error) { return { state: "unknown" as const, path: resolve(path), freeBytes: null, totalBytes: null, reason: error instanceof Error ? error.message : "容量を取得できません" }; }
}

export function registerOperationsDashboard(app: FastifyInstance, options: { database: PosDatabase; realtimeHub: RealtimeHub; artifactRoot?: string; printerStatus?: () => Promise<PrinterStatusObservation> }): void {
  app.get<{ Querystring: { eventId?: string; businessDate?: string } }>("/api/v1/operations/dashboard", async (request, reply) => {
    const actorId = request.headers["x-pos-actor-id"]; const role = request.headers["x-pos-role"];
    if (!actorId || role !== "manager") return reply.code(role ? 403 : 401).send({ error: { code: "DASHBOARD_MANAGER_REQUIRED", message: "責任者権限が必要です" } });
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
    const cash = options.database.prepare("SELECT cashbox_id AS cashboxId,state,opening_yen AS openingYen,closing_yen AS closingYen,created_at AS createdAt FROM cash_sessions WHERE event_id=? AND business_date=? ORDER BY cashbox_id").all(request.query.eventId, request.query.businessDate);
    const checks = options.database.prepare("SELECT cs.cashbox_id AS cashboxId,cc.kind,MAX(cc.created_at) AS createdAt FROM cash_checks cc JOIN cash_sessions cs ON cs.session_id=cc.session_id WHERE cs.event_id=? AND cs.business_date=? GROUP BY cs.cashbox_id,cc.kind").all(request.query.eventId, request.query.businessDate);
    const connections = options.realtimeHub.connections();
    const registerIds = [...new Set([...(options.database.prepare("SELECT DISTINCT register_id AS registerId FROM sale_drafts WHERE event_id=?").all(request.query.eventId) as Array<{ registerId: string }>).map((row) => row.registerId), ...connections.map((item) => item.registerId)])].sort();
    return { observedAt: new Date().toISOString(), database: { state: databaseState, reason: databaseReason }, printerHost: { connected: printer.reachable.support === "supported" ? printer.reachable.value === true : null, observation: printer }, printJobs: { pending: Number(printCounts.pending ?? 0), failed: Number(printCounts.failed ?? 0), unknown: Number(printCounts.unknown_count ?? 0), lastSuccessfulAt: lastPrint.value }, storage: { database: databaseStorage, artifacts: artifactStorage }, lastBackup: lastBackup ?? null, cash: { sessions: cash, checks }, registers: registerIds.map((registerId) => { const active = connections.filter((item) => item.registerId === registerId && item.role === "staff").sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0]; return { registerId, connected: Boolean(active), terminalId: active?.terminalId ?? null, lastCommunicationAt: active?.connectedAt ?? null, customerDisplay: options.realtimeHub.availability(registerId) }; }) };
  });
}
