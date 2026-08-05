import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { PrinterStatusObservation } from "@event-pos/contracts";
import type { PrinterStatus } from "./transport.js";

export type RawStatusObservation = {
  requestHex: string;
  responseHex: string | null;
  normalized: "unknown";
  timeoutMs: number;
  error?: string;
};

const requests = [1, 2, 3, 4].map((n) => Uint8Array.from([0x10, 0x04, n]));

function unknownObservation(raw: unknown, reason: string): PrinterStatusObservation {
  const unknown = (message: string) => ({ support: "unknown" as const, reason: message });
  return { observedAt: new Date().toISOString(), reachable: unknown(reason), online: unknown(reason), coverOpen: unknown(reason), drawerOpen: unknown(reason), paper: unknown(reason), error: unknown(reason), raw };
}

/** Converts the four one-byte ESC/POS status responses without guessing missing data. */
export function decodeDleEot(observations: readonly RawStatusObservation[], drawerOpenHigh?: boolean): PrinterStatusObservation {
  const raw = { protocol: "escpos-dle-eot", responses: observations };
  if (observations.length !== 4 || observations.some((item) => !item.responseHex || !/^[0-9a-fA-F]{2}$/.test(item.responseHex))) return unknownObservation(raw, "DLE EOT応答が4件そろいません");
  const values = observations.map((item) => Number.parseInt(item.responseHex!, 16));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return unknownObservation(raw, "DLE EOT応答byteが不正です");
  const [printer, offline, error, paper] = values;
  const paperValue = (paper! & 0x60) === 0x60 ? "empty" as const : (paper! & 0x0c) === 0x0c ? "near_end" as const : "ok" as const;
  const errorValue = (error! & 0x20) !== 0 ? "unrecoverable" as const : (error! & 0x4c) !== 0 ? "recoverable" as const : "none" as const;
  const drawerSignalHigh = (printer! & 0x04) !== 0;
  return {
    observedAt: new Date().toISOString(),
    reachable: { support: "supported", value: true },
    online: { support: "supported", value: (printer! & 0x08) === 0 },
    coverOpen: { support: "supported", value: (offline! & 0x04) !== 0 },
    drawerOpen: drawerOpenHigh === undefined ? { support: "unknown", reason: "ドロアーpin3のHIGH/LOWと開状態の対応が未校正", } : { support: "supported", value: drawerOpenHigh ? drawerSignalHigh : !drawerSignalHigh },
    paper: { support: "supported", value: paperValue },
    error: { support: "supported", value: errorValue },
    raw: { ...raw, drawerSignalHigh },
  };
}

/** Maps only the documented DLE EOT bits that the host's current status contract can express. */
export function normalizeDleEot(observations: readonly RawStatusObservation[]): PrinterStatus {
  const observation = decodeDleEot(observations);
  if (observation.reachable.support !== "supported") return "unknown";
  if (observation.online.support === "supported" && !observation.online.value) return "offline";
  if (observation.paper.support === "supported" && observation.paper.value === "empty") return "paper_out";
  return "ready";
}

export class LinuxDleEotSession {
  private handle: FileHandle | undefined;
  constructor(private readonly devicePath: string, private readonly timeoutMs = 1_000) {}
  private async ensureOpen(): Promise<FileHandle> { return this.handle ??= await open(this.devicePath, constants.O_RDWR | constants.O_NONBLOCK); }
  async query(): Promise<RawStatusObservation[]> {
    const handle = await this.ensureOpen(); const observations: RawStatusObservation[] = [];
    for (const request of requests) {
      try {
        await handle.write(request); const response = Buffer.alloc(1); const started = Date.now(); let responseHex: string | null = null;
        while (Date.now() - started < this.timeoutMs) {
          try { const result = await handle.read(response, 0, 1, null); if (result.bytesRead) { responseHex = response.subarray(0, result.bytesRead).toString("hex"); break; } }
          catch (error) { if (!(error instanceof Error) || !["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex, normalized: "unknown", timeoutMs: this.timeoutMs, ...(responseHex ? {} : { error: "timeout" }) });
      } catch (error) { observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex: null, normalized: "unknown", timeoutMs: this.timeoutMs, error: error instanceof Error ? error.message : String(error) }); }
    }
    return observations;
  }
  async write(bytes: Uint8Array, onWrite?: (offset: number, bytesWritten: number) => void): Promise<number> { const handle = await this.ensureOpen(); let offset = 0; while (offset < bytes.byteLength) { const result = await handle.write(bytes, offset, bytes.byteLength - offset); onWrite?.(offset, result.bytesWritten); if (result.bytesWritten <= 0) throw new Error("printer write made no progress"); offset += result.bytesWritten; } return offset; }
  async close(): Promise<void> { await this.handle?.close(); this.handle = undefined; }
}

/**
 * Sends only DLE EOT n (n=1..4), which is the ESC/POS real-time status request.
 * This is intentionally a probe: no response, transport error, or a response we have
 * not hardware-validated remains unknown and is never converted to ready.
 */
export async function probeLinuxDleEot(devicePath: string, timeoutMs = 1_000): Promise<RawStatusObservation[]> {
  const session = new LinuxDleEotSession(devicePath, timeoutMs);
  try {
    return await session.query();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return requests.map((request) => ({ requestHex: Buffer.from(request).toString("hex"), responseHex: null, normalized: "unknown" as const, timeoutMs, error: message }));
  } finally {
    await session.close();
  }
}
