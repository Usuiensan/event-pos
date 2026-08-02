import { LinuxRawTransport } from "./linux-raw-transport.js";
import { normalizeDleEot, probeLinuxDleEot } from "./linux-status-probe.js";
import { FakeTransport, type PrinterTransport } from "./transport.js";
import { WindowsRawTransport } from "./windows-raw-transport.js";

export type PrinterBackend = "fake" | "linux-raw" | "windows-spooler";

export type PrinterHostRuntime = {
  backend: PrinterBackend;
  host: string;
  port: number;
  printerName?: string;
  printerDevice?: string;
  windowsRawPrintScript?: string;
  statusTimeoutMs: number;
};

function positiveInteger(value: string | undefined, fallback: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name}は1以上${maximum}以下の整数で指定してください`);
  return parsed;
}

export function resolvePrinterHostRuntime(env: NodeJS.ProcessEnv = process.env): PrinterHostRuntime {
  const rawBackend = env.PRINTER_BACKEND;
  if (!rawBackend && env.NODE_ENV === "production") throw new Error("本番起動ではPRINTER_BACKENDの明示が必要です");
  const backend = rawBackend ?? "fake";
  if (!(["fake", "linux-raw", "windows-spooler"] as const).includes(backend as PrinterBackend)) throw new Error(`未対応のPRINTER_BACKENDです: ${backend}`);
  const selectedBackend = backend as PrinterBackend;
  const common = {
    backend: selectedBackend,
    host: env.HOST ?? "127.0.0.1",
    port: positiveInteger(env.PORT, 4318, "PORT", 65535),
    statusTimeoutMs: positiveInteger(env.PRINTER_STATUS_TIMEOUT_MS, 1_000, "PRINTER_STATUS_TIMEOUT_MS", 60_000),
  };
  if (selectedBackend === "linux-raw") {
    if (!env.PRINTER_DEVICE) throw new Error("linux-rawにはPRINTER_DEVICEが必要です");
    return { ...common, printerDevice: env.PRINTER_DEVICE };
  }
  if (selectedBackend === "windows-spooler") {
    if (!env.PRINTER_NAME) throw new Error("windows-spoolerにはPRINTER_NAMEが必要です");
    return { ...common, printerName: env.PRINTER_NAME, ...(env.WINDOWS_RAW_PRINT_SCRIPT ? { windowsRawPrintScript: env.WINDOWS_RAW_PRINT_SCRIPT } : {}) };
  }
  return common;
}

export function createPrinterTransport(runtime: PrinterHostRuntime): PrinterTransport {
  if (runtime.backend === "windows-spooler") return new WindowsRawTransport({ printerName: runtime.printerName!, ...(runtime.windowsRawPrintScript ? { rawPrintScript: runtime.windowsRawPrintScript } : {}) });
  if (runtime.backend === "linux-raw") {
    const device = runtime.printerDevice!;
    return new LinuxRawTransport(device, async () => {
      const raw = await probeLinuxDleEot(device, runtime.statusTimeoutMs);
      return { status: normalizeDleEot(raw), raw };
    });
  }
  return new FakeTransport();
}
