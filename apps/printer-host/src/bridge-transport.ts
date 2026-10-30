import { statusObservation, TransportSendError, type PrinterTransport, type SendReceipt } from "./transport.js";

type BridgeResponseBody = { error?: unknown; printerProblems?: unknown; bytes?: unknown };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class BridgeTransport implements PrinterTransport {
  private readonly url: URL;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options: { token?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private get bridgeUrl(): string { return `${this.url.origin}${this.url.pathname.replace(/\/$/, "")}`; }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return await this.fetchImpl(new URL(path, this.url), { ...init, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  }

  async getStatus() {
    // /health は bot プロセスへの到達性であり、プリンター自体の状態は send 時に bot 側で検証される。
    try {
      const response = await this.request("health", { method: "GET" });
      if (response.status === 200) return statusObservation("ready", { adapter: "bridge", bridgeUrl: this.bridgeUrl, health: "ok" });
      return statusObservation("unknown", { adapter: "bridge", bridgeUrl: this.bridgeUrl, error: `health応答がHTTP ${response.status}です` });
    } catch (error) {
      return statusObservation("unknown", { adapter: "bridge", bridgeUrl: this.bridgeUrl, error: errorMessage(error) });
    }
  }

  async send(bytes: Uint8Array): Promise<SendReceipt> {
    let response: Response;
    try {
      response = await this.request("print", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ data: Buffer.from(bytes).toString("base64") }),
      });
    } catch (error) {
      throw new TransportSendError(`ブリッジへの印刷送信結果が不明です: ${errorMessage(error)}`, 0, false, false);
    }

    let body: BridgeResponseBody = {};
    try {
      const value: unknown = await response.json();
      body = typeof value === "object" && value !== null ? value as BridgeResponseBody : {};
    } catch { /* エラー応答のJSONがない場合もHTTP状態を根拠に扱う */ }
    const responseError = typeof body.error === "string" ? body.error : undefined;
    if (response.status === 200) {
      const responseBytes = body.bytes;
      if (typeof responseBytes !== "number" || responseBytes === bytes.length) {
        return { acceptedBytes: bytes.length, transportEvidence: { adapter: "bridge", bridgeUrl: this.bridgeUrl, statusCode: 200, responseBytes: typeof responseBytes === "number" ? responseBytes : bytes.length } };
      }
      throw new TransportSendError(`ブリッジ応答のバイト数が一致しません（送信=${bytes.length}, 応答=${responseBytes}）`, 0, false, false);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new TransportSendError(responseError ?? `ブリッジが印刷を受け付けませんでした（HTTP ${response.status}）`, 0, true, true);
    }
    const problems = body.printerProblems === undefined ? undefined : ` printerProblems=${JSON.stringify(body.printerProblems)}`;
    throw new TransportSendError(`${responseError ?? `ブリッジ印刷が失敗しました（HTTP ${response.status}）`}${problems ?? ""}`, 0, false, false);
  }

  async close(): Promise<void> {}
}
