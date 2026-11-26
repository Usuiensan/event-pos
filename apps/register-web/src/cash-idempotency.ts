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

// 保存枠を操作内容ごとに分けるためのキーを作る。
// localStorage はタブ間で共有されるため、単一枠のままだと別の操作（別タブ含む）が
// 保留中のキーを上書きしてしまう。内容のフィンガープリントから枠を分ければ、
// 異なる操作同士は互いのキーを上書き・削除しない（同一内容の操作は同じ枠・同じ
// キーを共有し、サーバーの冪等照合で二重記録にならない）。
export function idempotencyStorageKey(baseKey: string, fingerprint: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index++) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${baseKey}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// 保存が成功したキーを、そのキーの所有者だけが解放する。
// 枠に残っているキーが自分のキーと一致する場合のみ削除し、別操作が採番した
// キーを誤って消さない。
export function releaseIdempotencyKey(storage: IdempotencyStorage, storageKey: string, key: string): void {
  const raw = storage.getItem(storageKey);
  if (!raw) return;
  if (raw === key) {
    storage.removeItem(storageKey);
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { key?: unknown };
    if (parsed.key === key) storage.removeItem(storageKey);
  } catch {
    // 壊れた値は所有者を特定できないため残す
  }
}
