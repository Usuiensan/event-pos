// LAN公開: 既定で有効。POSサーバーを 0.0.0.0 で待ち受けさせ、同じネットワークの
// 他端末から接続できるようにする。この端末のみに制限したい場合は、環境変数
// EVENT_POS_LAN=0/false、または起動引数 --no-lan で無効化する（無効化の指定は
// 有効化の指定より優先される）。EVENT_POS_LAN=1/true と --lan は有効化の指定として受理する。
// printer-host と練習環境には適用しない（呼び出し側でサーバーの env にだけ使う）。
export function lanEnabled(env = process.env, argv = process.argv) {
  const value = (env.EVENT_POS_LAN ?? "").trim().toLowerCase();
  if (value === "0" || value === "false" || argv.includes("--no-lan")) return false;
  return true;
}

export function serverHost(env = process.env, argv = process.argv) {
  return lanEnabled(env, argv) ? "0.0.0.0" : "127.0.0.1";
}
