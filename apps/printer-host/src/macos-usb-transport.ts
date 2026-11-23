import type { PrinterStatusObservation } from "@event-pos/contracts";
import { decodeDleEot, type RawStatusObservation } from "./linux-status-probe.js";
import { TransportSendError, type PrinterTransport, type SendReceipt, statusObservation } from "./transport.js";

export type MacOsUsbTransportOptions = {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  timeoutMs?: number;
  drawerOpenHigh?: boolean;
};
type UsbDevice = NonNullable<Awaited<ReturnType<typeof import("usb").usb.findDeviceByIds>>>;

function usbDisconnected(error: unknown): boolean { return /disconnected/i.test(error instanceof Error ? error.message : String(error)); }

/** Direct USB ESC/POS transport for a printer attached to the macOS host. */
export class MacOsUsbTransport implements PrinterTransport {
  readonly statusPollingSharesTransport = true;
  private device: UsbDevice | undefined;
  private interfaceNumber: number | undefined;
  private inputEndpoint: number | undefined;
  private outputEndpoint: number | undefined;
  private opening: Promise<UsbDevice> | undefined;

  constructor(private readonly options: MacOsUsbTransportOptions) {}

  private async ensureOpen(): Promise<UsbDevice> {
    if (this.device?.opened) return this.device;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const { usb } = await import("usb");
      const device = this.options.serialNumber
        ? await usb.findDeviceBySerial(this.options.serialNumber)
        : await usb.findDeviceByIds(this.options.vendorId, this.options.productId);
      if (!device || device.vendorId !== this.options.vendorId || device.productId !== this.options.productId) throw new Error("指定したEpson USBプリンターが見つかりません");
      const configurations = device.configurations as Array<{ interfaces: Array<{ interfaceNumber: number; alternates: Array<{ endpoints: Array<{ direction: string; type: string; endpointNumber: number }> }> }> }>;
      const iface = configurations.flatMap((configuration) => configuration.interfaces).find((candidate) => {
        const alternate = candidate.alternates.find((entry) => entry.endpoints.some((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk") && entry.endpoints.some((endpoint) => endpoint.direction === "in" && endpoint.type === "bulk"));
        if (!alternate) return false;
        this.inputEndpoint = alternate.endpoints.find((endpoint) => endpoint.direction === "in" && endpoint.type === "bulk")!.endpointNumber;
        this.outputEndpoint = alternate.endpoints.find((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk")!.endpointNumber;
        this.interfaceNumber = candidate.interfaceNumber;
        return true;
      });
      if (!iface || this.inputEndpoint === undefined || this.outputEndpoint === undefined || this.interfaceNumber === undefined) throw new Error("ESC/POS用の双方向USBエンドポイントがありません");
      await device.open();
      try {
        await device.claimInterface(this.interfaceNumber);
      } catch (error) {
        await device.close().catch(() => undefined);
        throw error;
      }
      this.device = device;
      return device;
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  async getStatus(): Promise<PrinterStatusObservation> {
    const observations: RawStatusObservation[] = [];
    try {
      const device = await this.ensureOpen();
      // Clear replies left by a previously interrupted poll before pairing the
      // next request and reply. USB printers can return several queued status
      // bytes in one bulk read.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const pending = await device.nativeTransferIn(this.inputEndpoint!, 50, 64).catch(() => null);
        if (!pending?.byteLength) break;
      }
      for (const n of [1, 2, 3, 4]) {
        const request = Uint8Array.from([0x10, 0x04, n]);
        try {
          await device.nativeTransferOut(this.outputEndpoint!, 1_000, request);
          await new Promise((resolve) => setTimeout(resolve, 30));
          const response = await device.nativeTransferIn(this.inputEndpoint!, this.options.timeoutMs ?? 1_000, 64);
          const responseHex = response?.byteLength === 1 ? Buffer.from(response).toString("hex") : null;
          observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex, normalized: "unknown", timeoutMs: this.options.timeoutMs ?? 1_000, ...(responseHex ? {} : { error: "timeout" }) });
        } catch (error) {
          if (usbDisconnected(error)) {
            await this.close();
            return statusObservation("offline", { adapter: "macos-usb", vendorId: this.options.vendorId, productId: this.options.productId, error: error instanceof Error ? error.message : String(error) });
          }
          observations.push({ requestHex: Buffer.from(request).toString("hex"), responseHex: null, normalized: "unknown", timeoutMs: this.options.timeoutMs ?? 1_000, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { ...decodeDleEot(observations, this.options.drawerOpenHigh), raw: { adapter: "macos-usb", vendorId: this.options.vendorId, productId: this.options.productId, serialNumber: device.serialNumber, statusProbe: observations } };
    } catch (error) {
      return statusObservation("offline", { adapter: "macos-usb", vendorId: this.options.vendorId, productId: this.options.productId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async send(bytes: Uint8Array): Promise<SendReceipt> {
    let acceptedBytes = 0;
    try {
      const device = await this.ensureOpen();
      const accepted = await device.nativeTransferOut(this.outputEndpoint!, 10_000, bytes);
      acceptedBytes = accepted;
      if (accepted !== bytes.byteLength) throw new Error(`USB転送byte数が一致しません (${accepted}/${bytes.byteLength})`);
      return { acceptedBytes, transportEvidence: { adapter: "macos-usb", vendorId: this.options.vendorId, productId: this.options.productId, serialNumber: device.serialNumber ?? "", acceptedBytes } };
    } catch (error) {
      if (usbDisconnected(error)) await this.close();
      throw new TransportSendError(error instanceof Error ? error.message : "USB printer write failed", acceptedBytes, false, false);
    }
  }

  async close(): Promise<void> {
    const device = this.device;
    this.device = undefined;
    if (!device?.opened) return;
    if (this.interfaceNumber !== undefined) await device.releaseInterface(this.interfaceNumber).catch(() => undefined);
    await device.close().catch(() => undefined);
  }
}
