// event-pos USBキット アップデーター（macOS版）
// GitHub Releases の配布ペイロードを取得し、検証してからキットへ反映する。
// 手順と安全策は Windows 版 update-usb-kit.ps1 の GitHub モードと揃えてある。
// KitUpdaterBootstrap: v1
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const kit = dirname(fileURLToPath(import.meta.url));
const localRoot = join(homedir(), "Library", "Application Support", "EventPos", "UsbKit");
const backup = join(localRoot, "update-backup");
const statePath = join(localRoot, "update-state.json");
const lockDir = join(localRoot, "update-lock");
const lockPidPath = join(lockDir, "pid");
const repoSlug = "Usuiensan/event-pos";
const assetName = "event-pos-kit-payload.zip";
const dbPath = join(kit, "data", "event-pos.sqlite");
const initialPath = join(kit, "event-config", "usb-kit-initial");

function sha256Hex(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

async function fileDigest(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return sha256Hex(path);
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

async function treeDigest(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  const lines = [];
  for (const full of listFiles(path)) {
    const rel = full.slice(path.length).replace(/^\//, "");
    lines.push(`${rel}=${await sha256Hex(full)}`);
  }
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex").toUpperCase();
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ビルド／ペイロードが上書きする範囲だけを退避・復旧の対象にする。
// data（本番DB）は対象に含めない。更新が中断した後に営業が再開されていた場合、
// 起動時復旧が data を退避時点へ戻すと、その間の売上が丸ごと消えるため（F-064）。
// DB は更新経路のどこからも書き換えられず、変化は compareProtected で検出する。
// 許可リストが書き込みうる範囲（server / printer-host / web の全体）と一致させる。
// 退避範囲が狭いと、検証を通ったファイルが復旧から漏れる。
const scopedDirs = ["server", "printer-host", "web", "runtime", "event-config/usb-kit-initial"];
const rootFiles = ["initialize-usb-kit.ps1", "start-usb-kit.ps1", "Start-USB-Kit.bat", "Update-USB-Kit.bat", "update-usb-kit.ps1", "README.md", ".event-pos-usb-kit", "printer-host.env", "Recover-USB-Kit-DB.bat", "Recover-USB-Kit-DB.ps1", "Start-USB-Kit.command", "printer-host-macos.env", "Update-USB-Kit.command", "update-usb-kit.mjs"];

function backupScoped() {
  for (const rel of scopedDirs) {
    const src = join(kit, rel);
    if (existsSync(src)) {
      const dst = join(backup, rel);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
  }
  for (const name of rootFiles) {
    const src = join(kit, name);
    if (existsSync(src) && statSync(src).isFile()) copyFileSync(src, join(backup, name));
  }
}

function restoreScoped() {
  for (const rel of scopedDirs) {
    const dst = join(kit, rel);
    const src = join(backup, rel);
    rmSync(dst, { recursive: true, force: true });
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
  }
  for (const name of rootFiles) {
    const dst = join(kit, name);
    const src = join(backup, name);
    if (existsSync(src)) copyFileSync(src, dst);
    else rmSync(dst, { force: true });
    if (name.endsWith(".command") && existsSync(dst)) chmodSync(dst, 0o755);
  }
  for (const stale of ["update-usb-kit.ps1.new", "Update-USB-Kit.bat.new", "update-usb-kit.mjs.new", "Update-USB-Kit.command.new"]) {
    rmSync(join(kit, stale), { force: true });
  }
}

async function protectedDigests() {
  return {
    db: await fileDigest(dbPath),
    dbWal: await fileDigest(`${dbPath}-wal`),
    dbShm: await fileDigest(`${dbPath}-shm`),
    initialConfig: await treeDigest(initialPath),
    printerEnv: await fileDigest(join(kit, "printer-host.env")),
  };
}

async function compareProtected(before) {
  const problems = [];
  if ((await fileDigest(dbPath)) !== before.db) problems.push("DBが変化しています");
  if ((await fileDigest(`${dbPath}-wal`)) !== before.dbWal) problems.push("DB(WAL)が変化しています");
  if ((await fileDigest(`${dbPath}-shm`)) !== before.dbShm) problems.push("DB(SHM)が変化しています");
  if ((await treeDigest(initialPath)) !== before.initialConfig) problems.push("初期設定（usb-kit-initial）が変化しています");
  const envChanged = (await fileDigest(join(kit, "printer-host.env"))) !== before.printerEnv;
  return { problems, envChanged };
}

// PowerShell 5.1 の Set-Content -Encoding UTF8 は BOM を付けるため、
// Windows 側が書いた JSON（manifest / kit-version.json）を読むときは BOM を落とす。
function parseJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); // 先頭は U+FEFF（BOM）
}

function writeState(status) {
  mkdirSync(localRoot, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ status, at: new Date().toISOString(), kit }));
}

function clearState() {
  rmSync(statePath, { force: true });
}

function pickNode() {
  const candidates = process.arch === "arm64"
    ? [join(kit, "runtime", "node-arm64"), join(kit, "runtime", "node")]
    : [join(kit, "runtime", "node-x64"), join(kit, "runtime", "node")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function smokeTest() {
  return new Promise((resolve) => {
    const node = pickNode();
    if (!node) return resolve(false);
    const smokeDir = join(tmpdir(), `event-pos-smoke-${process.pid}-${Date.now()}`);
    mkdirSync(smokeDir, { recursive: true });
    const env = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "3199",
      POS_REQUIRE_AUTH: "0",
      POS_REQUIRE_HTTPS: "0",
      POS_DATABASE_PATH: join(smokeDir, "smoke.sqlite"),
      POS_ARTIFACT_ROOT: join(smokeDir, "artifacts"),
      POS_EVENT_CONFIG_DIR: initialPath,
      REGISTER_WEB_DIST: join(kit, "web"),
      PRINTER_HOST_URL: "http://127.0.0.1:4318",
      DRAWER_ENABLED: "0",
      NODE_ENV: "production",
    };
    const proc = spawn(node, [join(kit, "server", "dist", "index.js")], {
      cwd: join(kit, "server"),
      env,
      stdio: "ignore",
    });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { proc.kill("SIGKILL"); } catch { /* 終了済み */ }
      rmSync(smokeDir, { recursive: true, force: true });
      resolve(ok);
    };
    proc.on("exit", () => finish(false));
    proc.on("error", () => finish(false));
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      if (await httpOk("http://127.0.0.1:3199/api/v1/info")) {
        clearInterval(timer);
        finish(true);
      } else if (attempts >= 30) {
        clearInterval(timer);
        finish(false);
      }
    }, 1000);
  });
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "event-pos-usb-kit-updater", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) {
    const err = new Error("配布リリースがまだありません。先に publish-kit-release.ps1 でリリースを作成してください。");
    err.code = 404;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`リリース情報の取得に失敗しました（HTTP ${res.status}）。ネットワーク接続を確認してください。`);
  }
  return res.json();
}

