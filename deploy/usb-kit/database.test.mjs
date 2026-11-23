import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createDatabaseSession, lockLocalDirectory } from "./database.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "event-pos-usb-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { kit: join(root, "kit"), local: join(root, "local"), root };
}

function seed(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE event_catalogs(id TEXT PRIMARY KEY); INSERT INTO event_catalogs VALUES ('initial')");
  db.close();
}

function ids(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM event_catalogs ORDER BY id").all().map(({ id }) => id);
  } finally {
    db.close();
  }
}

test("強制終了後に、同じPCとUSBでのみWAL内の確定データを復旧する", async (t) => {
  const { kit, local, root } = fixture(t);
  const start = new URL("./database.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    import { createDatabaseSession, lockLocalDirectory } from ${JSON.stringify(start)};
    const [kit, local] = process.argv.slice(1);
    const lock = lockLocalDirectory(local);
    const session = createDatabaseSession(kit, local, () => "USB-A");
    await session.start((path) => {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE event_catalogs(id TEXT PRIMARY KEY); INSERT INTO event_catalogs VALUES ('initial')");
      db.close();
    });
    const db = new DatabaseSync(session.localDb);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO event_catalogs VALUES ('committed'); BEGIN; INSERT INTO event_catalogs VALUES ('uncommitted')");
    console.log("ready");
    setInterval(() => {}, 1000);
  `, kit, local], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const exited = once(child, "exit");
  t.after(() => child.kill("SIGKILL"));
  const output = once(child.stdout, "data");
  const result = await Promise.race([output, exited]);
  assert.match(String(result[0]), /ready/);
  assert.throws(() => lockLocalDirectory(local), /既に起動中/);
  child.kill("SIGKILL");
  await exited;

  const wrongPc = createDatabaseSession(kit, join(root, "another-pc"), () => "USB-A");
  await assert.rejects(wrongPc.start(seed), /別のPCまたはユーザー/);
  const clonedKit = join(root, "cloned-kit");
  cpSync(kit, clonedKit, { recursive: true });
  const wrongUsb = createDatabaseSession(clonedKit, local, () => "USB-B");
  await assert.rejects(wrongUsb.start(seed), /別のUSB/);
  assert.deepEqual(ids(wrongUsb.usbDb), ["initial"]);

  const recovered = createDatabaseSession(kit, local, () => "USB-A");
  await recovered.start(() => assert.fail("既存DBを初期化した"));
  assert.deepEqual(ids(recovered.usbDb), ["committed", "initial"]);
  assert.deepEqual(ids(recovered.localDb), ["committed", "initial"]);
  assert.equal(await recovered.sync(), true);
});

test("初期化の中断後に同じUSBで準備をやり直せる", async (t) => {
  const { kit, local } = fixture(t);
  const session = createDatabaseSession(kit, local, () => "USB-A");
  await assert.rejects(session.start(() => { throw new Error("初期化中断"); }), /初期化中断/);
  const retried = createDatabaseSession(kit, local, () => "USB-A");
  await retried.start(seed);
  assert.deepEqual(ids(retried.usbDb), ["initial"]);
  assert.equal(await retried.sync(), true);
});

test("USBの差し替えや破損したローカルDBではUSBのDBを書き換えない", async (t) => {
  const { kit, local } = fixture(t);
  let volume = "USB-A";
  const session = createDatabaseSession(kit, local, () => volume);
  await session.start(seed);
  volume = "USB-B";
  await assert.rejects(session.sync(), /同じUSBを確認できません/);
  volume = "USB-A";
  writeFileSync(session.localDb, "corrupted");
  const reopened = createDatabaseSession(kit, local, () => volume);
  await assert.rejects(reopened.start(seed));
  assert.deepEqual(ids(session.usbDb), ["initial"]);
});

test("旧版の復旧情報を保持する", async (t) => {
  const { kit, local } = fixture(t);
  const marker = join(local, "usb-sync-in-progress");
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "old sync marker");
  const session = createDatabaseSession(kit, local, () => "USB-A");
  await assert.rejects(session.start(seed), /旧版または読み取れない復旧情報/);
});

test("稼働中に確定データをUSBへ保存し、差し替えからの復帰時にも再試行できる", async (t) => {
  const { kit, local, root } = fixture(t);
  let volume = "USB-A";
  const session = createDatabaseSession(kit, local, () => volume);
  await session.start(seed);
  const db = new DatabaseSync(session.localDb);
  try {
    db.exec("PRAGMA journal_mode=WAL; INSERT INTO event_catalogs VALUES ('sale-1')");
    assert.equal(await session.checkpoint(), true);
    assert.equal(await session.checkpoint(), false);
    assert.deepEqual(ids(session.usbDb), ["initial", "sale-1"]);

    volume = "USB-B";
    db.exec("INSERT INTO event_catalogs VALUES ('sale-2')");
    await assert.rejects(session.checkpoint(), /同じUSBを確認できません/);
    assert.deepEqual(ids(session.localDb), ["initial", "sale-1", "sale-2"]);
    assert.deepEqual(ids(session.usbDb), ["initial", "sale-1"]);

    volume = "USB-A";
    db.exec("BEGIN; INSERT INTO event_catalogs VALUES ('uncommitted')");
    assert.equal(await session.checkpoint(), true);
    assert.deepEqual(ids(session.usbDb), ["initial", "sale-1", "sale-2"]);
    db.exec("ROLLBACK");
    const wrongPc = createDatabaseSession(kit, join(root, "another-pc"), () => volume);
    await assert.rejects(wrongPc.start(seed), /別のPCまたはユーザー/);
  } finally {
    db.close();
    await session.sync();
  }
});
