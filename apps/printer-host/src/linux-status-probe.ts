import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { PrinterStatus } from "./transport.js";

export type RawStatusObservation = {
  requestHex: string;
  responseHex: string | null;
  normalized: "unknown";
  timeoutMs: number;
  error?: string;
};

/** Maps only the documented DLE EOT bits that the host's current status contract can express. */
export function normalizeDleEot(observations: readonly RawStatusObservation[]): PrinterStatus {
  if (observations.length !== 4 || observations.some((item) => !item.responseHex)) return "unknown";
  const values = observations.map((item) => Number.parseInt(item.responseHex!, 16));
  if (values.some((value) => !Number.isInteger(value))) return "unknown";
  const [printer, offline, _error, paper] = values;
  if ((printer! & 0x08) || (offline! & 0x08)) return "offline";
  if ((paper! & 0x60) === 0x60) return "paper_out";
  return "ready";
}

/**
 * Sends only DLE EOT n (n=1..4), which is the ESC/POS real-time status request.
 * This is intentionally a probe: no response, transport error, or a response we have
 * not hardware-validated remains unknown and is never converted to ready.
 */
export async function probeLinuxDleEot(devicePath: string, timeoutMs = 1_000): Promise<RawStatusObservation[]> {
  const requests = [1, 2, 3, 4].map((n) => Uint8Array.from([0x10, 0x04, n]));
  const observations: RawStatusObservation[] = [];
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(devicePath, constants.O_RDWR | constants.O_NONBLOCK);
    for (const request of requests) {
      try {
        await handle.write(request);
        const response = Buffer.alloc(1); const started = Date.now(); let responseHex: string | null = null;
        while (Date.now() - started < timeoutMs) {
          try { const result = await handle.read(response, 0, 1, null); if (result.bytesRead) { responseHex = response.subarray(0, result.bytesRead).toString("hex"); break; } }
          catch (error) { if (!(error instanceof Error) || !["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex, normalized: "unknown", timeoutMs, ...(responseHex ? {} : { error: "timeout" }) });
      } catch (error) {
        observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex: null, normalized: "unknown", timeoutMs, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const request of requests) observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex: null, normalized: "unknown", timeoutMs, error: message });
  } finally {
    await handle?.close();
  }
  return observations;
}
