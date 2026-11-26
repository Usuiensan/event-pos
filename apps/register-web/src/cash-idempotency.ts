import { createUuid } from "./uuid.js";

export type IdempotencyStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// 現金操作の冪等キーを「操作内容の単位」で管理する。
// サーバーはキーと内容（金額・金種・理由など）を対で記録し、同じキーの再送には
// 記録済みの結果を返すが、内容が違う再送は payload mismatch で拒否する。
// そのため、応答が失われた場合に備えてキーと内容のフィンガープリントを対で保持し、
// - 同じ内容の再試行では同じキーを再利用する（サーバーが記録済みの結果を返す）
// - 内容が変わった再試行では新しいキーを採番する（mismatch で永久に詰まらない）
// 旧形式（キー単体の文字列）や壊れた値が残っている場合は、内容が特定できないため
// 新しいキーに置き換える（従来形式で詰まった端末も次回操作で回復する）。
export function idempotencyKeyFor(storage: IdempotencyStorage, storageKey: string, fingerprint: string): string {
  const raw = storage.getItem(storageKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { key?: unknown; fingerprint?: unknown };
      if (typeof parsed.key === "string" && parsed.fingerprint === fingerprint) return parsed.key;
    } catch {
      // 旧形式・破損値は内容不明として新しいキーを採番する
    }
  }
  const key = createUuid();
  storage.setItem(storageKey, JSON.stringify({ key, fingerprint }));
  return key;
}
