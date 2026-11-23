import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const [platform, output, runtime, macArch = process.arch, macNativeDirectory] = process.argv.slice(2);
if (!["windows", "macos"].includes(platform) || !output || !runtime || !existsSync(runtime)) {
  throw new Error("使い方: node deploy/usb-kit/build.mjs <windows|macos> <出力フォルダー> <配布用Node実行ファイル>");
}
const windows = platform === "windows";
const target = resolve(repo, output);
const platformFiles = join(repo, "deploy", platform);
const marker = join(target, ".event-pos-usb-kit");
const markerText = windows
  ? readFileSync(join(platformFiles, "usb-kit-marker.txt"), "utf8").trim()
  : "event-pos USB kit output; built by deploy/macos/build-usb-kit.sh.";
const incomplete = `INCOMPLETE generated USB kit; managed by build-usb-kit.${windows ? "ps1" : "sh"}.`;

if (existsSync(target) && (!existsSync(marker) || ![markerText, incomplete].includes(readFileSync(marker, "utf8").trim()))) {
  throw new Error(`既存フォルダーはUSBキットのビルド出力ではありません: ${target}`);
}
const state = join(target, "data", ".usb-kit-state.sqlite");
if (existsSync(state)) {
  const db = new DatabaseSync(state, { readOnly: true });
  try {
    const pending = db.prepare("SELECT session_id FROM usb_session WHERE singleton = 1").get()?.session_id;
    if (pending) throw new Error("キットが稼働中、または未同期です。前回のPCで起動し、正常に終了してから更新してください。");
  } finally {
    db.close();
  }
}

const store = join(repo, "node_modules", ".pnpm");
const esbuild = readdirSync(store).find((entry) => entry.startsWith("esbuild@"));
if (!esbuild) throw new Error("esbuildがありません。先にpnpm installを実行してください。");
const require = createRequire(import.meta.url);
const { buildSync } = require(join(store, esbuild, "node_modules", "esbuild"));
const stage = mkdtempSync(join(tmpdir(), "event-pos-usb-build-"));
try {
  const bundle = (entry, out, external = []) => buildSync({
    absWorkingDir: repo,
    entryPoints: [entry],
    outfile: join(stage, out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
    external,
  });
  bundle("apps/server/src/index.ts", "server/dist/index.js");
  bundle("apps/server/src/initialize-usb-db.ts", "server/dist/initialize-usb-db.js");
  bundle("apps/printer-host/src/index.ts", "printer-host/dist/index.js", ["usb"]);
  const serverDist = join(stage, "server", "dist");
  for (const name of ["start.mjs", "database.mjs"]) copyFileSync(join(repo, "deploy", "usb-kit", name), join(serverDist, name));
  if (windows) {
    const helper = "watch-usb-kit-shutdown.ps1";
    copyFileSync(join(platformFiles, helper), join(serverDist, helper));
  } else {
    const app = join(serverDist, "EventPosPowerEvents.app");
    const executable = join(app, "Contents", "MacOS", "EventPosPowerEvents");
    mkdirSync(dirname(executable), { recursive: true });
    copyFileSync(join(platformFiles, "PowerEvents-Info.plist"), join(app, "Contents", "Info.plist"));
    const architecture = macArch === "x64" ? "x86_64" : "arm64";
    execFileSync("xcrun", ["swiftc", "-O", "-target", `${architecture}-apple-macos13.5`,
      join(platformFiles, "PowerEvents.swift"), "-o", executable], { stdio: "inherit" });
    execFileSync("/usr/bin/codesign", ["--sign", "-", app], { stdio: "inherit" });
  }
  cpSync(join(repo, "apps", "printer-host", "scripts"), join(stage, "printer-host", "scripts"), { recursive: true });
  cpSync(join(repo, "apps", "register-web", "dist"), join(stage, "web"), { recursive: true });

  if (!windows) {
    const requirePrinter = createRequire(join(repo, "apps", "printer-host", "package.json"));
    const usb = requirePrinter.resolve("usb/package.json");
    const native = `@node-usb/usb-darwin-${macArch}`;
    const nativeDirectory = macNativeDirectory ?? dirname(createRequire(usb).resolve(`${native}/package.json`));
    const nativePackage = JSON.parse(readFileSync(join(nativeDirectory, "package.json"), "utf8"));
    const usbPackage = JSON.parse(readFileSync(usb, "utf8"));
    if (nativePackage.name !== native || nativePackage.version !== usbPackage.optionalDependencies[native]) {
      throw new Error(`USBパッケージが一致しません: ${native}`);
    }
    const modules = join(stage, "printer-host", "node_modules");
    cpSync(dirname(usb), join(modules, "usb"), { recursive: true });
    cpSync(nativeDirectory, join(modules, native), { recursive: true });
  }

  mkdirSync(target, { recursive: true });
  if (!existsSync(marker)) writeFileSync(marker, incomplete);
  for (const dir of ["data", "runtime", "event-config"]) mkdirSync(join(target, dir), { recursive: true });
  for (const dir of ["server", "printer-host", "web"]) cpSync(join(stage, dir), join(target, dir), { recursive: true });
  const runtimeOut = join(target, "runtime", windows ? "node.exe" : "node");
  copyFileSync(runtime, runtimeOut);
  if (!windows) chmodSync(runtimeOut, 0o755);
  const license = join(dirname(runtime), windows ? "LICENSE" : "../LICENSE");
  if (existsSync(license)) copyFileSync(license, join(target, "runtime", "LICENSE"));
  const configs = join(repo, "event-config");
  for (const entry of readdirSync(configs)) {
    const destination = join(target, "event-config", entry);
    if (entry !== "usb-kit-initial" || !existsSync(destination)) cpSync(join(configs, entry), destination, { recursive: true });
  }
  for (const name of windows ? [
    "Start-USB-Kit.bat", "start-usb-kit.ps1", "Update-USB-Kit.bat", "update-usb-kit.ps1",
    "Recover-USB-Kit-DB.bat", "Recover-USB-Kit-DB.ps1",
  ] : ["Start-USB-Kit.command"]) {
    const destination = join(target, name);
    copyFileSync(join(platformFiles, name), destination);
    if (!windows) chmodSync(destination, 0o755);
  }
  const printerEnv = join(target, "printer-host.env");
  if (!existsSync(printerEnv)) copyFileSync(join(platformFiles, "usb-kit-printer-host.env"), printerEnv);
  copyFileSync(join(platformFiles, "usb-kit-README.md"), join(target, "README.md"));
  writeFileSync(marker, markerText + "\n");
  console.log(`USBキットを作成しました: ${target}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
