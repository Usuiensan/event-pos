import { randomBytes } from "node:crypto";
import type { PosDatabase } from "./db.js";

export type BackupArtifactState = "pending" | "generating" | "completed" | "failed";
export type BackupArtifactTrigger = "interim" | "closing" | "manual_regeneration";

export type BackupArtifactRecord = {
  artifactId: string;
  eventId: string;
  businessDate: string;
  cashboxId: string;
  cashSessionId: string;
  sourceCashCheckId: number;
  triggerKind: BackupArtifactTrigger;
  retryOfArtifactId?: string;
  requestKey: string;
  state: BackupArtifactState;
  requestedBy?: string;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  outputDirectory?: string;
  backupPath?: string;
  workbookPath?: string;
  manifestPath?: string;
  backupSha256?: string;
  workbookSha256?: string;
  manifestSha256?: string;
  snapshotLogicalSha256?: string;
  rowCounts?: Record<string, number>;
  totals?: Record<string, number>;
  errorCode?: string;
  errorMessage?: string;
  attemptCount: number;
  canRegenerate: boolean;
};

function uuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) { bytes[index] = Number(timestamp & 0xffn); timestamp >>= 8n; }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function applyBackupArtifactSchema(db: PosDatabase): void {
  const now = new Date().toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_artifacts (
      artifact_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      cashbox_id TEXT NOT NULL,
      cash_session_id TEXT NOT NULL,
      source_cash_check_id INTEGER NOT NULL,
      trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('interim','closing','manual_regeneration')),
      retry_of_artifact_id TEXT,
      request_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('pending','generating','completed','failed')),
      requested_by TEXT,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      output_directory TEXT,
      backup_path TEXT,
      workbook_path TEXT,
      manifest_path TEXT,
      backup_sha256 TEXT,
      workbook_sha256 TEXT,
      manifest_sha256 TEXT,
      snapshot_logical_sha256 TEXT,
      row_counts_json TEXT,
      totals_json TEXT,
      error_code TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(cash_session_id) REFERENCES cash_sessions(session_id),
      FOREIGN KEY(source_cash_check_id) REFERENCES cash_checks(id),
      FOREIGN KEY(retry_of_artifact_id) REFERENCES backup_artifacts(artifact_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_backup_artifacts_auto_check
      ON backup_artifacts(source_cash_check_id, trigger_kind)
      WHERE trigger_kind IN ('interim','closing');
    CREATE INDEX IF NOT EXISTS ix_backup_artifacts_scope
      ON backup_artifacts(event_id,business_date,cashbox_id,requested_at DESC);
    CREATE INDEX IF NOT EXISTS ix_backup_artifacts_state
      ON backup_artifacts(state,requested_at);
  `);
  db.prepare("INSERT INTO schema_migrations (version,applied_at) VALUES (6,?) ON CONFLICT(version) DO NOTHING").run(now);
  db.prepare("INSERT INTO app_metadata (key,value) VALUES ('schema_version','6') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
}

function parseJsonRecord(value: unknown): Record<string, number> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, Number(item)]));
  } catch { return undefined; }
}

export function mapBackupArtifact(row: Record<string, unknown>): BackupArtifactRecord {
  const state = String(row.state) as BackupArtifactState;
  return {
    artifactId: String(row.artifact_id), eventId: String(row.event_id), businessDate: String(row.business_date), cashboxId: String(row.cashbox_id), cashSessionId: String(row.cash_session_id), sourceCashCheckId: Number(row.source_cash_check_id), triggerKind: String(row.trigger_kind) as BackupArtifactTrigger, requestKey: String(row.request_key), state,
    ...(row.retry_of_artifact_id ? { retryOfArtifactId: String(row.retry_of_artifact_id) } : {}),
    ...(row.requested_by ? { requestedBy: String(row.requested_by) } : {}),
    requestedAt: String(row.requested_at), ...(row.started_at ? { startedAt: String(row.started_at) } : {}), ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    ...(row.output_directory ? { outputDirectory: String(row.output_directory) } : {}), ...(row.backup_path ? { backupPath: String(row.backup_path) } : {}), ...(row.workbook_path ? { workbookPath: String(row.workbook_path) } : {}), ...(row.manifest_path ? { manifestPath: String(row.manifest_path) } : {}),
    ...(row.backup_sha256 ? { backupSha256: String(row.backup_sha256) } : {}), ...(row.workbook_sha256 ? { workbookSha256: String(row.workbook_sha256) } : {}), ...(row.manifest_sha256 ? { manifestSha256: String(row.manifest_sha256) } : {}), ...(row.snapshot_logical_sha256 ? { snapshotLogicalSha256: String(row.snapshot_logical_sha256) } : {}),
    ...(parseJsonRecord(row.row_counts_json) ? { rowCounts: parseJsonRecord(row.row_counts_json)! } : {}), ...(parseJsonRecord(row.totals_json) ? { totals: parseJsonRecord(row.totals_json)! } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}), ...(row.error_message ? { errorMessage: String(row.error_message) } : {}), attemptCount: Number(row.attempt_count), canRegenerate: state === "failed",
  };
}

export function getBackupArtifact(db: PosDatabase, artifactId: string): BackupArtifactRecord | undefined {
  const row = db.prepare("SELECT * FROM backup_artifacts WHERE artifact_id=?").get(artifactId) as Record<string, unknown> | undefined;
  return row ? mapBackupArtifact(row) : undefined;
}

export function listBackupArtifacts(db: PosDatabase, filter: { eventId: string; businessDate?: string; cashboxId?: string }): BackupArtifactRecord[] {
  const clauses = ["event_id=?"]; const params: string[] = [filter.eventId];
  if (filter.businessDate) { clauses.push("business_date=?"); params.push(filter.businessDate); }
  if (filter.cashboxId) { clauses.push("cashbox_id=?"); params.push(filter.cashboxId); }
  return (db.prepare(`SELECT * FROM backup_artifacts WHERE ${clauses.join(" AND ")} ORDER BY requested_at DESC,artifact_id DESC LIMIT 100`).all(...params) as Array<Record<string, unknown>>).map(mapBackupArtifact);
}

export function reserveAutomaticBackupArtifact(db: PosDatabase, input: { eventId: string; businessDate: string; cashboxId: string; cashSessionId: string; cashCheckId: number; triggerKind: "interim" | "closing"; requestedBy?: string; requestedAt: string }): BackupArtifactRecord {
  const requestKey = `cash-check:${input.cashCheckId}`;
  const existing = db.prepare("SELECT * FROM backup_artifacts WHERE request_key=?").get(requestKey) as Record<string, unknown> | undefined;
  if (existing) return mapBackupArtifact(existing);
  const artifactId = uuidV7();
  db.prepare(`INSERT INTO backup_artifacts (artifact_id,event_id,business_date,cashbox_id,cash_session_id,source_cash_check_id,trigger_kind,request_key,state,requested_by,requested_at)
    VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`).run(artifactId, input.eventId, input.businessDate, input.cashboxId, input.cashSessionId, input.cashCheckId, input.triggerKind, requestKey, input.requestedBy ?? null, input.requestedAt);
  return getBackupArtifact(db, artifactId)!;
}

export function reserveBackupArtifactRegeneration(db: PosDatabase, sourceArtifactId: string, requestKey: string, requestedBy: string | undefined): BackupArtifactRecord {
  if (!requestKey.trim()) throw new Error("Idempotency-Keyが必要です");
  const existing = db.prepare("SELECT * FROM backup_artifacts WHERE request_key=?").get(`manual:${requestKey}`) as Record<string, unknown> | undefined;
  if (existing) return mapBackupArtifact(existing);
  const source = getBackupArtifact(db, sourceArtifactId);
  if (!source) throw new Error("成果物が見つかりません");
  if (!source.canRegenerate) throw new Error("この成果物は再生成できません");
  const artifactId = uuidV7(); const now = new Date().toISOString();
  db.prepare(`INSERT INTO backup_artifacts (artifact_id,event_id,business_date,cashbox_id,cash_session_id,source_cash_check_id,trigger_kind,retry_of_artifact_id,request_key,state,requested_by,requested_at)
    VALUES (?,?,?,?,?,?,'manual_regeneration',?,?,'pending',?,?)`).run(artifactId, source.eventId, source.businessDate, source.cashboxId, source.cashSessionId, source.sourceCashCheckId, source.artifactId, `manual:${requestKey}`, requestedBy ?? null, now);
  return getBackupArtifact(db, artifactId)!;
}

export function recoverInterruptedBackupArtifacts(db: PosDatabase): number {
  const now = new Date().toISOString();
  const result = db.prepare("UPDATE backup_artifacts SET state='failed',completed_at=?,error_code='INTERRUPTED',error_message='前回の成果物生成は完了確認前に中断しました' WHERE state='generating'").run(now);
  return Number(result.changes);
}
