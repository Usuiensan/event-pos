import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { getBackupArtifact, type BackupArtifactRecord } from "./backup-artifact-schema.js";
import { BackupArtifactWorker, verifySnapshotDatabase } from "./backup-artifacts.js";

const apps: ReturnType<typeof buildApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const catalog = {
  eventId: "event-backup", customerWelcome: { circleName: "バックアップ試験" },
  products: [{ productCode: "00000001", name: "新刊", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", internalToken: "P1BACKUP" }], quickEntries: [], autoDiscountRules: [],
};

async function waitForArtifact(db: ReturnType<typeof openDatabase>, artifactId: string, state: "completed" | "failed"): Promise<BackupArtifactRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const artifact = getBackupArtifact(db, artifactId);
    if (artifact?.state === state) return artifact;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`成果物 ${artifactId} が ${state} になりませんでした`);
}

async function createSale(app: ReturnType<typeof buildApp>): Promise<void> {
  expect((await app.inject({ method: "PUT", url: "/api/v1/events/event-backup/catalog", payload: catalog })).statusCode).toBe(200);
  const created = (await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: catalog.eventId, staffId: "staff-1", terminalId: "register-1", businessDate: "2026-08-03", sessionNo: 1 } })).json();
  const sessionId = "checkout:event-backup:2026-08-03:register-1";
  const opening = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/opening`, headers: { "idempotency-key": "backup-opening-1" }, payload: { counted: [], actorId: "staff-1", terminalId: "register-1" } });
  expect(opening.statusCode).toBe(201);
  const withLine = (await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${created.draftId}/lines`, headers: { "if-match": String(created.version) }, payload: { productCode: "00000001", quantity: 2, source: "manual" } })).json();
  const withPayment = (await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${created.draftId}/payments`, headers: { "if-match": String(withLine.version) }, payload: { kind: "cash", amountYen: 220, tenderedYen: 500 } })).json();
  const finalized = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${created.draftId}/finalize`, headers: { "idempotency-key": "backup-sale-1" }, payload: { version: withPayment.version } });
  expect(finalized.statusCode).toBe(201);
}

