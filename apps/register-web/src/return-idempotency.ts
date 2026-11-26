import { idempotencyKeyFor, idempotencyStorageKey, releaseIdempotencyKey, type IdempotencyStorage } from "./cash-idempotency.js";

export type ManualRefundKeyInput = {
  eventId: string;
  cashSessionId: string;
  terminalId: string;
  description: string;
  amountYen: number;
  productCode?: string;
  quantity?: number;
  paymentKind: "cash" | "credit" | "accounts_receivable";
  reason?: string;
};

export type ManualRefundKey = { key: string; storageKey: string };

// 例外返金の冪等キーを「返金内容の単位」で管理する（現金操作の cash-idempotency と同じ流儀）。
// サーバーはキーと内容（担当者を含む送信内容一式）を対で記録し、同じキーの再送には
// 記録済みの結果を返すが、内容が違う再送は payload mismatch で拒否する。
// そのため、送信前にキーと内容のフィンガープリントを対で端末へ保持し、
// - 応答が失われても、同じ内容の再試行では同じキーを再利用する（サーバーが記録済みの結果を返す）
// - 内容が変わった再試行では新しいキーを採番する（mismatch で永久に詰まらない）
// 保存枠は返金内容ごとに分け、別の返金（別タブ含む）が保留中のキーを上書きしない。
// 成功を確認したら、そのキーの所有者として releaseManualRefundKey で枠を解放し、
// 次の返金では新しいキーを採番する。
export function manualRefundBaseStorageKey(cashSessionId: string): string {
  return `event-pos-manual-refund-${cashSessionId}`;
}

export function manualRefundFingerprint(input: ManualRefundKeyInput, actorId: string): string {
  return JSON.stringify({
    actorId,
    eventId: input.eventId,
    cashSessionId: input.cashSessionId,
    terminalId: input.terminalId,
    description: input.description,
    amountYen: input.amountYen,
    productCode: input.productCode ?? null,
    quantity: input.productCode ? Math.max(1, Math.trunc(input.quantity ?? 1)) : null,
    paymentKind: input.paymentKind,
    reason: input.reason ?? null,
  });
}

export function manualRefundKeyFor(storage: IdempotencyStorage, input: ManualRefundKeyInput, actorId: string): ManualRefundKey {
  const fingerprint = manualRefundFingerprint(input, actorId);
  const storageKey = idempotencyStorageKey(manualRefundBaseStorageKey(input.cashSessionId), fingerprint);
  return { key: idempotencyKeyFor(storage, storageKey, fingerprint), storageKey };
}

export function releaseManualRefundKey(storage: IdempotencyStorage, pending: ManualRefundKey): void {
  releaseIdempotencyKey(storage, pending.storageKey, pending.key);
}
