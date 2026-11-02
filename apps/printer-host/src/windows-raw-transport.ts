import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrinterStatusObservation } from "@event-pos/contracts";
import { statusObservation, type PrinterTransport, type SendReceipt } from "./transport.js";

const execFileAsync = promisify(execFile);

export type WindowsStatusBackend = "spooler" | "opos";
export type WindowsRawTransportOptions = { printerName: string; rawPrintScript?: string; statusBackend?: WindowsStatusBackend; oposLogicalName?: string; oposClaimTimeoutMs?: number };

const bundledRawPrintScript = fileURLToPath(new URL("../scripts/windows-raw-spooler.ps1", import.meta.url));
const bundledStatusScript = fileURLToPath(new URL("../scripts/windows-status.ps1", import.meta.url));
const bundledOposStatusScript = fileURLToPath(new URL("../scripts/windows-opos-status.ps1", import.meta.url));

export class WindowsRawTransport implements PrinterTransport {
  readonly statusPollingSharesTransport = false;
  constructor(private readonly options: WindowsRawTransportOptions) {}
  async getStatus() {
    if (process.platform !== "win32") return statusObservation("unknown", { adapter: "windows-raw", reason: "Windows以外で実行" });
    try {
      if (this.options.statusBackend === "opos") return await this.getOposStatus();
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bundledStatusScript, "-PrinterName", this.options.printerName], { windowsHide: true, maxBuffer: 1024 * 1024 });
      const raw = JSON.parse(String(result.stdout)) as { normalized?: "ready" | "offline" | "unknown" };
      const unknown = (reason: string) => ({ support: "unknown" as const, reason });
      const observation: PrinterStatusObservation = {
        observedAt: new Date().toISOString(),
        reachable: raw.normalized === "ready" ? { support: "supported", value: true } : raw.normalized === "offline" ? { support: "supported", value: false } : unknown("Windows PnP状態を取得できません"),
        online: unknown("Winspool RAWではdevice onlineを取得できません"),
        coverOpen: unknown("Winspool RAWではcover状態を取得できません"),
        drawerOpen: unknown("Winspool RAWではdrawer状態を取得できません"),
        paper: unknown("Winspool RAWではpaper状態を取得できません"),
        error: unknown("Winspool RAWではdevice errorを取得できません"),
        raw: { adapter: "windows-raw", ...raw },
      };
      return observation;
    } catch (error) { return statusObservation("unknown", { adapter: "windows-raw", printerName: this.options.printerName, error: error instanceof Error ? error.message : String(error) }); }
  }
  private async getOposStatus(): Promise<PrinterStatusObservation> {
    if (!this.options.oposLogicalName) return statusObservation("unknown", { adapter: "windows-opos", reason: "PRINTER_OPOS_LOGICAL_NAMEが未設定" });
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bundledOposStatusScript, "-LogicalName", this.options.oposLogicalName, "-ClaimTimeoutMs", String(this.options.oposClaimTimeoutMs ?? 3_000)], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const raw = JSON.parse(String(result.stdout)) as { state?: string; coverOpen?: unknown; receiptEmpty?: unknown; receiptNearEnd?: unknown; errorLevel?: string; errorStation?: string; errorString?: string; [key: string]: unknown };
    const bool = (value: unknown) => typeof value === "boolean" ? { support: "supported" as const, value } : { support: "unknown" as const, reason: "OPOS応答のboolean値が不正です" };
    const errorText = `${raw.errorLevel ?? ""} ${raw.errorStation ?? ""}`.toLowerCase();
    const error = errorText.includes("fatal") || errorText.includes("unrecoverable") ? "unrecoverable" as const : errorText.includes("recover") || errorText.includes("error") ? "recoverable" as const : "none" as const;
    const paper = raw.receiptEmpty === true ? "empty" as const : raw.receiptNearEnd === true ? "near_end" as const : raw.receiptEmpty === false ? "ok" as const : undefined;
    return {
      observedAt: new Date().toISOString(),
      reachable: { support: "supported", value: true },
      online: raw.state ? { support: "supported", value: raw.state.toLowerCase() === "idle" || raw.state.toLowerCase() === "online" } : { support: "unknown", reason: "OPOS stateがありません" },
      coverOpen: bool(raw.coverOpen),
      drawerOpen: { support: "unknown", reason: "OPOS PosPrinter状態ではdrawer開閉を取得できません" },
      paper: paper ? { support: "supported", value: paper } : { support: "unknown", reason: "OPOS paper sensor値がありません" },
      error: { support: "supported", value: error },
      raw,
    };
  }
  async send(bytes: Uint8Array): Promise<SendReceipt> {
    if (process.platform !== "win32") throw new Error("WindowsRawTransport requires Windows");
    const dir = await mkdtemp(join(tmpdir(), "event-pos-printer-"));
    const path = join(dir, "job.bin");
    try {
      await writeFile(path, bytes);
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.options.rawPrintScript ?? bundledRawPrintScript, "-PrinterName", this.options.printerName, "-Path", path, "-DocumentName", "ぽすりん print job"], { windowsHide: true, maxBuffer: 1024 * 1024 });
      const receipt = JSON.parse(String(result.stdout)) as { acceptedBytes?: unknown; spoolerJobId?: unknown; api?: unknown; documentName?: unknown };
      if (!Number.isSafeInteger(receipt.acceptedBytes) || Number(receipt.acceptedBytes) < 0 || Number(receipt.acceptedBytes) > bytes.length) throw new Error("RAW spooler returned invalid acceptedBytes");
      return { acceptedBytes: Number(receipt.acceptedBytes), transportEvidence: { adapter: "windows-raw-spooler", printerName: this.options.printerName, acceptedBytes: Number(receipt.acceptedBytes), ...(Number.isSafeInteger(receipt.spoolerJobId) ? { spoolerJobId: Number(receipt.spoolerJobId) } : {}), ...(typeof receipt.api === "string" ? { api: receipt.api } : {}) } };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async close(): Promise<void> {}
}
