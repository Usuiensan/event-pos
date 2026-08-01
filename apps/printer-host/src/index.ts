import { buildPrinterHost } from "./app.js";
import { FakeTransport } from "./transport.js";
import { LinuxRawTransport } from "./linux-raw-transport.js";
import { HttpStateSink } from "./http-state-sink.js";

const transport = process.env.PRINTER_DEVICE ? new LinuxRawTransport(process.env.PRINTER_DEVICE) : new FakeTransport();
const stateSink = process.env.POS_BASE_URL ? new HttpStateSink(process.env.POS_BASE_URL) : undefined;
const app = buildPrinterHost({ transport, ...(stateSink ? { stateSink } : {}) });
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4318) });
