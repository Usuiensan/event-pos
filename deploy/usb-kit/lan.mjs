// LAN公開オプション: 環境変数 EVENT_POS_LAN=1/true、または起動引数 --lan のときに
// POSサーバーを 0.0.0.0 で待ち受けさせる。既定は 127.0.0.1（この端末のみ）。
// printer-host と練習環境には適用しない（呼び出し側でサーバーの env にだけ使う）。
export function lanEnabled(env = process.env, argv = process.argv) {
  const value = (env.EVENT_POS_LAN ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || argv.includes("--lan");
}

export function serverHost(env = process.env, argv = process.argv) {
  return lanEnabled(env, argv) ? "0.0.0.0" : "127.0.0.1";
}
