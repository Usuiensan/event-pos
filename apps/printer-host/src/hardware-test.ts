import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { LinuxRawTransport } from "./linux-raw-transport.js";
import { renderEscPos } from "./transport.js";
import type { PrintJob } from "@event-pos/contracts";

const devicePath = process.env.PRINTER_DEVICE;
const evidenceDir = process.env.PRINTER_EVIDENCE_DIR ?? "./evidence/printer";
if (!devicePath) {
  console.error("PRINTER_DEVICE is required; no device was touched");
  process.exitCode = 2;
} else {
  const job: PrintJob = {
    jobId: `hardware-test-${Date.now()}`, transactionId: "hardware-test", printerId: devicePath,
    documentType: "hardware-test", payload: { lines: ["event-pos printer hardware test", new Date().toISOString()] },
    createdAt: new Date().toISOString(), state: "queued", updatedAt: new Date().toISOString(),
  };
  const bytes = renderEscPos(job);
  const transport = new LinuxRawTransport(devicePath);
  const statusBefore = await transport.getStatus();
  let result: "completed" | "unknown" | "failed" = "unknown";
  let errorMessage: string | undefined;
  try { await transport.send(bytes); result = "completed"; }
  catch (error) { result = "unknown"; errorMessage = error instanceof Error ? error.message : String(error); }
  finally { await transport.close(); }
  await mkdir(evidenceDir, { recursive: true });
  const evidence = { jobId: job.jobId, devicePath, statusBefore, result, bytesLength: bytes.byteLength,
    bytesSha256: createHash("sha256").update(bytes).digest("hex"), executedAt: new Date().toISOString(), ...(errorMessage ? { errorMessage } : {}) };
  await writeFile(`${evidenceDir}/${job.jobId}.json`, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence));
  process.exitCode = errorMessage ? 1 : 0;
}
