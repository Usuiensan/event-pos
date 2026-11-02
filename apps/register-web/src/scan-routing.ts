export type ScanClassification =
  | { kind: "parked-draft"; parkReference: string }
  | { kind: "hold"; reference: string }
  | { kind: "transaction"; reference: string; businessDate: string | null }
  | { kind: "product"; raw: string };

// 新しい自店コード形式を足すときは、この表へ判定を1件追加し、
// ScanClassification と main.tsx の handleBarcode に対応する処理を足す。
const SCAN_RULES: Array<(raw: string) => ScanClassification | null> = [
  (raw) => raw.startsWith("PS13") ? { kind: "parked-draft", parkReference: raw.slice(4) } : null,
  (raw) => raw.startsWith("PS12") ? { kind: "hold", reference: raw.slice(4) } : null,
  (raw) => {
    if (!raw.startsWith("PS14")) return null;
    const value = raw.slice(4);
    if (/^\d{14}$/.test(value)) return { kind: "transaction", reference: value.slice(6), businessDate: `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}` };
    return { kind: "transaction", reference: value, businessDate: null };
  },
  (raw) => {
    if (!/^\d{14}$/.test(raw)) return null;
    const month = Number(raw.slice(2, 4)); const day = Number(raw.slice(4, 6));
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { kind: "transaction", reference: raw.slice(6), businessDate: `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}` } : null;
  },
];

export function classifyScan(raw: string): ScanClassification {
  for (const rule of SCAN_RULES) { const result = rule(raw); if (result) return result; }
  return { kind: "product", raw };
}

// キーボードウェッジ型スキャナの入力を受けるバッファの遷移（"*" は呼び出し側で処理）。
// 数字で始まる入力は金額・数字コード用として数字だけを貯め、文字の混入を防ぐ。
// 文字で始まる入力はバーコードのコードとして、印字可能な ASCII をそのまま取り込む。
export function nextInputBuffer(current: string, key: string): string {
  if (/^[0-9]$/.test(key)) return current + key;
  if (/^[\x21-\x7E]$/.test(key)) {
    if (current === "") return key;
    if (/^[0-9]+$/.test(current)) return current;
    return current + key;
  }
  return current;
}

// Enter 時点のバッファの行き先。コード（数字以外を含む）は長さ4以上でスキャン扱い、
// 短いものは誤入力として捨てる。数字だけの入力は従来どおり金額かスキャンかで振り分ける。
export function scanRouteFor(buffer: string, context: { checkoutLocked: boolean; total: number }): "barcode" | "discard" | "payment" {
  if (/[^0-9]/.test(buffer)) return buffer.length >= 4 ? "barcode" : "discard";
  return context.checkoutLocked || context.total === 0 || buffer.length >= 8 ? "barcode" : "payment";
}
