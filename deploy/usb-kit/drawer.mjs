// ドロアー駆動: 既定で無効。ドロアーの実機受入が済んだ環境では、環境変数
// DRAWER_ENABLED=1/true、または起動引数 --drawer で有効化する。無効化の明示
// （DRAWER_ENABLED=0/false、または起動引数 --no-drawer）は有効化の指定より
// 優先される。受入が済んでいない環境では有効化しないこと（サーバー側も
// DRAWER_ENABLED=1/true のときだけドロアー job を受け付ける）。
// printer-host には適用しない（呼び出し側でサーバーの env にだけ使う）。
export function drawerEnabled(env = process.env, argv = process.argv) {
  const value = (env.DRAWER_ENABLED ?? "").trim().toLowerCase();
  if (value === "0" || value === "false" || argv.includes("--no-drawer")) return false;
  return value === "1" || value === "true" || argv.includes("--drawer");
}
