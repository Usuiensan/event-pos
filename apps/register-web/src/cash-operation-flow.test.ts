import { describe, expect, it, vi } from "vitest";
import { executeCashSave, executePlainSave } from "./cash-operation-flow.js";
import { idempotencyKeyFor, idempotencyStorageKey, type IdempotencyStorage } from "./cash-idempotency.js";

function memoryStorage(): IdempotencyStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
}

// apps/server/src/db.ts saveCashMovement の冪等セマンティクス:
// 同じキー＋同じ内容 → 記録済みを返し新規記録しない。新しいキー → 新規記録。
class FakeCashServer {
  movements: Array<{ key: string; amountYen: number }> = [];
  saveMovement(key: string, amountYen: number) {
    const existing = this.movements.find((m) => m.key === key);
    if (existing) {
      if (existing.amountYen !== amountYen) throw new Error("idempotency key payload mismatch");
      return;
    }
    this.movements.push({ key, amountYen });
  }
}

const fingerprint = JSON.stringify({ sessionId: "s1", type: "pay_in", amountYen: 100, reason: "準備金補充" });
const baseKey = "event-pos-cash-movement-s1";

describe("executeCashSave（F-073）", () => {
  it("保存成功後に表示更新だけ失敗しても、保存は1回だけで操作は完了扱いになる", async () => {
    const storage = memoryStorage();
    const server = new FakeCashServer();
    const save = vi.fn(async (key: string) => { server.saveMovement(key, 100); });
    const outcome = await executeCashSave({
      storage, storageKey: baseKey, fingerprint,
      save,
      refreshDisplay: async () => { throw new Error("集計GETに失敗"); },
    });
    // 呼び出し側は status=saved で確認画面を閉じるため、再押下による再保存が起きない
    expect(outcome).toEqual({ status: "saved", displayError: "集計GETに失敗" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(server.movements).toHaveLength(1);
    // 保存成功したキーは解放され、次の正当な同一内容の操作は新しいキーになる
    expect(storage.entries.has(idempotencyStorageKey(baseKey, fingerprint))).toBe(false);
  });

  it("保存の応答が失われた場合はキーを保持し、再試行は同じキーで記録済み結果を受け取る", async () => {
    const storage = memoryStorage();
    const server = new FakeCashServer();
    let loseResponse = true;
    const save = vi.fn(async (key: string) => {
      server.saveMovement(key, 100); // サーバーには記録される
      if (loseResponse) throw new Error("応答が失われた");
    });
    const first = await executeCashSave({ storage, storageKey: baseKey, fingerprint, save, refreshDisplay: async () => {} });
    expect(first.status).toBe("failed");
    expect(server.movements).toHaveLength(1);
    loseResponse = false;
    const second = await executeCashSave({ storage, storageKey: baseKey, fingerprint, save, refreshDisplay: async () => {} });
    expect(second).toEqual({ status: "saved" });
    expect(save.mock.calls[0]?.[0]).toBe(save.mock.calls[1]?.[0]); // 同じキーで再送
    expect(server.movements).toHaveLength(1); // 二重記録にならない
  });

  it("別タブの別操作が並行しても、保留中のキーは上書き・削除されない", async () => {
    const storage = memoryStorage(); // localStorage はタブ間で共有される
    const server = new FakeCashServer();
    const otherFingerprint = JSON.stringify({ sessionId: "s1", type: "pay_out", amountYen: 200, reason: "両替" });
    // タブA: 保存の応答を失って保留中（キーは保持される）
    const outcomeA = await executeCashSave({
      storage, storageKey: baseKey, fingerprint,
      save: async (key) => { server.saveMovement(key, 100); throw new Error("応答が失われた"); },
      refreshDisplay: async () => {},
    });
    expect(outcomeA.status).toBe("failed");
    // タブB: 別内容の操作を完了する（自分のキーだけが解放される）
    const outcomeB = await executeCashSave({
      storage, storageKey: baseKey, fingerprint: otherFingerprint,
      save: async (key) => { server.saveMovement(key, 200); },
      refreshDisplay: async () => {},
    });
    expect(outcomeB.status).toBe("saved");
    // タブAのキーはまだ枠に残っており、再試行で同じキーが使える
    const slotA = idempotencyStorageKey(baseKey, fingerprint);
    expect(storage.entries.has(slotA)).toBe(true);
    expect(idempotencyKeyFor(storage, slotA, fingerprint)).toBe(server.movements[0]?.key);
  });

  it("保存も表示更新も成功すれば displayError なしで完了する", async () => {
    const storage = memoryStorage();
    const server = new FakeCashServer();
    const outcome = await executeCashSave({
      storage, storageKey: baseKey, fingerprint,
      save: async (key) => { server.saveMovement(key, 100); },
      refreshDisplay: async () => {},
    });
    expect(outcome).toEqual({ status: "saved" });
    expect(server.movements).toHaveLength(1);
  });
});

describe("executePlainSave（F-073: 再開も保存成功＝完了）", () => {
  it("保存成功後に表示更新が失敗しても saved を返し、保存は再試行されない", async () => {
    const save = vi.fn(async () => {});
    const outcome = await executePlainSave({ save, refreshDisplay: async () => { throw new Error("再読込に失敗"); } });
    expect(outcome).toEqual({ status: "saved", displayError: "再読込に失敗" });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("保存が失敗したら failed を返し、表示更新は走らない", async () => {
    const refreshDisplay = vi.fn(async () => {});
    const outcome = await executePlainSave({ save: async () => { throw new Error("再開できません"); }, refreshDisplay });
    expect(outcome).toEqual({ status: "failed", error: "再開できません" });
    expect(refreshDisplay).not.toHaveBeenCalled();
  });
});
