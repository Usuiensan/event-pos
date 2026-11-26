import { execFile, execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createDatabaseSession, lockLocalDirectory } from "./database.mjs";
import { drawerEnabled } from "./drawer.mjs";
import { serverHost } from "./lan.mjs";
import { initializeUsbDatabase } from "./initialize-usb-db.js";

const kit = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const windows = process.platform === "win32";
const localRoot = windows
  ? join(process.env.LOCALAPPDATA, "EventPos", "UsbKit")
  : join(homedir(), "Library", "Application Support", "EventPos", "UsbKit");
const logs = join(localRoot, "logs");
const config = join(kit, "event-config", "usb-kit-initial");
const posUrl = "http://127.0.0.1:3000/?register=1&role=staff";

function getVolumeId() {
  if (windows) {
    const drive = parse(kit).root.slice(0, 2);
    if (!/^[a-z]:$/i.test(drive)) throw new Error("ドライブ文字でアクセスできるUSBを使用してください。");
    const serial = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").VolumeSerialNumber`],
    { encoding: "utf8", windowsHide: true }).trim();
    if (/^[0-9a-f]{8}$/i.test(serial)) return serial.toUpperCase();
  } else {
    const device = execFileSync("/bin/df", ["-P", kit], { encoding: "utf8" }).trim().split("\n").at(-1).split(/\s+/)[0];
    const info = execFileSync("/usr/sbin/diskutil", ["info", "-plist", device]);
    for (const key of ["VolumeUUID", "DiskUUID"]) {
      const result = tryReadPlistValue(key, info);
      if (result) return result;
    }
  }
  throw new Error("USBのボリュームIDを取得できません。USBが接続されているか確認してください。");
}

