import type { AuthActor } from "./checkout-api.js";

// 精算済みレジのライフサイクル画面から、現金管理モーダル（精算の再開フォームがある）を開けるか。
// 再開はサーバー側で manager 以上が必要なため、入口も同じロールに限る
// （同じ画面の「営業を終了する」と同条件。実行できない操作の入口を operator に出さない）。
export function canOpenCashOperationsForReopen(registerState: string, role: AuthActor["role"]): boolean {
  return registerState === "closed" && (role === "manager" || role === "admin");
}
