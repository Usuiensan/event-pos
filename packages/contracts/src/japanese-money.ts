const digits = ["ぜろ", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"] as const;
const smallUnits = ["", "じゅう", "ひゃく", "せん"] as const;

function readGroup(value: number): string[] {
  const parts: string[] = [];
  for (let place = 3; place >= 0; place -= 1) {
    const divisor = 10 ** place;
    const digit = Math.floor(value / divisor) % 10;
    if (digit === 0) continue;
    if (place === 0) parts.push(digits[digit]);
    else if (place === 1) parts.push(digit === 1 ? "じゅう" : `${digits[digit]}じゅう`);
    else if (place === 2) parts.push(digit === 1 ? "ひゃく" : `${digits[digit]}ひゃく`);
    else parts.push(digit === 1 ? "せん" : `${digits[digit]}せん`);
  }
  return parts;
}

export function readJapaneseYen(amount: number): string[] {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError("金額は0以上の安全な整数で指定してください");
  if (amount === 0) return ["ぜろえん"];
  const parts: string[] = [];
  const man = Math.floor(amount / 10_000);
  const remainder = amount % 10_000;
  if (man > 0) {
    parts.push(...readGroup(man), "まん");
  }
  if (remainder > 0) parts.push(...readGroup(remainder));
  parts.push("えん");
  return parts;
}

export function formatJapaneseYenSpeech(amount: number): string {
  return readJapaneseYen(amount).join(" ");
}
