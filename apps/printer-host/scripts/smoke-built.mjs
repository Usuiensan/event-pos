import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(scriptsDirectory);
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("smoke test用portを確保できません"));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const child = spawn(process.execPath, [join(packageDirectory, "dist", "index.js")], {
  cwd: join(packageDirectory, "..", ".."),
  env: { ...process.env, NODE_ENV: "production", PRINTER_BACKEND: "fake", HOST: "127.0.0.1", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  const deadline = Date.now() + 10_000;
  let response;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`PrinterHostが早期終了しました (${child.exitCode})\n${stdout}\n${stderr}`);
    try { response = await fetch(`http://127.0.0.1:${port}/health/live`); if (response.ok) break; } catch { /* 起動待ち */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!response?.ok) throw new Error(`PrinterHostのhealth確認がtimeoutしました\n${stdout}\n${stderr}`);
  console.log(`built PrinterHost smoke: ok (port=${port})`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
