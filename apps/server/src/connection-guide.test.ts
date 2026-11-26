import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { isLanPublished, lanAddresses } from "./connection-guide.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

function setup(options: Parameters<typeof buildApp>[0]): FastifyInstance {
  const app = buildApp(options);
  apps.push(app);
  return app;
}

describe("接続案内API", () => {
  it("LAN公開時はlanPublishedと待ち受けポートとLANアドレス一覧を返す", async () => {
    const app = setup({ database: openDatabase(), listenInfo: { host: "0.0.0.0", port: 3000 } });
    const response = await app.inject({ method: "GET", url: "/api/v1/connection-guide" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.host).toBe("0.0.0.0");
    expect(body.port).toBe(3000);
    expect(body.lanPublished).toBe(true);
    expect(Array.isArray(body.addresses)).toBe(true);
    for (const address of body.addresses) {
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(address).not.toBe("127.0.0.1");
    }
    for (const entry of body.urls) {
      expect(entry.registerUrl).toBe(`http://${entry.address}:3000/?register=1&role=staff`);
      expect(entry.customerUrl).toBe(`http://${entry.address}:3000/?register=1&role=customer`);
    }
    expect(body.wifi).toEqual({ ssid: "", password: "" });
  });

  it("listenInfo未指定では127.0.0.1:3000でLAN未公開になる", async () => {
    const app = setup({ database: openDatabase() });
    const body = (await app.inject({ method: "GET", url: "/api/v1/connection-guide" })).json();
    expect(body.host).toBe("127.0.0.1");
    expect(body.port).toBe(3000);
    expect(body.lanPublished).toBe(false);
  });

  it("Wi-Fi設定を保存して読み戻せ、監査ログにパスワードを含めない", async () => {
    const db = openDatabase();
    const app = setup({ database: db, listenInfo: { host: "0.0.0.0", port: 3000 } });
    const saved = await app.inject({ method: "PUT", url: "/api/v1/connection-guide/wifi", payload: { ssid: "MyPhone", password: "password123" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().wifi).toEqual({ ssid: "MyPhone", password: "password123" });
    const guide = (await app.inject({ method: "GET", url: "/api/v1/connection-guide" })).json();
    expect(guide.wifi).toEqual({ ssid: "MyPhone", password: "password123" });
    const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action='connection_wifi_updated'").get() as { detail_json: string };
    expect(audit.detail_json).toContain("MyPhone");
    expect(audit.detail_json).not.toContain("password123");
  });

  it("SSID空・長すぎるSSID・短いパスワードを400で拒否する", async () => {
    const app = setup({ database: openDatabase() });
    for (const payload of [
      { ssid: "", password: "password123" },
      { ssid: "あ".repeat(11), password: "password123" },
      { ssid: "MyPhone", password: "short" },
      { ssid: "MyPhone", password: "x".repeat(64) },
    ]) {
      const response = await app.inject({ method: "PUT", url: "/api/v1/connection-guide/wifi", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("CONNECTION_WIFI_INVALID");
    }
    const ok = await app.inject({ method: "PUT", url: "/api/v1/connection-guide/wifi", payload: { ssid: "MyPhone", password: "" } });
    expect(ok.statusCode).toBe(200);
  });
});

describe("lanAddresses / isLanPublished", () => {
  it("internalとIPv6を除き、重複を取り除く", () => {
    const interfaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      en0: [
        { address: "192.168.68.119", family: "IPv4", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
      en1: [{ address: "192.168.68.119", family: "IPv4", internal: false } as never, { address: "10.0.0.5", family: "IPv4", internal: false } as never],
      utun: undefined,
    };
    expect(lanAddresses(interfaces as never)).toEqual(["192.168.68.119", "10.0.0.5"]);
  });

  it("公開ホスト判定", () => {
    expect(isLanPublished("0.0.0.0")).toBe(true);
    expect(isLanPublished("::")).toBe(true);
    expect(isLanPublished("127.0.0.1")).toBe(false);
    expect(isLanPublished("192.168.68.119")).toBe(false);
  });
});
