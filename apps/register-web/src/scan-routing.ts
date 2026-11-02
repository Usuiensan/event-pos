export type ScanClassification =
  | { kind: "parked-draft"; parkReference: string }
  | { kind: "hold"; reference: string }
  | { kind: "transaction"; reference: string; businessDate: string | null }
  | { kind: "product"; raw: string };

export function classifyScan(raw: string): ScanClassification {
  if (raw.startsWith("PS13")) return { kind: "parked-draft", parkReference: raw.slice(4) };
  if (raw.startsWith("PS12")) return { kind: "hold", reference: raw.slice(4) };
  if (raw.startsWith("PS14")) { const value = raw.slice(4); if (/^\d{14}$/.test(value)) return { kind: "transaction", reference: value.slice(6), businessDate: `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}` }; return { kind: "transaction", reference: value, businessDate: null }; }
  if (/^\d{14}$/.test(raw)) { const month = Number(raw.slice(2, 4)); const day = Number(raw.slice(4, 6)); if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { kind: "transaction", reference: raw.slice(6), businessDate: `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}` }; }
  return { kind: "product", raw };
}

// キーボードウェッジ型スキャナの入力を受けるバッファの遷移。
// 通常は金額入力のため数字だけを貯めるが、PS12/PS13/PS14 で始まる自店コードは
// 文字も含めて取り込む。PS の流れが崩れた数字は金額入力として再解釈する。
export function nextInputBuffer(current: string, key: string): string {
  if (/^[0-9]$/.test(key)) {
    if (current === "P") return key;
    if (current === "PS") return key === "1" ? "PS1" : key;
    if (current === "PS1") return key === "2" || key === "3" || key === "4" ? current + key : key;
    return current + key;
  }
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    if (current === "" && upper === "P") return "P";
    if (current === "P" && upper === "S") return "PS";
    if (/^PS1[234]/.test(current)) return "";
  }
  return current;
}
