const DAMM_TABLE: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2], [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9], [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8], [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4], [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5], [2, 5, 8, 1, 4, 3, 6, 7, 9, 0]
];

export type PublicReferenceParts = { session: number; sequence: number; checkDigit: number };

// 現行形式は10桁（営業2桁 + 連番7桁 + 検査数字1桁）。
// 旧形式の8桁（営業1桁 + 連番6桁 + 検査数字1桁）は、発行済みレシートの検証・解析のため引き続き受理する。
function assertBody(body: string): void {
  if (/^\d{9}$/.test(body)) {
    const session = Number(body.slice(0, 2));
    if (session < 1 || session > 99) throw new Error("営業セッション番号は1〜99です");
    if (Number(body.slice(2)) < 1) throw new Error("受付番号連番は0000001以上です");
    return;
  }
  if (/^\d{7}$/.test(body)) {
    const session = Number(body[0]);
    if (session < 1 || session > 9) throw new Error("営業セッション番号は1〜9です");
    if (Number(body.slice(1)) < 1) throw new Error("受付番号連番は000001以上です");
    return;
  }
  throw new Error("受付番号本体は9桁（旧形式は7桁）の数字で指定してください");
}

export function calculateDammCheckDigit(body: string): number {
  assertBody(body);
  let interim = 0;
  for (const character of body) interim = DAMM_TABLE[interim]![Number(character)]!;
  return interim;
}

export function createPublicReference(session: number, sequence: number): string {
  if (!Number.isInteger(session) || session < 1 || session > 99) throw new Error("営業セッション番号は1〜99です");
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999999) throw new Error("受付番号連番は0000001〜9999999です");
  const body = `${String(session).padStart(2, "0")}${String(sequence).padStart(7, "0")}`;
  return `${body}${calculateDammCheckDigit(body)}`;
}

export function validatePublicReference(reference: string): boolean {
  if (!/^\d{10}$/.test(reference) && !/^\d{8}$/.test(reference)) return false;
  const body = reference.slice(0, reference.length - 1);
  try { assertBody(body); } catch { return false; }
  return calculateDammCheckDigit(body) === Number(reference[reference.length - 1]);
}

export function formatPublicReference(reference: string): string {
  if (!validatePublicReference(reference)) throw new Error("受付番号が不正です");
  const split = reference.length === 10 ? 5 : 4;
  return `${reference.slice(0, split)}-${reference.slice(split)}`;
}

export function parsePublicReference(reference: string): PublicReferenceParts {
  const normalized = reference.replace("-", "");
  if (!validatePublicReference(normalized)) throw new Error("受付番号が不正です");
  if (normalized.length === 10) return { session: Number(normalized.slice(0, 2)), sequence: Number(normalized.slice(2, 9)), checkDigit: Number(normalized[9]) };
  return { session: Number(normalized[0]), sequence: Number(normalized.slice(1, 7)), checkDigit: Number(normalized[7]) };
}