function extractZip(zipPath, stage) {
  mkdirSync(stage, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", stage], { stdio: "pipe" });
  } catch {
    // unzip が無い環境向けの代替（macOS 標準の ditto）
    execFileSync("ditto", ["-x", "-k", zipPath, stage], { stdio: "pipe" });
  }
}

async function githubUpdate() {
  const feedBase = (process.env.EVENT_POS_KIT_FEED || `https://api.github.com/repos/${repoSlug}`).replace(/\/$/, "");
  let release;
  try {
    release = await fetchJson(`${feedBase}/releases/latest`);
  } catch (err) {
    if (err.code === 404) throw err;
    throw new Error(`リリース情報の取得に失敗しました。ネットワーク接続を確認してください: ${err.message}`);
  }
  const asset = (release.assets || []).find((a) => a.name === assetName);
  if (!asset) throw new Error(`リリース ${release.tag_name} に ${assetName} がありません。`);
  const assetDigest = asset.digest || null;
  const versionPath = join(kit, "kit-version.json");
  if (assetDigest && existsSync(versionPath)) {
    try {
      const v = parseJsonFile(versionPath);
      if (v.assetDigest === assetDigest) {
        console.log(`既に最新です（${release.tag_name}）。`);
        return;
      }
    } catch { /* kit-version.json が読めなければ更新を続ける */ }
  }
  console.log(`配布リリース ${release.tag_name} を取得します。`);

  const work = join(tmpdir(), `event-pos-ghupdate-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const zipPath = join(work, "payload.zip");
    const dlUrl = asset.browser_download_url || asset.url;
    let dlRes;
    try {
      dlRes = await fetch(dlUrl, {
        headers: { "User-Agent": "event-pos-usb-kit-updater" },
        signal: AbortSignal.timeout(600000),
      });
    } catch (err) {
      throw new Error(`ペイロードのダウンロードに失敗しました。ネットワーク接続を確認してください: ${err.message}`);
    }
    if (!dlRes.ok) throw new Error(`ペイロードのダウンロードに失敗しました（HTTP ${dlRes.status}）。`);
    writeFileSync(zipPath, Buffer.from(await dlRes.arrayBuffer()));
    const zipHash = (await sha256Hex(zipPath)).toLowerCase();
    if (assetDigest) {
      if (assetDigest !== `sha256:${zipHash}`) throw new Error("ダウンロードしたZIPのハッシュがリリース情報と一致しません。中断します。");
    } else {
      console.log("注意: リリースに digest 情報がないため、ZIP全体の照合は省略し、manifest で個別に検証します。");
    }
    const stage = join(work, "stage");
    extractZip(zipPath, stage);
    const manifestPath = join(stage, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("ペイロードに manifest.json がありません。");
    const manifest = parseJsonFile(manifestPath);
    if (manifest.format !== 1) throw new Error(`未対応のペイロード形式です: ${manifest.format}`);
    const entries = manifest.files || [];
    if (entries.length > 5000) throw new Error("ペイロードのファイル数が上限を超えています。");
    const totalSize = entries.reduce((sum, e) => sum + Number(e.size || 0), 0);
    if (totalSize > 314572800) throw new Error("ペイロードの合計サイズが上限を超えています。");
    const rootAllow = ["initialize-usb-kit.ps1", "start-usb-kit.ps1", "Start-USB-Kit.bat", "Update-USB-Kit.bat", "update-usb-kit.ps1", "README.md", "printer-host.env", ".event-pos-usb-kit", "Recover-USB-Kit-DB.bat", "Recover-USB-Kit-DB.ps1", "Start-USB-Kit.command", "printer-host-macos.env", "Update-USB-Kit.command", "update-usb-kit.mjs"];
    const seen = new Map();
    const blockedPaths = [];
    for (const e of entries) {
      const rel = String(e.path);
      if (rel.startsWith("/") || rel.split("/").includes("..") || /^[a-zA-Z]:/.test(rel) || rel.includes("\\")) {
        throw new Error(`ペイロードに不正なパスがあります: ${e.path}`);
      }
      const key = rel.toLowerCase();
      if (seen.has(key)) throw new Error(`ペイロードに重複したパスがあります: ${e.path}`);
      seen.set(key, e);
      const seg = rel.split("/");
      if (seg.length > 1) {
        if (!["server", "printer-host", "web"].includes(seg[0])) blockedPaths.push(e.path);
      } else if (!rootAllow.includes(seg[0])) {
        blockedPaths.push(e.path);
      }
      if (!["overwrite", "self", "create-only"].includes(e.class)) throw new Error(`ペイロードの分類が不正です: ${e.path}`);
      if (e.class === "self" && rel !== "update-usb-kit.ps1" && rel !== "update-usb-kit.mjs") {
        throw new Error(`self 分類は update-usb-kit.ps1 / update-usb-kit.mjs だけに使えます: ${e.path}`);
      }
      if (e.class === "create-only" && rel !== "printer-host.env" && rel !== "printer-host-macos.env") {
        throw new Error(`create-only 分類は printer-host.env / printer-host-macos.env だけに使えます: ${e.path}`);
      }
      if (Number(e.size) > 134217728) throw new Error(`ペイロードのファイルが大きすぎます: ${e.path}`);
      const f = join(stage, rel);
      if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`ペイロードにファイルが不足しています: ${e.path}`);
      if (statSync(f).size !== Number(e.size)) throw new Error(`ペイロードのサイズが manifest と一致しません: ${e.path}`);
      if ((await fileDigest(f)).toLowerCase() !== String(e.sha256).toLowerCase()) {
        throw new Error(`ペイロードのハッシュが manifest と一致しません: ${e.path}`);
      }
    }
    for (const full of listFiles(stage)) {
      const rel = full.slice(stage.length).replace(/^\//, "");
      if (rel.toLowerCase() === "manifest.json") continue;
      if (!seen.has(rel.toLowerCase())) throw new Error(`ペイロードに manifest へ記載のないファイルがあります: ${rel}`);
    }
    if (blockedPaths.length > 0) {
      const blockedList = blockedPaths.join(", ");
      const selfEntry = entries.find((e) => String(e.path) === "update-usb-kit.mjs");
      if (!selfEntry) {
        throw new Error(`ペイロードに許可されていないファイルがあります: ${blockedList}（新しいアップデーターがペイロードに含まれていないため、先行更新もできません）`);
      }
      const selfStage = join(stage, "update-usb-kit.mjs");
      const selfCurrent = join(kit, "update-usb-kit.mjs");
      if ((await fileDigest(selfStage)) === (await fileDigest(selfCurrent))) {
        throw new Error(`ペイロードに許可されていないファイルがあります: ${blockedList}（ペイロードのアップデーターも現行版と同じため、このままでは更新できません。配布側で中間リリースが必要です）`);
      }
      // ここまでの検証で ZIP digest と manifest、全ファイルの SHA256 は一致済み。
      // 検証済みの新アップデーターだけを .new へ置き、次回起動時に差し替えてから再実行してもらう（Update-USB-Kit.command が .new を差し替える）。
      copyFileSync(selfStage, join(kit, "update-usb-kit.mjs.new"));
      throw new Error(`現在のアップデーターが許可していないファイルがペイロードに含まれています: ${blockedList}\nアップデーターだけを先に更新しました。もう一度 Update-USB-Kit.command を実行してください（次回は新しいアップデーターで更新が進みます）。`);
    }
    console.log(`ペイロードの検証が終わりました（${entries.length} ファイル / コミット ${manifest.commit}）。`);

    const protectedBefore = await protectedDigests();
    rmSync(backup, { recursive: true, force: true });
    mkdirSync(backup, { recursive: true });
    backupScoped();
    writeState("applying");
    const problems = [];
    const skippedCreateOnly = new Set();
    const diverted = new Set();
    // 実行中になりうるファイル（アップデーター本体と両OSの更新ランチャー）は分類によらず
    // 名前で判定し、直接上書きせず .new へ退避する。次回起動時にランチャー冒頭で差し替える
    // （Update-USB-Kit.bat と同じ方式）。キット側にまだ無い場合は、そのまま実ファイルとして置く。
    const selfNames = new Set(["update-usb-kit.ps1", "update-usb-kit.mjs", "Update-USB-Kit.bat", "Update-USB-Kit.command"]);
    try {
      for (const e of entries) {
        const rel = String(e.path);
        const src = join(stage, rel);
        // create-only（現場のプリンター設定）は、キット側に既にあれば配布内容で上書きしない（F-065）
        if (e.class === "create-only" && existsSync(join(kit, rel))) {
          skippedCreateOnly.add(rel);
          console.log(`現場の設定を保持します（更新では上書きしません）: ${rel}`);
          continue;
        }
        if ((e.class === "self" || selfNames.has(rel)) && existsSync(join(kit, rel))) {
          copyFileSync(src, join(kit, `${rel}.new`));
          diverted.add(rel);
        } else {
          const dst = join(kit, rel);
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
          if (rel.endsWith(".command")) chmodSync(dst, 0o755);
        }
      }
    } catch (err) {
      problems.push(`適用に失敗しました: ${err.message}`);
    }
    if (problems.length === 0) {
      for (const e of entries) {
        const rel = String(e.path);
        if (skippedCreateOnly.has(rel)) continue;
        const dst = diverted.has(rel) ? join(kit, `${rel}.new`) : join(kit, rel);
        if ((await fileDigest(dst))?.toLowerCase() !== String(e.sha256).toLowerCase()) {
          problems.push(`適用後のハッシュが一致しません: ${rel}`);
        }
      }
      const cmp = await compareProtected(protectedBefore);
      problems.push(...cmp.problems);
      if (cmp.envChanged) {
        console.log("注意: printer-host.env がリリースの内容で上書きされました（更新前の内容はこのPCの update-backup に退避されています）。");
      }
    }
    if (problems.length === 0) {
      if (!(await smokeTest())) problems.push("smoke test で新しいサーバーが起動しませんでした");
    }
    if (problems.length > 0) {
      console.log(`問題があったため、更新前の状態へ戻します: ${problems.join(" / ")}`);
      restoreScoped();
      clearState();
      throw new Error(`更新に失敗したため、更新前の状態へ戻しました。問題: ${problems.join(" / ")}`);
    }
    // 状態の解除を kit-version.json の書き込みより先に行う。逆順だと、書き込み直後に
    // 中断した場合に次回「復旧（旧版へ戻す）→新 digest を見て既に最新と誤判定」が起きる。
    clearState();
    writeFileSync(versionPath, JSON.stringify({
      source: "github",
      commit: manifest.commit,
      tag: release.tag_name,
      releaseId: release.id,
      assetId: asset.id,
      assetDigest,
      zipSha256: zipHash,
      appliedAt: new Date().toISOString(),
    }));
    console.log(`アップデートが完了しました（${release.tag_name}）。Start-USB-Kit.command から起動できます。`);
    console.log("アップデーターや更新ランチャー自体に新版がある場合は、次回 Update-USB-Kit.command の起動時に自動で差し替わります。");
    console.log(`更新前のプログラム一式はこのPCの ${backup} に残しています（不要なら削除して構いません）。`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function acquireLock() {
  // mkdir は原子的。PIDファイルの「存在確認→書き込み」だと2つの更新が同時に通る隙がある。
  mkdirSync(localRoot, { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch {
    try {
      const pid = Number(readFileSync(lockPidPath, "utf8").trim());
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        return false; // 生きている別のアップデーターがいる
      }
    } catch {
      // プロセスが居ない、または読めない場合は stale として扱う
    }
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  writeFileSync(lockPidPath, String(process.pid));
  return true;
}

function kitSessionActive() {
  // キットのセッション状態（USB側）はビルド時チェック（build.mjs）と同じ物を見る。
  // セッションが残っている＝キット稼働中、または前回が正常終了しておらず未同期の可能性がある。
  const stateDb = join(kit, "data", ".usb-kit-state.sqlite");
  if (!existsSync(stateDb)) return false;
  try {
    const db = new DatabaseSync(stateDb, { readOnly: true });
    try {
      const row = db.prepare("SELECT session_id FROM usb_session WHERE singleton = 1").get();
      return Boolean(row?.session_id);
    } finally {
      db.close();
    }
  } catch {
    console.log("注意: キットのセッション状態を確認できませんでした。稼働確認は health とプロセスで行います。");
    return false;
  }
}

async function main() {
  if (!acquireLock()) {
    console.log("アップデートは既に実行中です。同時に2つは実行できません。");
    process.exitCode = 1;
    return;
  }
  try {
    if (!existsSync(join(kit, ".event-pos-usb-kit"))) {
      throw new Error(`このフォルダーはUSBキットではありません: ${kit}`);
    }
    // セッションが残っているキットには触らない（復旧も含む）。稼働中のプログラムを
    // 復旧で差し戻すと、営業中のデータと競合するため。
    if (kitSessionActive()) {
      throw new Error("キットが稼働中、または前回が正常に終了していません。前回と同じPCでキットを起動し、正常に終了してから、もう一度実行してください。");
    }
    // 前回の更新が適用途中で止まっていたら、退避から復旧してから始める。
    // 状態と退避は PC ローカルに1か所だけのため、対象キットが一致する場合だけ復旧する
    // （別キットの退避を復旧すると、そのキットのプログラムで上書きしてしまう。F-064）。
    if (existsSync(statePath)) {
      try {
        const st = parseJsonFile(statePath);
        if (st.status === "applying" && st.kit === kit && existsSync(backup)) {
          console.log("前回の更新が途中で止まっていたため、更新前の状態へ復旧します。");
          restoreScoped();
        }
      } catch { /* 状態が読めなければ復旧はしない */ }
      clearState();
    }
    if (existsSync(join(localRoot, "usb-sync-in-progress"))) {
      throw new Error("前回の終了時にUSBへのDB書き戻しを確認できていません（同期マーカーが残っています）。前回と同じPC・USBでキットを起動して正常に終了してから、更新を実行してください。");
    }
    const running = [];
    if (await httpOk("http://127.0.0.1:3000/health/live")) running.push("POS server (3000)");
    if (await httpOk("http://127.0.0.1:4318/health/live")) running.push("PrinterHost (4318)");
    try {
      const ps = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
      const kitProcs = ps.split("\n").filter((line) => {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!m || Number(m[1]) === process.pid) return false;
        return m[2].includes(join(kit, "server")) || m[2].includes(join(kit, "printer-host"));
      });
      if (kitProcs.length > 0) running.push(`キットの node プロセス (${kitProcs.length}件)`);
    } catch { /* ps が使えない環境では health 確認のみで判定する */ }
    if (running.length > 0) {
      throw new Error(`キットが稼働中です: ${running.join(", ")}\nPOSの画面を閉じ、キットのコンソールで Ctrl+C を押して完全に終了してから、もう一度実行してください。`);
    }
    console.log("更新方式: GitHub から取得");
    await githubUpdate();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
