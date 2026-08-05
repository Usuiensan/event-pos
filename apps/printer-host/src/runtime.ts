import { LinuxRawTransport } from "./linux-raw-transport.js";
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
  windowsStatusBackend?: "spooler" | "opos";
  oposLogicalName?: string;
  oposClaimTimeoutMs?: number;
  statusTimeoutMs: number;
  drawerOpenHigh?: boolean;
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
    ...(env.PRINTER_DRAWER_OPEN_HIGH === "1" || env.PRINTER_DRAWER_OPEN_HIGH === "true" ? { drawerOpenHigh: true } : env.PRINTER_DRAWER_OPEN_HIGH === "0" || env.PRINTER_DRAWER_OPEN_HIGH === "false" ? { drawerOpenHigh: false } : {}),
  };
  if (selectedBackend === "linux-raw") {
    if (!env.PRINTER_DEVICE) throw new Error("linux-rawにはPRINTER_DEVICEが必要です");
    return { ...common, printerDevice: env.PRINTER_DEVICE };
  }
  if (selectedBackend === "windows-spooler") {
    if (!env.PRINTER_NAME) throw new Error("windows-spoolerにはPRINTER_NAMEが必要です");
    if (env.PRINTER_STATUS_BACKEND && !["spooler", "opos"].includes(env.PRINTER_STATUS_BACKEND)) throw new Error(`未対応のPRINTER_STATUS_BACKENDです: ${env.PRINTER_STATUS_BACKEND}`);
    const statusBackend = env.PRINTER_STATUS_BACKEND === "opos" ? "opos" as const : "spooler" as const;
    if (statusBackend === "opos" && !env.PRINTER_OPOS_LOGICAL_NAME) throw new Error("PRINTER_STATUS_BACKEND=oposにはPRINTER_OPOS_LOGICAL_NAMEが必要です");
    return { ...common, printerName: env.PRINTER_NAME, windowsStatusBackend: statusBackend, ...(env.PRINTER_OPOS_LOGICAL_NAME ? { oposLogicalName: env.PRINTER_OPOS_LOGICAL_NAME } : {}), ...(env.PRINTER_OPOS_CLAIM_TIMEOUT_MS ? { oposClaimTimeoutMs: positiveInteger(env.PRINTER_OPOS_CLAIM_TIMEOUT_MS, 3_000, "PRINTER_OPOS_CLAIM_TIMEOUT_MS", 60_000) } : {}), ...(env.WINDOWS_RAW_PRINT_SCRIPT ? { windowsRawPrintScript: env.WINDOWS_RAW_PRINT_SCRIPT } : {}) };
  }
  return common;
}

export function createPrinterTransport(runtime: PrinterHostRuntime): PrinterTransport {
  if (runtime.backend === "windows-spooler") return new WindowsRawTransport({ printerName: runtime.printerName!, ...(runtime.windowsRawPrintScript ? { rawPrintScript: runtime.windowsRawPrintScript } : {}), ...(runtime.windowsStatusBackend ? { statusBackend: runtime.windowsStatusBackend } : {}), ...(runtime.oposLogicalName ? { oposLogicalName: runtime.oposLogicalName } : {}), ...(runtime.oposClaimTimeoutMs ? { oposClaimTimeoutMs: runtime.oposClaimTimeoutMs } : {}) });
  if (runtime.backend === "linux-raw") {
    const device = runtime.printerDevice!;
    return new LinuxRawTransport(device, undefined, undefined, runtime.statusTimeoutMs, runtime.drawerOpenHigh);
  }
  return new FakeTransport();
}
