#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const devicePath = process.env.PRINTER_DEVICE;
const evidenceDir = process.env.PRINTER_EVIDENCE_DIR;
const fixturePath = process.env.PRINTER_FIXTURE_PATH;
const timeoutMs = Number(process.env.PRINTER_STATUS_TIMEOUT_MS ?? 1000);
const statusOnly = process.env.PRINTER_STATUS_ONLY === "true";
if (!devicePath || !evidenceDir || !fixturePath) throw new Error("PRINTER_DEVICE, PRINTER_EVIDENCE_DIR, and PRINTER_FIXTURE_PATH are required");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (observations) => {
  if (observations.length !== 4 || observations.some((item) => !item.responseHex)) return "unknown";
  const [printer, offline, _error, paper] = observations.map((item) => Number.parseInt(item.responseHex, 16));
  if ([printer, offline, paper].some((value) => !Number.isInteger(value))) return "unknown";
  if ((printer & 0x08) || (offline & 0x08)) return "offline";
  if ((paper & 0x60) === 0x60) return "paper_out";
  return "ready";
};
const observation = async () => {
  const requests = [1, 2, 3, 4].map((n) => Buffer.from([0x10, 0x04, n]));
  const result = [];
  let handle;
  try {
    handle = await open(devicePath, constants.O_RDWR | constants.O_NONBLOCK);
    for (const request of requests) {
      try {
        await handle.write(request);
        const response = Buffer.alloc(1); const started = Date.now(); let responseHex = null;
        while (Date.now() - started < timeoutMs) {
          try { const read = await handle.read(response, 0, 1, null); if (read.bytesRead) { responseHex = response.subarray(0, read.bytesRead).toString("hex"); break; } }
          catch (error) { if (!["EAGAIN", "EWOULDBLOCK"].includes(error.code)) throw error; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        result.push({ requestHex: request.toString("hex"), responseHex, normalized: "unknown", timeoutMs, ...(responseHex ? {} : { error: "timeout" }) });
      } catch (error) { result.push({ requestHex: request.toString("hex"), responseHex: null, normalized: "unknown", timeoutMs, error: error.message }); }
    }
  } catch (error) {
    for (const request of requests) result.push({ requestHex: request.toString("hex"), responseHex: null, normalized: "unknown", timeoutMs, error: error.message });
  } finally { await handle?.close(); }
  return result;
};
const command = async (...args) => { try { return (await execFileAsync(...args)).stdout.trim(); } catch { return null; } };

await mkdir(evidenceDir, { recursive: true });
const bytes = await readFile(fixturePath);
const writes = [];
const statusBefore = await observation();
let result = "unknown"; let errorMessage;
if (!statusOnly) try {
  const handle = await open(devicePath, "w");
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const write = await handle.write(bytes, offset, bytes.length - offset);
      writes.push({ offset, bytesWritten: write.bytesWritten, at: new Date().toISOString() });
      if (!write.bytesWritten) throw new Error("write made no progress");
      offset += write.bytesWritten;
    }
    result = offset === bytes.length ? "completed" : "unknown";
  } finally { await handle.close(); }
} catch (error) { errorMessage = error.message; writes.push({ offset: writes.reduce((sum, item) => sum + item.bytesWritten, 0), bytesWritten: 0, errno: error.code ?? error.message, at: new Date().toISOString() }); }
const statusAfter = await observation();
const evidence = {
  schemaVersion: 1, mode: "run", executedAt: new Date().toISOString(),
  environment: { platform: platform(), kernel: release(), architecture: arch(), osRelease: await readFile("/etc/os-release", "utf8") },
  fixture: { source: fixturePath, escposSha256: sha256(bytes), bytesLength: bytes.length },
  adapter: { name: "Linux RAW /dev/usb/lp*", devicePath, timeoutMs, mutex: "existing bot service stopped; no device holders before run", writeSha256: sha256(bytes) },
  statusOnly, statusBefore, statusAfter, normalizedStatus: { before: normalize(statusBefore), after: normalize(statusAfter) }, writes, result: statusOnly ? "status_observed" : result, physicalPaperEvidenceId: null,
  delivery: { transportAccepted: statusOnly ? null : result === "completed", physicalPaperCompleted: null, automaticRetry: false, note: statusOnly ? "status-only: fixture bytes were not sent" : "送信可能性がある失敗は自動再送しない" },
  ...(errorMessage ? { errorMessage } : {}),
};
await writeFile(join(evidenceDir, "linux-raw-result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ result: evidence.result, evidencePath: join(evidenceDir, "linux-raw-result.json"), bytesSha256: evidence.fixture.escposSha256 }));
if (!statusOnly && result !== "completed") process.exitCode = 1;
