import { describe, expect, it } from "vitest";
import { idempotencyKeyFor, type IdempotencyStorage } from "./cash-idempotency.js";

function memoryStorage(initial: Record<string, string> = {}): IdempotencyStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

describe("idempotencyKeyFor", () => {
  it("初回は新しいキーを採番し、内容のフィンガープリントと対で保存する", () => {
    const storage = memoryStorage();
    const key = idempotencyKeyFor(storage, "event-pos-cash-check-s1-interim", "fp-1000");
    expect(key).not.toBe("");
    expect(JSON.parse(storage.entries.get("event-pos-cash-check-s1-interim")!)).toEqual({ key, fingerprint: "fp-1000" });
  });

  it("同じ内容の再試行では同じキーを再利用する（応答喪失後にサーバーが記録済みの結果を返す）", () => {
    const storage = memoryStorage();
    const first = idempotencyKeyFor(storage, "k", "fp-1000");
    expect(idempotencyKeyFor(storage, "k", "fp-1000")).toBe(first);
  });

  it("内容が変わった再試行では新しいキーを採番し直す（payload mismatch で詰まらない）", () => {
    const storage = memoryStorage();
    const first = idempotencyKeyFor(storage, "k", "fp-1000");
    const second = idempotencyKeyFor(storage, "k", "fp-2000");
    expect(second).not.toBe(first);
    expect(idempotencyKeyFor(storage, "k", "fp-2000")).toBe(second);
  });

  it("旧形式（キー単体の文字列）が残っていても新しいキーに置き換わり、詰まりが解消する", () => {
    const storage = memoryStorage({ k: "11111111-2222-4333-8444-555555555555" });
    const key = idempotencyKeyFor(storage, "k", "fp-1000");
    expect(key).not.toBe("11111111-2222-4333-8444-555555555555");
    expect(idempotencyKeyFor(storage, "k", "fp-1000")).toBe(key);
  });

  it("壊れた値が残っていても新しいキーを採番する", () => {
    const storage = memoryStorage({ k: "{not-json" });
    const key = idempotencyKeyFor(storage, "k", "fp-1000");
    expect(key).not.toBe("");
    expect(idempotencyKeyFor(storage, "k", "fp-1000")).toBe(key);
  });

  it("成功後にキーを消せば、次の操作は新しいキーになる", () => {
    const storage = memoryStorage();
    const first = idempotencyKeyFor(storage, "k", "fp-1000");
    storage.removeItem("k");
    expect(idempotencyKeyFor(storage, "k", "fp-1000")).not.toBe(first);
  });
});
