import { describe, expect, it } from "vitest";
import { idempotencyKeyFor, idempotencyStorageKey, releaseIdempotencyKey, type IdempotencyStorage } from "./cash-idempotency.js";

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

describe("idempotencyStorageKey（F-073: 操作内容ごとの枠分離）", () => {
  it("同じ内容では同じ枠、異なる内容では異なる枠になる", () => {
    expect(idempotencyStorageKey("base", "fp-1000")).toBe(idempotencyStorageKey("base", "fp-1000"));
    expect(idempotencyStorageKey("base", "fp-1000")).not.toBe(idempotencyStorageKey("base", "fp-2000"));
    expect(idempotencyStorageKey("base", "fp-1000")).not.toBe(idempotencyStorageKey("other", "fp-1000"));
  });

  it("別操作（別タブ）が自分の枠を使っても、保留中のキーは上書きされない", () => {
    const storage = memoryStorage();
    const keyA = idempotencyKeyFor(storage, idempotencyStorageKey("base", "fp-A"), "fp-A");
    const keyB = idempotencyKeyFor(storage, idempotencyStorageKey("base", "fp-B"), "fp-B");
    expect(keyA).not.toBe(keyB);
    // どちらのキーもそれぞれの枠に残っている
    expect(idempotencyKeyFor(storage, idempotencyStorageKey("base", "fp-A"), "fp-A")).toBe(keyA);
    expect(idempotencyKeyFor(storage, idempotencyStorageKey("base", "fp-B"), "fp-B")).toBe(keyB);
  });
});

describe("releaseIdempotencyKey（F-073: 自分のキーだけを解放）", () => {
  it("枠にあるキーが自分のキーなら削除する", () => {
    const storage = memoryStorage();
    const slot = idempotencyStorageKey("base", "fp-A");
    const key = idempotencyKeyFor(storage, slot, "fp-A");
    releaseIdempotencyKey(storage, slot, key);
    expect(storage.entries.has(slot)).toBe(false);
  });

  it("枠にあるキーが別操作のものなら削除しない", () => {
    const storage = memoryStorage();
    const slot = idempotencyStorageKey("base", "fp-A");
    const otherKey = idempotencyKeyFor(storage, slot, "fp-A");
    releaseIdempotencyKey(storage, slot, "00000000-0000-4000-8000-000000000000");
    expect(idempotencyKeyFor(storage, slot, "fp-A")).toBe(otherKey);
  });

  it("別操作の枠は解放の対象にならない", () => {
    const storage = memoryStorage();
    const slotA = idempotencyStorageKey("base", "fp-A");
    const slotB = idempotencyStorageKey("base", "fp-B");
    const keyA = idempotencyKeyFor(storage, slotA, "fp-A");
    const keyB = idempotencyKeyFor(storage, slotB, "fp-B");
    releaseIdempotencyKey(storage, slotA, keyA);
    expect(storage.entries.has(slotA)).toBe(false);
    expect(idempotencyKeyFor(storage, slotB, "fp-B")).toBe(keyB);
  });
});
