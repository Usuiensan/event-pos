import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const [platform, output, runtime, macArch = process.arch, macNativeDirectory] = process.argv.slice(2);
if (!["windows", "macos", "universal"].includes(platform) || !output || !runtime || !existsSync(runtime)) {
  throw new Error("使い方: node deploy/usb-kit/build.mjs <windows|macos|universal> <出力フォルダー> <配布用Node実行ファイル>");
}
const windows = platform === "windows";
const universal = platform === "universal";
const target = resolve(repo, output);
const platformFiles = join(repo, "deploy", windows || universal ? "windows" : "macos");
const windowsFiles = join(repo, "deploy", "windows");
const macosFiles = join(repo, "deploy", "macos");
const marker = join(target, ".event-pos-usb-kit");
const markerTexts = {
  windows: readFileSync(join(windowsFiles, "usb-kit-marker.txt"), "utf8").trim(),
  macos: "event-pos USB kit output; built by deploy/macos/build-usb-kit.sh.",
  universal: "event-pos USB kit output; built as a universal (Windows + macOS) kit.",
};
const markerText = markerTexts[platform];
const knownMarkers = [...Object.values(markerTexts),
  "INCOMPLETE generated USB kit; managed by build-usb-kit.ps1.",
  "INCOMPLETE generated USB kit; managed by build-usb-kit.sh."];

