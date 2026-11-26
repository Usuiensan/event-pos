import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveActiveEventId } from "./active-event.js";
import { demoCatalog } from "./demo-catalog.js";

afterEach(() => vi.unstubAllGlobals());

describe("resolveActiveEventId", () => {
  it("実イベントがあれば実イベントを返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [{ eventId: demoCatalog.eventId, updatedAt: "2026-11-26T00:00:00Z" }, { eventId: "2026kobe", updatedAt: "2026-11-25T00:00:00Z" }] }) }));
    await expect(resolveActiveEventId()).resolves.toBe("2026kobe");
  });

  it("実イベントが無ければデモイベントを返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [] }) }));
    await expect(resolveActiveEventId()).resolves.toBe(demoCatalog.eventId);
  });

  it("一覧の取得が HTTP エラーならデモへ落とさず例外を伝播させる", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: { code: "UNAVAILABLE", message: "unavailable" } }) }));
    await expect(resolveActiveEventId()).rejects.toThrow();
  });

  it("通信自体が失敗しても例外を伝播させる", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(resolveActiveEventId()).rejects.toThrow("network down");
  });
});
