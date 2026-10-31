export type ScanClassification =
  | { kind: "parked-draft"; parkReference: string }
  | { kind: "hold"; reference: string }
  | { kind: "product"; raw: string };

export function classifyScan(raw: string): ScanClassification {
  if (raw.startsWith("PS13")) return { kind: "parked-draft", parkReference: raw.slice(4) };
  if (raw.startsWith("PS12")) return { kind: "hold", reference: raw.slice(4) };
  return { kind: "product", raw };
}
