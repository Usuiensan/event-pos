import { buildPrinterHost } from "./app.js";
import { FakeTransport } from "./transport.js";
import { LinuxRawTransport } from "./linux-raw-transport.js";
import { WindowsRawTransport } from "./windows-raw-transport.js";

const transport = process.env.PRINTER_BACKEND === "windows-spooler"
  ? new WindowsRawTransport({ printerName: process.env.PRINTER_NAME ?? "EPSON TM-T70II Receipt", ...(process.env.WINDOWS_RAW_PRINT_SCRIPT ? { rawPrintScript: process.env.WINDOWS_RAW_PRINT_SCRIPT } : {}) })
  : process.env.PRINTER_DEVICE ? new LinuxRawTransport(process.env.PRINTER_DEVICE) : new FakeTransport();
// POS is the durable queue and attempt-record authority.  The Host returns
// evidence to the caller; it must not asynchronously overwrite queue state.
const app = buildPrinterHost({ transport });
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4318) });
