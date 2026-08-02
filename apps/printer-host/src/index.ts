import { buildPrinterHost } from "./app.js";
import { createPrinterTransport, resolvePrinterHostRuntime } from "./runtime.js";

const runtime = resolvePrinterHostRuntime();
const transport = createPrinterTransport(runtime);
const log = (event: Record<string, unknown>): void => console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "event-pos-printer-host", ...event }));
// POS is the durable queue and attempt-record authority.  The Host returns
// evidence to the caller; it must not asynchronously overwrite queue state.
const app = buildPrinterHost({ transport, log });
const address = await app.listen({ host: runtime.host, port: runtime.port });
log({ level: "info", event: "host_started", message: "PrinterHostを起動しました", backend: runtime.backend, address, ...(runtime.printerName ? { printerName: runtime.printerName } : {}), ...(runtime.printerDevice ? { printerDevice: runtime.printerDevice } : {}) });

let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  log({ level: "info", event: "host_stopping", message: "PrinterHostを停止します", signal });
  await app.close();
};
process.once("SIGINT", () => { void close("SIGINT"); });
process.once("SIGTERM", () => { void close("SIGTERM"); });
