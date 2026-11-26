import { idempotencyKeyFor, idempotencyStorageKey, releaseIdempotencyKey, type IdempotencyStorage } from "./cash-idempotency.js";

// 現金操作の「保存」と「保存後の表示更新」を分離した実行フロー。
// 保存POSTが成功した時点で操作は完了であり、その後の集計GETや再読込が失敗しても
// 保存を再試行してはならない（新しい冪等キーで二重記録になるため）。
// 表示更新の失敗は displayError として返し、呼び出し側は確認画面を閉じたうえで
// 「記録済みだが表示更新に失敗した」ことだけを知らせる。
// 保存自体が失敗した場合（応答喪失を含む）はキーを保持し、確認画面も残す。
// 再押下では同じ内容なら同じキーが再利用され、サーバーが記録済みの結果を返す。
export type CashOperationOutcome =
  | { status: "saved"; displayError?: string }
  | { status: "failed"; error: string };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

async function finishAfterSave(save: () => Promise<void>, refreshDisplay: () => Promise<void>): Promise<CashOperationOutcome> {
  try {
    await save();
  } catch (cause) {
    return { status: "failed", error: messageOf(cause, "現金操作に失敗しました") };
  }
  try {
    await refreshDisplay();
    return { status: "saved" };
  } catch (cause) {
    return { status: "saved", displayError: messageOf(cause, "表示を更新できませんでした") };
  }
}

// 冪等キーを使う現金操作（入出金・点検）の実行。
// キーは操作内容ごとの枠で管理し、保存成功時に自分のキーだけを解放する。
export async function executeCashSave(args: {
  storage: IdempotencyStorage;
  storageKey: string;
  fingerprint: string;
  save: (idempotencyKey: string) => Promise<void>;
  refreshDisplay: () => Promise<void>;
}): Promise<CashOperationOutcome> {
  const slotKey = idempotencyStorageKey(args.storageKey, args.fingerprint);
  const idempotencyKey = idempotencyKeyFor(args.storage, slotKey, args.fingerprint);
  const outcome = await finishAfterSave(() => args.save(idempotencyKey), args.refreshDisplay);
  if (outcome.status === "saved") releaseIdempotencyKey(args.storage, slotKey, idempotencyKey);
  return outcome;
}

// 冪等キーのない現金操作（精算の再開）の実行。保存成功＝完了の分離だけを共有する。
export async function executePlainSave(args: {
  save: () => Promise<void>;
  refreshDisplay: () => Promise<void>;
}): Promise<CashOperationOutcome> {
  return finishAfterSave(args.save, args.refreshDisplay);
}