describe("Goal 8 backup artifacts", () => {
  it("中間計と精算からSQLite・単一xlsx・manifestを生成し、読戻しと別DB復元を照合する", async () => {
    const directory = mkdtempSync(join(tmpdir(), "event-pos-backup-artifact-")); directories.push(directory);
    const databasePath = join(directory, "source.sqlite"); const artifactRoot = join(directory, "artifacts");
    const db = openDatabase(databasePath); const app = buildApp({ database: db, artifactRoot }); apps.push(app);
    await createSale(app);
    const sessionId = "checkout:event-backup:2026-08-03:register-1";
    const interimResponse = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/interim`, payload: { counted: [{ denomination: 100, quantity: 2 }, { denomination: 10, quantity: 2 }], actorId: "staff-1", terminalId: "register-1" } });
    expect(interimResponse.statusCode).toBe(201);
    const interimId = interimResponse.json().backupArtifact.artifactId as string;
    const interim = await waitForArtifact(db, interimId, "completed");
    expect(interim).toMatchObject({ eventId: "event-backup", businessDate: "2026-08-03", cashboxId: "register-1", triggerKind: "interim", canRegenerate: false, rowCounts: { transactions: 1, transaction_lines: 1, payments: 1, inventory_movements: 1, cash_movements: 1, cash_checks: 2 } });
    for (const path of [interim.backupPath!, interim.workbookPath!, interim.manifestPath!]) expect(existsSync(path)).toBe(true);

    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(interim.workbookPath!);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["概要", "売上", "売上明細", "支払", "税", "在庫移動", "現金台帳", "点検締め", "印刷Operation", "監査"]);
    expect(workbook.getWorksheet("売上")?.getRow(2).getCell(9).value).toBe(220);
    expect(workbook.getWorksheet("支払")?.getRow(2).getCell(6).value).toBe(220);
    expect(workbook.getWorksheet("税")?.getRow(2).getCell(7).value).toBe(20);
    expect(workbook.getWorksheet("現金台帳")?.getRow(2).getCell(4).value).toBe(220);
    for (const sheet of workbook.worksheets) { expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 }); expect(sheet.autoFilter).toBeTruthy(); }

    const manifest = JSON.parse(readFileSync(interim.manifestPath!, "utf8"));
    expect(manifest).toMatchObject({ artifactId: interim.artifactId, snapshotLogicalSha256: interim.snapshotLogicalSha256, rowCounts: interim.rowCounts, totals: { sales_yen: 220, payments_yen: 220, tax_yen: 20, cash_ledger_yen: 220 }, files: { backup: { sha256: interim.backupSha256 }, workbook: { sha256: interim.workbookSha256 } } });
    expect(interim.manifestSha256).toMatch(/^[0-9a-f]{64}$/);

    const sourceVerification = verifySnapshotDatabase(databasePath, interim);
    const restorePath = join(directory, "restored.sqlite"); copyFileSync(interim.backupPath!, restorePath);
    const restoredVerification = verifySnapshotDatabase(restorePath, interim);
    expect(restoredVerification).toEqual(sourceVerification);
    expect(restoredVerification).toMatchObject({ integrityCheck: "ok", logicalSha256: interim.snapshotLogicalSha256, rowCounts: { transactions: 1, payments: 1, inventory_movements: 1, cash_movements: 1, audit_log: expect.any(Number), printer_operations: expect.any(Number) } });
    const restored = new DatabaseSync(restorePath, { readOnly: true });
    expect(restored.prepare("SELECT COUNT(*) AS count,SUM(total_yen) AS total FROM transactions").get()).toEqual({ count: 1, total: 220 }); restored.close();

    const closingResponse = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/closing`, payload: { counted: [{ denomination: 100, quantity: 2 }, { denomination: 10, quantity: 2 }], carryoverYen: 220, actorId: "manager-1", terminalId: "register-1" } });
    expect(closingResponse.statusCode).toBe(201);
    const closing = await waitForArtifact(db, closingResponse.json().backupArtifact.artifactId, "completed");
    expect(closing).toMatchObject({ triggerKind: "closing", state: "completed", rowCounts: { cash_checks: 3 } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM backup_artifacts WHERE trigger_kind IN ('interim','closing')").get()).toEqual({ count: 2 });
  }, 30_000);

  it("容量不足相当の失敗でも精算を保持し、再起動後の責任者再生成を冪等に行う", async () => {
    const directory = mkdtempSync(join(tmpdir(), "event-pos-backup-failure-")); directories.push(directory);
    const databasePath = join(directory, "source.sqlite"); const artifactRoot = join(directory, "artifacts");
    const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    let db = openDatabase(databasePath); let app = buildApp({ database: db, artifactRoot, backupArtifactFailureInjector: (stage) => { if (stage === "after_snapshot") throw full; } }); apps.push(app);
    await createSale(app);
    const sessionId = "checkout:event-backup:2026-08-03:register-1";
    const closingResponse = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/closing`, payload: { counted: [{ denomination: 100, quantity: 2 }, { denomination: 10, quantity: 2 }], carryoverYen: 220, actorId: "manager-1", terminalId: "register-1" } });
    expect(closingResponse.statusCode).toBe(201);
    const failed = await waitForArtifact(db, closingResponse.json().backupArtifact.artifactId, "failed");
    expect({ state: failed.state, errorCode: failed.errorCode, errorMessage: failed.errorMessage, canRegenerate: failed.canRegenerate }).toEqual({ state: "failed", errorCode: "STORAGE_FULL", errorMessage: "no space left on device", canRegenerate: true });
    expect(db.prepare("SELECT state,closing_yen FROM cash_sessions WHERE session_id=?").get(sessionId)).toEqual({ state: "closed", closing_yen: 220 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM cash_checks WHERE kind='closing'").get()).toEqual({ count: 1 });

    await app.close(); apps.splice(apps.indexOf(app), 1);
    db = openDatabase(databasePath); db.prepare("UPDATE backup_artifacts SET state='generating' WHERE artifact_id=?").run(failed.artifactId); db.close();
    db = openDatabase(databasePath); app = buildApp({ database: db, artifactRoot }); apps.push(app);
    const interrupted = getBackupArtifact(db, failed.artifactId)!;
    expect(interrupted).toMatchObject({ state: "failed", errorCode: "INTERRUPTED", canRegenerate: true });
    const headers = { "x-pos-role": "manager", "x-pos-actor-id": "manager-1", "idempotency-key": "retry-closing-1" };
    const first = await app.inject({ method: "POST", url: `/api/v1/backup-artifacts/${failed.artifactId}/regenerate`, headers });
    const replay = await app.inject({ method: "POST", url: `/api/v1/backup-artifacts/${failed.artifactId}/regenerate`, headers });
    expect(first.statusCode).toBe(202); expect(replay.statusCode).toBe(202); expect(replay.json().artifactId).toBe(first.json().artifactId);
    const regenerated = await waitForArtifact(db, first.json().artifactId, "completed");
    expect(regenerated).toMatchObject({ triggerKind: "manual_regeneration", retryOfArtifactId: failed.artifactId, state: "completed" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM backup_artifacts WHERE retry_of_artifact_id=?").get(failed.artifactId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='backup_artifact_completed' AND entity_id=?").get(regenerated.artifactId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='backup_artifact_regeneration_requested' AND entity_id=?").get(regenerated.artifactId)).toEqual({ count: 1 });
  }, 30_000);

  it("二つのworkerが同じpending成果物を同時生成しても一度だけ公開する", async () => {
    const directory = mkdtempSync(join(tmpdir(), "event-pos-backup-claim-")); directories.push(directory);
    const databasePath = join(directory, "source.sqlite"); const artifactRoot = join(directory, "artifacts");
    const db = openDatabase(databasePath); const app = buildApp({ database: db }); apps.push(app);
    await createSale(app);
    const sessionId = "checkout:event-backup:2026-08-03:register-1";
    const interim = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/interim`, payload: { counted: [{ denomination: 100, quantity: 2 }, { denomination: 10, quantity: 2 }] } });
    const artifactId = interim.json().backupArtifact.artifactId as string;
    expect(getBackupArtifact(db, artifactId)?.state).toBe("pending");
    const first = new BackupArtifactWorker(db, artifactRoot); const second = new BackupArtifactWorker(db, artifactRoot);
    first.trigger(); second.trigger(); await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(getBackupArtifact(db, artifactId)).toMatchObject({ state: "completed", attemptCount: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='backup_artifact_completed' AND entity_id=?").get(artifactId)).toEqual({ count: 1 });
    await Promise.all([first.stop(), second.stop()]);
  }, 30_000);
});
