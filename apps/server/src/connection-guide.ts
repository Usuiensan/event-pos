import { networkInterfaces } from "node:os";
import type { FastifyInstance } from "fastify";
import type { PosDatabase } from "./db.js";
import { AuthError, requireAuthActor } from "./auth.js";
import { CheckoutError } from "./checkout-store.js";

// 接続案内（管理画面）向け: 待ち受け情報・自機のLANアドレス・Wi-Fi（テザリング）設定を返す。
// Wi-Fi設定は app_metadata に保存する。パスワードは監査ログに残さない。

export type ListenInfo = { host: string; port: number };
export type ConnectionGuideOptions = { database: PosDatabase; authRequired: boolean; listenInfo?: ListenInfo };

const SSID_KEY = "connection_wifi_ssid";
const PASSWORD_KEY = "connection_wifi_password";
const DEFAULT_LISTEN: ListenInfo = { host: "127.0.0.1", port: 3000 };

export function lanAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const addresses: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      const isIpv4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (isIpv4 && !info.internal && !addresses.includes(info.address)) addresses.push(info.address);
    }
  }
  return addresses;
}

export function isLanPublished(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function readMetadata(db: PosDatabase, key: string): string {
  const row = db.prepare("SELECT value FROM app_metadata WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

function writeMetadata(db: PosDatabase, key: string, value: string): void {
  db.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function readWifi(db: PosDatabase): { ssid: string; password: string } {
  return { ssid: readMetadata(db, SSID_KEY), password: readMetadata(db, PASSWORD_KEY) };
}

const error = (reply: any, e: unknown) => {
  if (e instanceof CheckoutError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: e.details } });
  if (e instanceof AuthError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, details: {} } });
  return reply.code(500).send({ error: { code: "CONNECTION_GUIDE_ERROR", message: "処理に失敗しました", details: {} } });
};

export function registerConnectionGuideRoutes(app: FastifyInstance, options: ConnectionGuideOptions): void {
  app.get("/api/v1/connection-guide", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "manager", options.authRequired);
      const listen = options.listenInfo ?? DEFAULT_LISTEN;
      const addresses = lanAddresses();
      return {
        host: listen.host,
        port: listen.port,
        lanPublished: isLanPublished(listen.host),
        addresses,
        urls: addresses.map((address) => ({
          address,
          registerUrl: `http://${address}:${listen.port}/?register=1&role=staff`,
          customerUrl: `http://${address}:${listen.port}/?register=1&role=customer`,
        })),
        wifi: readWifi(options.database),
      };
    } catch (e) { return error(reply, e); }
  });

  app.put<{ Body: { ssid?: unknown; password?: unknown } }>("/api/v1/connection-guide/wifi", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "manager", options.authRequired);
      const body = request.body ?? {};
      const ssid = typeof body.ssid === "string" ? body.ssid.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!ssid || new TextEncoder().encode(ssid).length > 32) throw new CheckoutError(400, "CONNECTION_WIFI_INVALID", "SSIDは1〜32バイトで入力してください");
      if (password !== "" && (password.length < 8 || password.length > 63)) throw new CheckoutError(400, "CONNECTION_WIFI_INVALID", "パスワードは空（暗号化なし）か8〜63文字で入力してください");
      const db = options.database;
      const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        writeMetadata(db, SSID_KEY, ssid);
        writeMetadata(db, PASSWORD_KEY, password);
        db.prepare("INSERT INTO audit_log (event_id, action, entity_type, entity_id, detail_json, created_at) VALUES (NULL, 'connection_wifi_updated', 'connection_guide', 'wifi', ?, ?)").run(JSON.stringify({ ssid, passwordSet: password !== "", actorId: actor.staffId }), now);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      return { wifi: readWifi(db) };
    } catch (e) { return error(reply, e); }
  });
}
