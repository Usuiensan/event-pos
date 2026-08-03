import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { getCatalog, openDatabase } from "./db.js";
import { signInForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function createConfigRepository(): { repository: string; configDirectory: string; otherConfigDirectory: string } {
  const repository = mkdtempSync(join(tmpdir(), "event-pos-config-management-"));
  directories.push(repository);
  const configDirectory = join(repository, "event-config", "demo");
  const otherConfigDirectory = join(repository, "event-config", "other");
  cpSync(resolve(import.meta.dirname, "../../../event-config/demo"), configDirectory, { recursive: true });
  cpSync(configDirectory, otherConfigDirectory, { recursive: true });
  writeFileSync(join(repository, "notes.txt"), "initial\n", "utf8");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "event-pos test"]);
  git(repository, ["config", "user.email", "event-pos@example.test"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "初期設定"]);
  return { repository, configDirectory, otherConfigDirectory };
}

async function managementFixture() {
  const fixture = createConfigRepository();
  const database = openDatabase();
  const app = buildApp({ database, requireAuth: true, eventConfigDirectory: fixture.configDirectory, eventConfigRepository: fixture.repository });
  apps.push(app);
  const reloaded = await app.inject({ method: "POST", url: "/api/v1/events/demo-event-large/catalog/reload", payload: {} });
  expect(reloaded.statusCode).toBe(200);
  const headers = await signInForTest(app, { eventId: "demo-event-large", responsibleNumber: "001", terminalId: "management-console" });
  return { ...fixture, database, app, headers, catalog: reloaded.json().catalog as { eventId: string; products: Array<{ name: string }> } };
}

describe("管理画面設定のGit確定", () => {
  it("対象イベント設定の手編集と画面編集を同じコミットへまとめ、設定外は残す", async () => {
    const { repository, configDirectory, otherConfigDirectory, app, headers, catalog } = await managementFixture();
    const gs1Path = join(configDirectory, "gs1-company-prefixes-jp.yaml");
    writeFileSync(gs1Path, `${readFileSync(gs1Path, "utf8").trimEnd()}\n# 手編集を保持\n`, "utf8");
    writeFileSync(join(otherConfigDirectory, "event.yaml"), `${readFileSync(join(otherConfigDirectory, "event.yaml"), "utf8").trimEnd()}\n# 別イベント\n`, "utf8");
    writeFileSync(join(repository, "notes.txt"), "作業中のコード外メモ\n", "utf8");
    catalog.products[0]!.name = "管理画面で更新した商品";

    const saved = await app.inject({ method: "PUT", url: "/api/v1/events/demo-event-large/management-config", headers, payload: { catalog } });
    expect(saved.statusCode).toBe(200);
    const commitId = saved.json().gitCommitId as string;
    expect(commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(gs1Path, "utf8")).toContain("# 手編集を保持");
    const committedPaths = git(repository, ["show", "--format=", "--name-only", commitId]);
    expect(committedPaths).toContain("event-config/demo/gs1-company-prefixes-jp.yaml");
    expect(committedPaths).toContain("event-config/demo/");
    expect(committedPaths).not.toContain("event-config/other/");
    expect(committedPaths).not.toContain("notes.txt");
    expect(git(repository, ["status", "--porcelain", "--", "event-config/demo"])).toBe("");
    expect(git(repository, ["status", "--porcelain", "--", "event-config/other"])).not.toBe("");
    expect(git(repository, ["status", "--porcelain", "--", "notes.txt"])).not.toBe("");

    const head = git(repository, ["rev-parse", "HEAD"]);
    const unchanged = await app.inject({ method: "PUT", url: "/api/v1/events/demo-event-large/management-config", headers, payload: { catalog: saved.json().catalog } });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json().gitCommitId).toBeNull();
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("Gitコミット失敗時はSQLiteと監査ログを更新しない", async () => {
    const { repository, configDirectory, database, app, headers, catalog } = await managementFixture();
    const before = getCatalog(database, "demo-event-large")!;
    const hookDirectory = join(repository, ".git", "hooks");
    mkdirSync(hookDirectory, { recursive: true });
    const hook = join(hookDirectory, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(hook, 0o755);
    catalog.products[0]!.name = "コミット失敗時の商品";

    const failed = await app.inject({ method: "PUT", url: "/api/v1/events/demo-event-large/management-config", headers, payload: { catalog } });
    expect(failed.statusCode).toBe(400);
    expect(getCatalog(database, "demo-event-large")).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='management_config_saved'").get()).toEqual({ count: 0 });
    expect(git(repository, ["status", "--porcelain", "--", configDirectory])).not.toBe("");
  });
});
