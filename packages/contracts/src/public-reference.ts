const DAMM_TABLE: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2], [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9], [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8], [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4], [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5], [2, 5, 8, 1, 4, 3, 6, 7, 9, 0]
];

export type PublicReferenceParts = { session: number; sequence: number; checkDigit: number };

function assertBody(body: string): void {
  if (!/^\d{7}$/.test(body)) throw new Error("受付番号本体は7桁の数字で指定してください");
  const session = Number(body[0]);
  if (session < 1 || session > 9) throw new Error("営業セッション番号は1〜9です");
  if (Number(body.slice(1)) < 1) throw new Error("受付番号連番は000001以上です");
}

export function calculateDammCheckDigit(body: string): number {
  assertBody(body);
  let interim = 0;
  for (const character of body) interim = DAMM_TABLE[interim]![Number(character)]!;
  return interim;
}

export function createPublicReference(session: number, sequence: number): string {
  if (!Number.isInteger(session) || session < 1 || session > 9) throw new Error("営業セッション番号は1〜9です");
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999999) throw new Error("受付番号連番は000001〜999999です");
  const body = `${session}${String(sequence).padStart(6, "0")}`;
  return `${body}${calculateDammCheckDigit(body)}`;
}

export function validatePublicReference(reference: string): boolean {
  if (!/^\d{8}$/.test(reference)) return false;
  const body = reference.slice(0, 7);
  try { assertBody(body); } catch { return false; }
  return calculateDammCheckDigit(body) === Number(reference[7]);
}

export function formatPublicReference(reference: string): string {
  if (!validatePublicReference(reference)) throw new Error("受付番号が不正です");
  return `${reference.slice(0, 4)}-${reference.slice(4)}`;
}

export function parsePublicReference(reference: string): PublicReferenceParts {
  const normalized = reference.replace("-", "");
  if (!validatePublicReference(normalized)) throw new Error("受付番号が不正です");
  return { session: Number(normalized[0]), sequence: Number(normalized.slice(1, 7)), checkDigit: Number(normalized[7]) };
}
