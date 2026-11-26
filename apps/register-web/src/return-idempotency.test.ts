import { describe, expect, it } from "vitest";
import type { IdempotencyStorage } from "./cash-idempotency.js";
import { manualRefundFingerprint, manualRefundKeyFor, releaseManualRefundKey, type ManualRefundKeyInput } from "./return-idempotency.js";

function memoryStorage(initial: Record<string, string> = {}): IdempotencyStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

const baseInput: ManualRefundKeyInput = {
  eventId: "event-1",
  cashSessionId: "session-1",
  terminalId: "register-1",
  description: "マスタ異常商品の返金",
  amountYen: 350,
  paymentKind: "cash",
  reason: "商品不良",
};

describe("manualRefundKeyFor", () => {
  it("初回は新しいキーを採番し、内容のフィンガープリントと対で保存する", () => {
    const storage = memoryStorage();
    const pending = manualRefundKeyFor(storage, baseInput, "001");
    expect(pending.key).not.toBe("");
    expect(pending.storageKey).toContain("event-pos-manual-refund-session-1");
    expect(JSON.parse(storage.entries.get(pending.storageKey)!)).toEqual({ key: pending.key, fingerprint: manualRefundFingerprint(baseInput, "001") });
  });

  it("同じ内容・同じ担当者の再試行では同じキーを再利用する（応答喪失後にサーバーが記録済みの結果を返す）", () => {
    const storage = memoryStorage();
    const first = manualRefundKeyFor(storage, baseInput, "001");
    expect(manualRefundKeyFor(storage, { ...baseInput }, "001")).toEqual(first);
  });

  it("返金内容が変わった再試行では新しいキーと別の保存枠になる（保留中のキーを上書きしない）", () => {
    const storage = memoryStorage();
    const first = manualRefundKeyFor(storage, baseInput, "001");
    const changed = manualRefundKeyFor(storage, { ...baseInput, amountYen: 500 }, "001");
    expect(changed.key).not.toBe(first.key);
    expect(changed.storageKey).not.toBe(first.storageKey);
    // 変更後の操作があっても、元の内容のキーは保持されたまま再利用できる
    expect(manualRefundKeyFor(storage, baseInput, "001")).toEqual(first);
    expect(manualRefundKeyFor(storage, { ...baseInput, description: "別の返金" }, "001").key).not.toBe(first.key);
    expect(manualRefundKeyFor(storage, { ...baseInput, paymentKind: "credit" }, "001").key).not.toBe(first.key);
    expect(manualRefundKeyFor(storage, { ...baseInput, reason: "買主都合" }, "001").key).not.toBe(first.key);
  });

  it("担当者が変わると新しいキーになる（サーバーの照合内容に担当者が含まれるため）", () => {
    const storage = memoryStorage();
    const first = manualRefundKeyFor(storage, baseInput, "001");
    expect(manualRefundKeyFor(storage, baseInput, "002").key).not.toBe(first.key);
  });

  it("商品コードと数量も内容に含める", () => {
    const storage = memoryStorage();
    const first = manualRefundKeyFor(storage, { ...baseInput, productCode: "00000001", quantity: 2 }, "001");
    expect(manualRefundKeyFor(storage, { ...baseInput, productCode: "00000001", quantity: 3 }, "001").key).not.toBe(first.key);
    expect(manualRefundKeyFor(storage, { ...baseInput, productCode: "00000002", quantity: 2 }, "001").key).not.toBe(first.key);
    expect(manualRefundKeyFor(storage, { ...baseInput, productCode: "00000001", quantity: 2 }, "001")).toEqual(first);
  });

  it("成功後にキーを解放すれば、同じ内容の次の返金は新しいキーになる", () => {
    const storage = memoryStorage();
    const first = manualRefundKeyFor(storage, baseInput, "001");
    releaseManualRefundKey(storage, first);
    expect(manualRefundKeyFor(storage, baseInput, "001").key).not.toBe(first.key);
  });

  it("別の返金のキーは解放で消えない", () => {
    const storage = memoryStorage();
    const first = manualRefundKeyFor(storage, baseInput, "001");
    const other = manualRefundKeyFor(storage, { ...baseInput, amountYen: 900 }, "001");
    releaseManualRefundKey(storage, first);
    expect(manualRefundKeyFor(storage, { ...baseInput, amountYen: 900 }, "001")).toEqual(other);
  });

  it("別の現金セッションでは別の保存枠を使い、キーが混ざらない", () => {
    const storage = memoryStorage();
    const first = manualRefundKeyFor(storage, baseInput, "001");
    const other = manualRefundKeyFor(storage, { ...baseInput, cashSessionId: "session-2" }, "001");
    expect(other.key).not.toBe(first.key);
    expect(other.storageKey).not.toBe(first.storageKey);
    expect(manualRefundKeyFor(storage, baseInput, "001")).toEqual(first);
  });
});
