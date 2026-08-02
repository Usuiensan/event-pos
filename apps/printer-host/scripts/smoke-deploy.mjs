import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = join(packageDirectory, "..", "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "event-pos-printer-host-deploy-"));
const deployDirectory = join(temporaryRoot, "artifact");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited with ${code}\n${stdout}\n${stderr}`)));
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("deploy smoke用portを確保できません"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

let host;
try {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error("pnpm経由でsmoke:deployを実行してください");
  await run(process.execPath, [pnpmCli, "--filter", "@event-pos/printer-host", "deploy", deployDirectory, "--prod"]);
  await access(join(deployDirectory, "dist", "index.js"));
  await access(join(deployDirectory, "scripts", "windows-raw-spooler.ps1"));
  try { await access(join(deployDirectory, "src")); throw new Error("portable配布物へsrcが混入しています"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const contractsPackage = JSON.parse(await readFile(join(deployDirectory, "node_modules", "@event-pos", "contracts", "package.json"), "utf8"));
  const contractsEntry = contractsPackage.exports?.["."]?.default;
  if (contractsEntry !== "./dist/index.js") throw new Error(`production exportがdistではありません: ${contractsEntry}`);
  await access(join(deployDirectory, "node_modules", "@event-pos", "contracts", "dist", "index.js"));

  const port = await freePort();
  host = spawn(process.execPath, [join(deployDirectory, "dist", "index.js")], { cwd: deployDirectory, windowsHide: true, env: { ...process.env, NODE_ENV: "production", PRINTER_BACKEND: "fake", HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  host.stdout.on("data", (chunk) => { stdout += String(chunk); });
  host.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + 10_000;
  let response;
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error(`portable PrinterHostが早期終了しました (${host.exitCode})\n${stdout}\n${stderr}`);
    try { response = await fetch(`http://127.0.0.1:${port}/health/live`); if (response.ok) break; } catch { /* 起動待ち */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!response?.ok) throw new Error(`portable PrinterHostのhealth確認がtimeoutしました\n${stdout}\n${stderr}`);
  console.log(`deployed PrinterHost smoke: ok (port=${port})`);
} finally {
  if (host && host.exitCode === null) {
    host.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => host.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (host.exitCode === null) host.kill("SIGKILL");
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
