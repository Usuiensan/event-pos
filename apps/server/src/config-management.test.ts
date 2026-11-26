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

function copyCommittedDemo(destination: string): void {
  const sourceRepository = resolve(import.meta.dirname, "../../..");
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "cf02719", "event-config/demo"], { cwd: sourceRepository, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const file of files) {
    const path = join(destination, file.slice("event-config/demo/".length));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, execFileSync("git", ["show", `cf02719:${file}`], { cwd: sourceRepository, encoding: "utf8" }), "utf8");
  }
}

function createConfigRepository(): { repository: string; configDirectory: string; otherConfigDirectory: string } {
  const repository = mkdtempSync(join(tmpdir(), "event-pos-config-management-"));
  directories.push(repository);
  const configDirectory = join(repository, "event-config", "demo");
  const otherConfigDirectory = join(repository, "event-config", "other");
  copyCommittedDemo(configDirectory);
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
  it("商品設定と営業状態を同じ応答スナップショットで返す", async () => {
    const { app, headers } = await managementFixture();
    const before = await app.inject({ method: "GET", url: "/api/v1/events/demo-event-large/management-config", headers });
    expect(before.statusCode).toBe(200);
    expect(before.json().businessSession).toBeNull();
    const opened = await app.inject({ method: "POST", url: "/api/v1/business-sessions", headers, payload: { eventId: "demo-event-large", businessDate: "2026-10-25", terminalId: "management-console" } });
    expect(opened.statusCode).toBe(201);
    const after = await app.inject({ method: "GET", url: "/api/v1/events/demo-event-large/management-config", headers });
    expect(after.json().businessSession).toMatchObject({ businessSessionId: opened.json().businessSessionId, state: "open" });
  });

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
});

describe("認証オフ時の管理画面設定", () => {
  async function noAuthFixture() {
    const directory = mkdtempSync(join(tmpdir(), "event-pos-config-noauth-"));
    directories.push(directory);
    const configDirectory = join(directory, "demo");
    cpSync(resolve(import.meta.dirname, "../../../event-config/demo"), configDirectory, { recursive: true });
    const database = openDatabase();
    const app = buildApp({ database, requireAuth: false, eventConfigDirectory: configDirectory });
    apps.push(app);
    const reloaded = await app.inject({ method: "POST", url: "/api/v1/events/demo-event-large/catalog/reload", payload: {} });
    expect(reloaded.statusCode).toBe(200);
    return { app, database, catalog: reloaded.json().catalog as { eventId: string; products: Array<{ name: string }> } };
  }

  it("認証オフでも管理設定を保存できる", async () => {
    const { app, catalog } = await noAuthFixture();
    catalog.products[0]!.name = "認証オフで更新した商品";
    const saved = await app.inject({ method: "PUT", url: "/api/v1/events/demo-event-large/management-config", payload: { catalog } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().catalog.products[0].name).toBe("認証オフで更新した商品");
  });

  it("認証オフでも未登録商品一覧を取得できる", async () => {
    const { app } = await noAuthFixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/events/demo-event-large/unregistered-products" });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().products)).toBe(true);
  });

  it("認証オフでもURLとカタログのeventIdが違えば保存できない", async () => {
    const { app, catalog } = await noAuthFixture();
    const failed = await app.inject({ method: "PUT", url: "/api/v1/events/other-event/management-config", payload: { catalog } });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error.message).toContain("eventIdが一致しません");
  });
});

describe("管理画面設定のGit確定", () => {
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

describe("最後の管理者の保護（F-078）", () => {
  async function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "event-pos-config-last-admin-"));
    directories.push(directory);
    const configDirectory = join(directory, "demo");
    cpSync(resolve(import.meta.dirname, "../../../event-config/demo"), configDirectory, { recursive: true });
    const database = openDatabase();
    const app = buildApp({ database, requireAuth: false, eventConfigDirectory: configDirectory });
    apps.push(app);
    const reloaded = await app.inject({ method: "POST", url: "/api/v1/events/demo-event-large/catalog/reload", payload: {} });
    expect(reloaded.statusCode).toBe(200);
    return { app, database, configDirectory, catalog: reloaded.json().catalog as { eventId: string; staffMembers: Array<{ responsibleNumber: string; displayName: string; role?: string }> } };
  }

  it("管理画面保存で唯一の管理者001を降格すると拒否され、YAML・カタログ・割当が変わらない", async () => {
    const { app, database, configDirectory, catalog } = await fixture();
    const before = getCatalog(database, "demo-event-large")!;
    const staffYamlBefore = readFileSync(join(configDirectory, "staff.yaml"), "utf8");
    const demoted = structuredClone(catalog);
    demoted.staffMembers = demoted.staffMembers.map((member) => member.responsibleNumber === "001" ? { ...member, role: "operator" } : member);
    const rejected = await app.inject({ method: "PUT", url: "/api/v1/events/demo-event-large/management-config", payload: { catalog: demoted } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({ code: "LAST_ACTIVE_ADMIN" });
    expect(getCatalog(database, "demo-event-large")).toEqual(before);
    expect(readFileSync(join(configDirectory, "staff.yaml"), "utf8")).toBe(staffYamlBefore);
    expect(database.prepare("SELECT role FROM event_staff_assignments WHERE event_id='demo-event-large' AND responsible_number='001' AND active=1").get()).toEqual({ role: "admin" });
  });

  it("別の担当者を管理者へ昇格させる保存なら001を降格できる", async () => {
    const { app, catalog } = await fixture();
    const handedOver = structuredClone(catalog);
    handedOver.staffMembers = handedOver.staffMembers.map((member) => member.responsibleNumber === "001" ? { ...member, role: "operator" } : { ...member, role: "admin" });
    const saved = await app.inject({ method: "PUT", url: "/api/v1/events/demo-event-large/management-config", payload: { catalog: handedOver } });
    expect(saved.statusCode).toBe(200);
    const signIn = await app.inject({ method: "POST", url: "/api/v1/auth/sessions", payload: { eventId: "demo-event-large", responsibleNumber: "002", terminalId: "register-1" } });
    expect(signIn.json().actor).toMatchObject({ responsibleNumber: "002", role: "admin" });
  });
});
