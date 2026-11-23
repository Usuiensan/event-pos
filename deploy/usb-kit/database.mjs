import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export function lockLocalDirectory(root) {
  mkdirSync(root, { recursive: true });
  const lock = new DatabaseSync(join(root, "launch-lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock.close();
    throw new Error("このPCではUSBキットが既に起動中です。", { cause: error });
  }
}

function checkIntegrity(db, path) {
  const checks = db.prepare("PRAGMA integrity_check").all();
  if (checks.length !== 1 || checks[0].integrity_check !== "ok" ||
      !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='event_catalogs'").get()) {
    throw new Error(`POSのSQLite DBを確認できません: ${path}`);
  }
}

export async function copyDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });
  const temporary = !existsSync(destination) ? `${destination}.new` : undefined;
  try {
    checkIntegrity(db, source);
    if (temporary) removeDatabase(temporary);
    // SQLiteのバックアップでWAL内の確定済みページを含め、書き戻しをトランザクションで行う。
    await backup(db, temporary ?? destination);
    const copy = new DatabaseSync(temporary ?? destination, { readOnly: true });
    try {
      checkIntegrity(copy, destination);
    } finally {
      copy.close();
    }
    if (temporary) renameSync(temporary, destination);
  } finally {
    db.close();
  }
}

function removeDatabase(db) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(db + suffix, { force: true });
}

function readLocalSession(marker) {
  if (!existsSync(marker)) return undefined;
  try {
    const session = JSON.parse(readFileSync(marker, "utf8"));
    if (session.kitId && session.volume && session.id) return session;
  } catch {}
  throw new Error(`旧版または読み取れない復旧情報があります。ローカルDBを保持しました: ${dirname(marker)}`);
}

export function createDatabaseSession(kit, localRoot, volumeId) {
  const usbDb = join(kit, "data", "event-pos.sqlite");
  const localDb = join(localRoot, "data", "event-pos.sqlite");
  const marker = join(localRoot, "usb-sync-in-progress");
  const stateFile = join(dirname(usbDb), ".usb-kit-state.sqlite");
  mkdirSync(dirname(usbDb), { recursive: true });
  mkdirSync(dirname(localDb), { recursive: true });

  function withState(action, expectedVolume) {
    if (expectedVolume !== undefined && volumeId() !== expectedVolume) {
      throw new Error("起動時と同じUSBを確認できません。元のUSBを挿して再起動してください。");
    }
    const db = new DatabaseSync(stateFile);
    try {
      db.exec(`PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS usb_session (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          kit_id TEXT NOT NULL,
          session_id TEXT,
          active INTEGER NOT NULL DEFAULT 0
        )`);
      db.prepare("INSERT OR IGNORE INTO usb_session(singleton, kit_id) VALUES (1, ?)").run(randomUUID());
      return action(db, db.prepare("SELECT * FROM usb_session WHERE singleton = 1").get());
    } finally {
      db.close();
    }
  }

  let session;
  let versionDb;
  let savedVersion;

  function assertOwner(state, owner) {
    if (state.kit_id !== owner.kitId || state.session_id !== owner.id) {
      throw new Error("USBの復旧情報が一致しません。ローカルDBを保持しました。");
    }
  }

  async function saveToUsb(owner) {
    withState((_db, state) => assertOwner(state, owner), owner.volume);
    await copyDatabase(localDb, usbDb);
  }

  async function checkpoint() {
    if (!session) return false;
    versionDb ??= new DatabaseSync(localDb, { readOnly: true });
    const { data_version: version } = versionDb.prepare("PRAGMA data_version").get();
    if (version === savedVersion) return false;
    await saveToUsb(session);
    // コピー中に追加の確定があれば次回も保存する。
    savedVersion = version;
    return true;
  }

  async function writeBack(owner) {
    await saveToUsb(owner);
    withState((db, state) => {
      assertOwner(state, owner);
      db.exec("UPDATE usb_session SET session_id = NULL, active = 0 WHERE singleton = 1");
    }, owner.volume);
    rmSync(marker);
  }

  async function sync() {
    if (!session) return false;
    versionDb?.close();
    versionDb = undefined;
    savedVersion = undefined;
    await writeBack(session);
    session = undefined;
    return true;
  }

  async function start(initialize) {
    const previous = readLocalSession(marker);
    const volume = volumeId();
    const state = withState((_db, row) => row, volume);
    if (previous && (previous.kitId !== state.kit_id || previous.volume !== volume)) {
      throw new Error("このPCに別のUSBの未同期データがあります。元のUSBを挿して起動してください。");
    }
    if (state.session_id && previous?.id !== state.session_id) {
      throw new Error("このUSBに別のPCまたはユーザーの未同期データがあります。前回と同じPC・ユーザーで起動してください。");
    }
    // 準備中はUSBが正本。稼働状態になった後は書き戻しが終わるまでローカルDBが正本。
    if (state.active) {
      console.log("前回の終了後に残ったDBを検査し、USBへ自動復旧します。");
      await writeBack(previous);
      console.log("DBの自動復旧が完了しました。");
    }

    const next = { kitId: state.kit_id, volume, id: state.active ? randomUUID() : previous?.id ?? randomUUID() };
    // USBに使用中と記録する前に、同じPCで再開するための情報を保存する。
    writeFileSync(`${marker}.new`, JSON.stringify(next), { flush: true });
    renameSync(`${marker}.new`, marker);
    withState((db, row) => {
      if (row.kit_id !== next.kitId || row.session_id && row.session_id !== state.session_id) {
        throw new Error("別の起動処理がこのUSBを使用中です。");
      }
      const result = db.prepare(`UPDATE usb_session SET session_id = ?, active = 0
        WHERE singleton = 1 AND (session_id IS NULL OR session_id = ?)`).run(next.id, state.active ? null : state.session_id);
      if (result.changes !== 1) throw new Error("別の起動処理がこのUSBを使用中です。");
    }, volume);

    removeDatabase(localDb);
    if (existsSync(usbDb)) {
      await copyDatabase(usbDb, localDb);
    } else {
      await initialize(localDb);
      await copyDatabase(localDb, usbDb);
    }
    withState((db) => {
      const result = db.prepare("UPDATE usb_session SET active = 1 WHERE session_id = ?").run(next.id);
      if (result.changes !== 1) throw new Error("USBの起動情報が変化しました。");
    }, volume);
    session = next;
  }

  return { start, checkpoint, sync, localDb, usbDb };
}