if (existsSync(target) && (!existsSync(marker) || !knownMarkers.includes(readFileSync(marker, "utf8").trim()))) {
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
  for (const name of ["start.mjs", "database.mjs", "lan.mjs", "drawer.mjs"]) copyFileSync(join(repo, "deploy", "usb-kit", name), join(serverDist, name));
  if (windows || universal) {
    const helper = "watch-usb-kit-shutdown.ps1";
    copyFileSync(join(windowsFiles, helper), join(serverDist, helper));
  }
  if (!windows) {
    const app = join(serverDist, "EventPosPowerEvents.app");
    const executable = join(app, "Contents", "MacOS", "EventPosPowerEvents");
    mkdirSync(dirname(executable), { recursive: true });
    copyFileSync(join(macosFiles, "PowerEvents-Info.plist"), join(app, "Contents", "Info.plist"));
    if (universal && process.platform !== "darwin") {
      // Windows等で兼用キットを作る場合は、Macで事前にビルドして置いたユニバーサル版アプリを使う。
      const prebuilt = join(macosFiles, "prebuilt", "EventPosPowerEvents.app", "Contents", "MacOS", "EventPosPowerEvents");
      if (existsSync(prebuilt)) {
        copyFileSync(prebuilt, executable);
        chmodSync(executable, 0o755);
      } else {
        rmSync(app, { recursive: true, force: true });
        console.warn("警告: EventPosPowerEvents.app が無いため、macOSの終了・スリープ通知対応なしでビルドします（Ctrl+Cでの終了とDB書き戻しは動作します）。Macで deploy/macos/prebuilt へ配置すると同梱されます。");
      }
    } else if (universal) {
      // Mac上で兼用キットを作る場合は arm64 + x86_64 のユニバーサルバイナリにする。
      const arm = join(stage, "power-events-arm64");
      const intel = join(stage, "power-events-x86_64");
      execFileSync("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macos13.5",
        join(macosFiles, "PowerEvents.swift"), "-o", arm], { stdio: "inherit" });
      execFileSync("xcrun", ["swiftc", "-O", "-target", "x86_64-apple-macos13.5",
        join(macosFiles, "PowerEvents.swift"), "-o", intel], { stdio: "inherit" });
      execFileSync("xcrun", ["lipo", "-create", arm, intel, "-output", executable], { stdio: "inherit" });
      execFileSync("/usr/bin/codesign", ["--sign", "-", app], { stdio: "inherit" });
    } else {
      const architecture = macArch === "x64" ? "x86_64" : "arm64";
      execFileSync("xcrun", ["swiftc", "-O", "-target", `${architecture}-apple-macos13.5`,
        join(macosFiles, "PowerEvents.swift"), "-o", executable], { stdio: "inherit" });
      execFileSync("/usr/bin/codesign", ["--sign", "-", app], { stdio: "inherit" });
    }
  }
  cpSync(join(repo, "apps", "printer-host", "scripts"), join(stage, "printer-host", "scripts"), { recursive: true });
  cpSync(join(repo, "apps", "register-web", "dist"), join(stage, "web"), { recursive: true });

  if (platform === "macos") {
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

  if (universal) {
    const requirePrinter = createRequire(join(repo, "apps", "printer-host", "package.json"));
    const usb = requirePrinter.resolve("usb/package.json");
    const usbPackage = JSON.parse(readFileSync(usb, "utf8"));
    const modules = join(stage, "printer-host", "node_modules");
    cpSync(dirname(usb), join(modules, "usb"), { recursive: true });
    const packDir = join(stage, ".native-pack");
    mkdirSync(packDir, { recursive: true });
    for (const arch of ["arm64", "x64"]) {
      const native = `@node-usb/usb-darwin-${arch}`;
      const version = usbPackage.optionalDependencies[native];
      let nativeDirectory = null;
      try { nativeDirectory = dirname(createRequire(usb).resolve(`${native}/package.json`)); } catch { nativeDirectory = null; }
      if (!nativeDirectory) {
        // ビルド機に無いアーキテクチャは npm pack で取得する（mac版のクロスアーキテクチャ手法と同じ）。
        const packed = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", packDir, `${native}@${version}`],
          { encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").at(-1);
        const extractDir = join(packDir, arch);
        mkdirSync(extractDir, { recursive: true });
        execFileSync("tar", ["-xzf", join(packDir, packed), "-C", extractDir, "--no-same-owner"], { stdio: "inherit" });
        nativeDirectory = join(extractDir, "package");
      }
      const nativePackage = JSON.parse(readFileSync(join(nativeDirectory, "package.json"), "utf8"));
      if (nativePackage.name !== native || nativePackage.version !== version) {
        throw new Error(`USBパッケージが一致しません: ${native}`);
      }
      cpSync(nativeDirectory, join(modules, native), { recursive: true });
    }
  }

  mkdirSync(target, { recursive: true });
  if (!existsSync(marker)) writeFileSync(marker, `INCOMPLETE generated USB kit; managed by build-usb-kit.${process.platform === "win32" ? "ps1" : "sh"}.`);
  for (const dir of ["data", "runtime", "event-config"]) mkdirSync(join(target, dir), { recursive: true });
  for (const dir of ["server", "printer-host", "web"]) cpSync(join(stage, dir), join(target, dir), { recursive: true });
  if (universal) {
    // 兼用キットは Windows / Mac 両方の Node ランタイムを同梱する。ビルド機のOSに依らず
    // 公式配布から取得し、SHASUMS256 で照合する（Mac側の初回準備はキットを挿して起動するだけ）。
    const version = execFileSync(runtime, ["--version"], { encoding: "utf8" }).trim();
    if (!/^v24\./.test(version)) throw new Error(`兼用キットのランタイムには Node.js 24 が必要です: ${version}`);
    const dl = join(stage, ".runtime-dl");
    mkdirSync(dl, { recursive: true });
    const base = `https://nodejs.org/dist/${version}`;
    const download = (file) => {
      const dest = join(dl, file);
      mkdirSync(dirname(dest), { recursive: true });
      execFileSync("curl", ["-fsSLo", dest, `${base}/${file}`], { stdio: "inherit" });
      return dest;
    };
    const sums = readFileSync(download("SHASUMS256.txt"), "utf8");
    const verified = (file) => {
      const path = download(file);
      const expected = sums.split("\n").map((line) => line.trim().split(/\s+/)).find(([, name]) => name === file)?.[0];
      const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (!expected || expected !== actual) throw new Error(`Node.js 配布物のハッシュが一致しません: ${file}`);
      return path;
    };
    copyFileSync(verified("win-x64/node.exe"), join(target, "runtime", "node.exe"));
    for (const arch of ["arm64", "x64"]) {
      const file = `node-${version}-darwin-${arch}.tar.gz`;
      const extractDir = join(dl, `darwin-${arch}`);
      mkdirSync(extractDir, { recursive: true });
      // 配布物全体ではなく必要な2ファイルだけ展開する（テンポラリの使用量を抑える）。
      execFileSync("tar", ["-xzf", verified(file), "-C", extractDir, "--no-same-owner", `node-${version}-darwin-${arch}/bin/node`, `node-${version}-darwin-${arch}/LICENSE`], { stdio: "inherit" });
      const out = join(target, "runtime", `node-${arch}`);
      copyFileSync(join(extractDir, `node-${version}-darwin-${arch}`, "bin", "node"), out);
      chmodSync(out, 0o755);
      const darwinLicense = join(extractDir, `node-${version}-darwin-${arch}`, "LICENSE");
      const licenseOut = join(target, "runtime", "LICENSE");
      if (!existsSync(licenseOut) && existsSync(darwinLicense)) copyFileSync(darwinLicense, licenseOut);
    }
  } else {
    const runtimeOut = join(target, "runtime", windows ? "node.exe" : "node");
    copyFileSync(runtime, runtimeOut);
    if (!windows) chmodSync(runtimeOut, 0o755);
    const license = join(dirname(runtime), windows ? "LICENSE" : "../LICENSE");
    if (existsSync(license)) copyFileSync(license, join(target, "runtime", "LICENSE"));
  }
  const configs = join(repo, "event-config");
  for (const entry of readdirSync(configs)) {
    const destination = join(target, "event-config", entry);
    if (entry !== "usb-kit-initial" || !existsSync(destination)) cpSync(join(configs, entry), destination, { recursive: true });
  }
  const windowsRootFiles = [
    "Start-USB-Kit.bat", "start-usb-kit.ps1", "Update-USB-Kit.bat", "update-usb-kit.ps1",
    "Recover-USB-Kit-DB.bat", "Recover-USB-Kit-DB.ps1",
  ];
  const macosRootFiles = ["Start-USB-Kit.command", "Update-USB-Kit.command", "update-usb-kit.mjs"];
  const rootFiles = windows
    ? windowsRootFiles.map((name) => [name, windowsFiles])
    : universal
      ? [...windowsRootFiles.map((name) => [name, windowsFiles]), ...macosRootFiles.map((name) => [name, macosFiles])]
      : macosRootFiles.map((name) => [name, macosFiles]);
  for (const [name, dir] of rootFiles) {
    const destination = join(target, name);
    copyFileSync(join(dir, name), destination);
    if (name.endsWith(".command")) chmodSync(destination, 0o755);
  }
  const printerEnv = join(target, "printer-host.env");
  if (!existsSync(printerEnv)) copyFileSync(join(platformFiles, "usb-kit-printer-host.env"), printerEnv);
  if (universal) {
    // Mac側のプリンター設定は別ファイルにする（start.mjs が macOS ではこちらを優先する）。
    const macPrinterEnv = join(target, "printer-host-macos.env");
    if (!existsSync(macPrinterEnv)) copyFileSync(join(macosFiles, "usb-kit-printer-host.env"), macPrinterEnv);
  }
  copyFileSync(universal ? join(repo, "deploy", "universal", "usb-kit-README.md") : join(platformFiles, "usb-kit-README.md"), join(target, "README.md"));
  writeFileSync(marker, markerText + "\n");
  console.log(`USBキットを作成しました: ${target}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
