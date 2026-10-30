import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { buildHardwareFixture } from "./hardware-fixture.js";
import { BridgeTransport } from "./bridge-transport.js";
import { LinuxRawTransport } from "./linux-raw-transport.js";
import { probeLinuxDleEot } from "./linux-status-probe.js";

const execFileAsync = promisify(execFile);
const run = process.argv.includes("--run");
const devicePath = process.env.PRINTER_DEVICE;
const evidenceDir = process.env.PRINTER_EVIDENCE_DIR ?? "./evidence/printer";

type WriteTrace = { offset: number; bytesWritten: number; errno?: string; at: string };

async function command(command: string, args: string[]): Promise<string | undefined> {
  try { return (await execFileAsync(command, args, { windowsHide: true })).stdout.trim(); } catch { return undefined; }
}

async function main(): Promise<void> {
  const fixture = buildHardwareFixture();
  await mkdir(evidenceDir, { recursive: true });
  await Promise.all([
    writeFile(join(evidenceDir, "fixture.ir"), fixture.canonicalIr, "utf8"),
    writeFile(join(evidenceDir, "fixture.bin"), fixture.bytes),
  ]);
  const manifest = {
    schemaVersion: 1, fixtureId: fixture.fixtureId, fixtureVersion: fixture.fixtureVersion,
    canonicalIrSha256: fixture.irSha256, escposSha256: fixture.bytesSha256, bytesLength: fixture.bytes.length,
    rendererVersion: "event-pos-escpos-v1", fixtureContains: ["ASCII", "CP932日本語", "U+00A5", "32桁row", "固定画像", "QR", "Code 128", "3行feed", "partial cut"],
    prohibited: ["full cut", "drawer", "buzzer", "NV memory", "printer setting", "arbitrary raw payload"],
  };
  await writeFile(join(evidenceDir, "fixture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (!run) { console.log(JSON.stringify({ mode: "dry-run", evidenceDir, ...manifest })); return; }
  if (process.env.PRINTER_BRIDGE_URL) {
    const bridgeUrl = process.env.PRINTER_BRIDGE_URL;
    const transport = new BridgeTransport(bridgeUrl, process.env.PRINTER_BRIDGE_TOKEN ? { token: process.env.PRINTER_BRIDGE_TOKEN } : {});
    const statusRequests: unknown[] = [];
    const statusBefore = await transport.getStatus();
    let result: "completed" | "unknown" = "unknown"; let errorMessage: string | undefined;
    try { const receipt = await transport.send(fixture.bytes); result = receipt.acceptedBytes === fixture.bytes.length ? "completed" : "unknown"; }
    catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
    let statusAfter = statusBefore;
    try { statusAfter = await transport.getStatus(); } finally { await transport.close(); }
    const evidence = {
      schemaVersion: 1, mode: "run", fixture: manifest, executedAt: new Date().toISOString(),
      environment: { platform: platform(), kernel: release(), architecture: arch(), osRelease: await command("sh", ["-c", "cat /etc/os-release"]) },
      adapter: { name: "BridgeTransport", bridgeUrl, mutex: "discord-printer-bot process serializes all prints" },
      statusBefore, statusAfter, statusRequests, writes: [], result, physicalPaperEvidenceId: null,
      delivery: { transportAccepted: result === "completed", physicalPaperCompleted: null, automaticRetry: false, note: "送信可能性のある失敗は自動再送しない" },
      ...(errorMessage ? { errorMessage } : {}),
    };
    const path = join(evidenceDir, `run-${new Date().toISOString().replaceAll(":", "-")}.json`);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ result, evidencePath: path, bytesSha256: fixture.bytesSha256 }));
    if (result !== "completed") process.exitCode = 1;
    return;
  }
  if (platform() !== "linux" || !devicePath) {
    console.error("--run presently requires Linux PRINTER_DEVICE; fixture was generated but no device was touched");
    process.exitCode = 2; return;
  }
  const writes: WriteTrace[] = [];
  const transport = new LinuxRawTransport(devicePath, async () => "unknown", (offset, bytesWritten, error) => writes.push({ offset, bytesWritten, ...(error ? { errno: error } : {}), at: new Date().toISOString() }));
  const statusRequests = await probeLinuxDleEot(devicePath, Number(process.env.PRINTER_STATUS_TIMEOUT_MS ?? 1000));
  const statusBefore = await transport.getStatus();
  let result: "completed" | "unknown" = "unknown"; let errorMessage: string | undefined;
  try { const receipt = await transport.send(fixture.bytes); result = receipt.acceptedBytes === fixture.bytes.length ? "completed" : "unknown"; }
  catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
  let statusAfter = statusBefore;
  try { statusAfter = await transport.getStatus(); } finally { await transport.close(); }
  const evidence = {
    schemaVersion: 1, mode: "run", fixture: manifest, executedAt: new Date().toISOString(),
    environment: { platform: platform(), kernel: release(), architecture: arch(), osRelease: await command("sh", ["-c", "cat /etc/os-release"]) },
    adapter: { name: "LinuxRawTransport", devicePath, timeoutMs: null, mutex: "hardware probe process only; PrinterHost mutex is not exercised", compilerSha256: fixture.irSha256, writeSha256: fixture.bytesSha256 },
    statusBefore, statusAfter, statusRequests, writes, result, physicalPaperEvidenceId: null,
    delivery: { transportAccepted: result === "completed", physicalPaperCompleted: null, automaticRetry: false, note: "送信可能性のある失敗は自動再送しない" },
    ...(errorMessage ? { errorMessage } : {}),
  };
  const path = join(evidenceDir, `run-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ result, evidencePath: path, bytesSha256: fixture.bytesSha256 }));
  if (result !== "completed") process.exitCode = 1;
}

await main();
