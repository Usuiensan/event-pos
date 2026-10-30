import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeTransport } from "./bridge-transport.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }))); });

async function startServer(handler: (request: import("node:http").IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((request, response) => {
    response.setHeader("Connection", "close");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => handler(request, response, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  return `http://127.0.0.1:${address.port}/bridge/`;
}

describe("BridgeTransport", () => {
  it("送信バイトをbase64で送信し、Authorizationを付ける", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250]);
    const url = await startServer((request, response, body) => {
      expect(request.url).toBe("/bridge/print");
      expect(request.headers.authorization).toBe("Bearer test-token");
      expect(Buffer.from(JSON.parse(body).data, "base64")).toEqual(Buffer.from(bytes));
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ bytes: bytes.length }));
    });
    const transport = new BridgeTransport(url, { token: "test-token" });
    const receipt = await transport.send(bytes);
    expect(receipt).toMatchObject({ acceptedBytes: bytes.length, transportEvidence: { adapter: "bridge" } });
  });

  it("400は未送信が証明された再試行可能エラーにする", async () => {
    const url = await startServer((_request, response, _body) => { response.statusCode = 400; response.end(JSON.stringify({ error: "入力不備" })); });
    const transport = new BridgeTransport(url);
    await expect(transport.send(Uint8Array.from([1]))).rejects.toMatchObject({ notSentProven: true, retryable: true, acceptedBytes: 0, message: "入力不備" });
  });

  it("500は印刷結果不明として再試行不可にする", async () => {
    const url = await startServer((_request, response, _body) => { response.statusCode = 500; response.end(JSON.stringify({ error: "printer failed", printerProblems: ["paper"] })); });
    const transport = new BridgeTransport(url);
    await expect(transport.send(Uint8Array.from([1]))).rejects.toMatchObject({ notSentProven: false, retryable: false, message: expect.stringContaining("paper") });
  });

  it("接続失敗は結果不明にする", async () => {
    const transport = new BridgeTransport("http://127.0.0.1:1", { timeoutMs: 100 });
    await expect(transport.send(Uint8Array.from([1]))).rejects.toMatchObject({ notSentProven: false, retryable: false, acceptedBytes: 0 });
  });

  it("healthの到達性をstatusへ反映する", async () => {
    const url = await startServer((_request, response, _body) => { response.end(JSON.stringify({ ok: true })); });
    const transport = new BridgeTransport(url);
    expect(await transport.getStatus()).toMatchObject({ reachable: { value: true }, raw: { adapter: "bridge", health: "ok" } });
    const stopped = new BridgeTransport("http://127.0.0.1:1", { timeoutMs: 100 });
    expect(await stopped.getStatus()).toMatchObject({ reachable: { support: "unknown" }, raw: { adapter: "bridge" } });
  });
});
