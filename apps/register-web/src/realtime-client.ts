export type RealtimeClientOptions = {
  registerId: string;
  terminalId: string;
  role: "staff" | "customer";
  onNotification(notification: Record<string, unknown>): void;
  onReconnect(): void;
  createWebSocket?: (url: string) => WebSocket;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
  locationValue?: Pick<Location, "protocol" | "host">;
};

export function websocketUrl(scope: Pick<RealtimeClientOptions, "registerId" | "terminalId" | "role">, locationValue: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = locationValue.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ registerId: scope.registerId, terminalId: scope.terminalId, role: scope.role });
  const training = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "training";
  return `${protocol}//${locationValue.host}${training ? "/training-api" : ""}/api/v1/events?${query}`;
}

export function connectRealtime(options: RealtimeClientOptions): () => void {
  const createWebSocket = options.createWebSocket ?? ((url: string) => new WebSocket(url));
  const setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => window.clearTimeout(timer));
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let retry = 0;

  const connect = () => {
    if (stopped) return;
    socket = createWebSocket(websocketUrl(options, options.locationValue ?? window.location));
    socket.addEventListener("open", () => { retry = 0; options.onReconnect(); });
    socket.addEventListener("message", (event) => {
      try { options.onNotification(JSON.parse(String(event.data)) as Record<string, unknown>); } catch { /* 通知本文は状態の正本にしない */ }
    });
    const reconnect = () => {
      if (stopped || reconnectTimer !== null) return;
      const delay = Math.min(8_000, 250 * 2 ** retry);
      retry = Math.min(retry + 1, 8);
      reconnectTimer = setTimer(() => { reconnectTimer = null; connect(); }, delay);
    };
    socket.addEventListener("close", reconnect);
    socket.addEventListener("error", () => socket?.close());
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    socket?.close(1000, "画面を終了します");
  };
}
