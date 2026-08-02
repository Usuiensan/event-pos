import { describe, expect, it, vi } from "vitest";
import { connectRealtime, websocketUrl } from "./realtime-client.js";

class FakeSocket extends EventTarget {
  close = vi.fn(() => this.dispatchEvent(new Event("close")));
}

describe("WebSocket復元", () => {
  it("HTTPSではwss URLへ小さいscopeだけを付ける", () => {
    expect(websocketUrl({ registerId: "register-1", terminalId: "customer-1", role: "customer" }, { protocol: "https:", host: "pos.local" })).toBe("wss://pos.local/api/v1/events?registerId=register-1&terminalId=customer-1&role=customer");
  });

  it("切断後に250msから指数バックオフし、接続時にREST復元を要求する", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const onReconnect = vi.fn();
    const stop = connectRealtime({
      registerId: "register-1", terminalId: "staff-1", role: "staff", onNotification: vi.fn(), onReconnect,
      locationValue: { protocol: "http:", host: "pos.local" },
      createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimer: vi.fn(),
    });
    sockets[0]!.dispatchEvent(new Event("close"));
    expect(timers[0]!.delay).toBe(250);
    timers[0]!.callback();
    sockets[1]!.dispatchEvent(new Event("close"));
    expect(timers[1]!.delay).toBe(500);
    sockets[1]!.dispatchEvent(new Event("open"));
    expect(onReconnect).toHaveBeenCalledOnce();
    stop();
  });
});