function tryReadPlistValue(key, input) {
  try {
    return execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", "-"], {
      input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function initialize(dbPath, signal) {
  console.log("初回セットアップ。商品一覧は空で作成します。");
  const prompts = Object.entries({
    eventId: "イベントID（英小文字・数字・ハイフン、2〜63文字）",
    eventName: "イベント名",
    businessDate: "営業日（YYYY-MM-DD）",
    circleName: "サークル名",
    space: "スペース（未定なら空欄）",
    receiptIssuerName: "レシート発行者名（空欄ならサークル名を使用）",
  });
  const input = createInterface({ input: process.stdin, output: process.stdout, signal });
  const setup = {};
  try {
    const lines = input[Symbol.asyncIterator]();
    for (const [key, prompt] of prompts) {
      console.log(prompt);
      const line = await lines.next();
      if (line.done) throw new Error("初回セットアップを中断しました。");
      setup[key] = line.value.trim();
    }
  } finally {
    input.close();
  }
  await initializeUsbDatabase(dbPath, config, setup);
  console.log("初期DBを作成しました。管理者の責任者番号は001です。");
}

function readPrinterEnv() {
  // 兼用キットでは macOS 用のプリンター設定を別ファイルに分ける（Windows用は printer-host.env）。
  const envPath = !windows && existsSync(join(kit, "printer-host-macos.env"))
    ? join(kit, "printer-host-macos.env")
    : join(kit, "printer-host.env");
  const result = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(text);
    if (!match) throw new Error("printer-host.envに不正な設定行があります。");
    result[match[1]] = match[2].trim();
  }
  return result;
}

// 同じプロセス内で起動し、コンソールの強制終了後にサービスが残らないようにする。
function startWorker(name, entry, env) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData).then(({ closeService }) => {
      parentPort.once("message", async () => {
        try {
          await closeService();
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
        } finally {
          parentPort.close();
        }
      });
      parentPort.postMessage("ready");
    }, error => {
      console.error(error);
      process.exit(1);
    });
  `, { eval: true, workerData: pathToFileURL(entry).href, env, stdout: true, stderr: true });

  for (const [stream, suffix] of [[worker.stdout, "out"], [worker.stderr, "err"]]) {
    const log = createWriteStream(join(logs, `${name}.${suffix}.log`));
    log.on("error", (error) => console.error(`ログを保存できません: ${error.message}`));
    stream.pipe(log);
  }
  worker.on("error", (error) => console.error(`${name}: ${error.message}`));
  const exited = new Promise((done) => worker.once("exit", (code) => done({ name, code })));
  const ready = new Promise((done) => worker.once("message", done));
  return { worker, ready, exited };
}

async function stopWorker(service, waitMs = 1_250) {
  if (!service) return;
  service.worker.postMessage("stop");
  const result = await Promise.race([service.exited, delay(waitMs, undefined, { ref: false })]);
  if (!result) {
    console.error("サービスの終了待機時間に達したため、USBへの最終保存を続けます。");
    await service.worker.terminate();
  }
}

function watchPowerEvents(stop, beforeSleep) {
  const [program, ...args] = windows
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File",
      fileURLToPath(new URL("./watch-usb-kit-shutdown.ps1", import.meta.url))]
    : [fileURLToPath(new URL("./EventPosPowerEvents.app/Contents/MacOS/EventPosPowerEvents", import.meta.url))];
  const watcher = spawn(program, args, {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const messages = createInterface({ input: watcher.stdout });
  messages.on("line", (line) => {
    const message = line.trim();
    if (message === "shutdown" || message === "shutdown-wait") stop(message === "shutdown-wait");
    const sleep = /^sleep (\d+)$/.exec(message);
    if (sleep) beforeSleep(() => watcher.stdin.write(`${sleep[1]}\n`));
  });
  watcher.stdin.on("error", () => {});
  watcher.stderr.setEncoding("utf8");
  watcher.stderr.on("data", (details) => console.error(`OSの終了通知を監視できません: ${details.trim()}`));
  watcher.on("error", (error) => console.error(`OSの終了通知を監視できません: ${error.message}`));
  // 終了通知プロセスが遅延しても、POSの終了を妨げない。
  watcher.unref();
  for (const stream of [watcher.stdin, watcher.stdout, watcher.stderr]) stream.unref?.();
  return watcher;
}

async function run() {
  const lock = lockLocalDirectory(localRoot);
  const stopped = Promise.withResolvers();
  const setup = new AbortController();
  const stop = () => {
    setup.abort();
    stopped.resolve();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  const workers = [];
  let database;
  let autosaveTimer;
  let pendingSave;
  let autosaveError;
  let shutdownWatcher;
  let systemShutdownWait = false;
  const saveCheckpoint = () => {
    if (pendingSave) return pendingSave;
    pendingSave = database.checkpoint().then((saved) => {
      if (saved && autosaveError) {
        console.log("USBへの自動保存が再開しました。");
        autosaveError = undefined;
      }
    }).catch((error) => {
      if (error.message !== autosaveError) {
        console.error(`USBへの自動保存を再試行します。会計データはPC側に保持します。詳細: ${error.message}`);
        autosaveError = error.message;
      }
    }).finally(() => {
      pendingSave = undefined;
    });
    return pendingSave;
  };
  let servicesReady = false;
  const beforeSleep = async (acknowledge) => {
    try {
      await pendingSave;
      if (servicesReady && !setup.signal.aborted) await saveCheckpoint();
    } finally {
      acknowledge();
    }
  };
  try {
    shutdownWatcher = watchPowerEvents((canWait) => {
      systemShutdownWait = canWait;
      stop();
    }, beforeSleep);
    database = createDatabaseSession(kit, localRoot, getVolumeId);
    await database.start((path) => initialize(path, setup.signal));
    if (setup.signal.aborted) return;
    mkdirSync(logs, { recursive: true });
    const artifacts = join(localRoot, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const shared = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1" };
    const start = async (name, env) => {
      const service = startWorker(name, resolve(kit, name, "dist", "index.js"), env);
      workers.push(service);
      const result = await Promise.race([service.ready, stopped.promise, ...workers.map(({ exited }) => exited)]);
      if (result && result !== "ready") throw new Error(`${result.name}が終了しました（終了コード ${result.code}）。ログ: ${logs}`);
      return result === "ready";
    };
    const printerEnv = readPrinterEnv();
    if (!await start("printer-host", {
      ...shared, ...printerEnv, HOST: "127.0.0.1", PRINTER_HOST_BIND: "127.0.0.1", PORT: "4318",
    })) return;
    if (serverHost() === "0.0.0.0") console.log("LAN公開モードで起動します（既定）。他の端末からは管理画面の「接続案内」に表示されるQRコードで接続できます。この端末のみに制限するには、環境変数 EVENT_POS_LAN=0 または起動引数 --no-lan を指定してください。");
    else console.log("この端末のみで起動します（LAN公開は無効）。他の端末から接続できるようにするには、環境変数 EVENT_POS_LAN=1 または起動引数 --lan を指定してください。");
    if (drawerEnabled()) console.log("ドロアー駆動が有効です（DRAWER_ENABLED=1 または --drawer）");
    if (!await start("server", {
      ...shared, HOST: serverHost(), PORT: "3000", POS_REQUIRE_HTTPS: "0", POS_REQUIRE_AUTH: "1",
      POS_TRAINING_MODE: "0", POS_DATABASE_PATH: database.localDb, POS_ARTIFACT_ROOT: artifacts,
      POS_EVENT_CONFIG_DIR: config, REGISTER_WEB_DIST: join(kit, "web"),
      PRINTER_HOST_URL: "http://127.0.0.1:4318", DRAWER_ENABLED: drawerEnabled() ? "1" : "0",
      // PrinterHost に PRINTER_HOST_TOKEN を設定した場合はサーバーにも同じトークンを渡す
      // （渡さないと全リクエストが 401 になり印刷が止まる）。
      ...(printerEnv.PRINTER_HOST_TOKEN ? { PRINTER_HOST_TOKEN: printerEnv.PRINTER_HOST_TOKEN } : {}),
    })) return;

    servicesReady = true;
    autosaveTimer = setInterval(saveCheckpoint, 5_000);

    const [browser, ...args] = windows ? ["rundll32.exe", "url.dll,FileProtocolHandler", posUrl] : ["/usr/bin/open", posUrl];
    execFile(browser, args, { windowsHide: true }, (error) => {
      if (error) console.error(`ブラウザーで開いてください: ${posUrl}`);
    });
    console.log("POSを起動しました。終了するにはこの画面で Ctrl+C を押してください。");
    const failure = await Promise.race([stopped.promise, ...workers.map(({ exited }) => exited)]);
    if (failure) throw new Error(`${failure.name}が終了しました（終了コード ${failure.code}）。ログ: ${logs}`);
  } finally {
    servicesReady = false;
    clearInterval(autosaveTimer);
    const [printer, server] = workers;
    try {
      // 印刷結果をPOSが記録できるよう、PrinterHostより先にPOSの受付を停止する。
      await stopWorker(server, systemShutdownWait ? 4_000 : undefined);
      const printerStopped = stopWorker(printer);
      try {
        await pendingSave;
        if (await database?.sync()) console.log(`DBをUSBへ書き戻しました: ${database.usbDb}`);
      } finally {
        await printerStopped;
      }
    } finally {
      shutdownWatcher?.stdin.end();
      lock.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    }
  }
}

try {
  await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
