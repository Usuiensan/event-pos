export type BarcodeKind = "gtin" | "book-isbn" | "book-price" | "periodical" | "payment-slip" | "unknown";

export type BookPriceInfo = { cCode: string; salesTarget: string; publicationForm: string; subject: string; priceExclTaxYen: number };
export type PaymentSlipCode = { rawCode: string; issuerCode: string; gs1CompanyPrefix7: string; freeField: string; reissueCount: number; dueDate: { kind: "date"; raw: string; isoDate: string } | { kind: "not-specified"; raw: "999999" }; stampFlag: "not-required" | "required-200-yen" | "reserved"; amount: number; amountRaw: string; checkDigit: number; checkDigitValid: true };
export type PeriodicalInfo = { coreCode: string; magazineCode: string; year: number; issueCode: string; publicationType: "monthly" | "weekly" | "direct" | "other"; issueLabel: string; priceExclTaxYen: number | null };
export type BarcodeParseResult = { kind: BarcodeKind; normalized: string; gtin?: string; bookPrice?: BookPriceInfo; periodical?: PeriodicalInfo; paymentSlip?: PaymentSlipCode; error?: string };

const SALES_TARGET: Record<string, string> = { "0": "一般", "1": "教養", "2": "実用", "3": "専門", "5": "婦人", "6": "学参I（小中）", "7": "学参II（高校）", "8": "児童", "9": "雑誌扱い" };
const PUBLICATION_FORM: Record<string, string> = { "0": "単行本", "1": "文庫", "2": "新書", "3": "全集・双書", "4": "ムック・その他", "5": "事・辞典", "6": "図鑑", "7": "絵本", "8": "磁性媒体など", "9": "コミック" };
const SUBJECT: Record<string, string> = { "00": "総記", "01": "百科事典", "02": "年鑑・雑誌", "04": "情報科学", "10": "哲学", "11": "心理（学）", "12": "倫理（学）", "14": "宗教", "15": "仏教", "16": "キリスト教", "20": "歴史総記", "21": "日本歴史", "22": "外国歴史", "23": "伝記", "25": "地理", "26": "旅行", "30": "社会科学総記", "31": "政治・国防軍事", "32": "法律", "33": "経済・財政・統計", "34": "経営", "36": "社会", "37": "教育", "39": "民族・風習", "40": "自然科学総記", "41": "数学", "42": "物理学", "43": "化学", "44": "天文・地学", "45": "生物学", "47": "医学・歯学・薬学", "50": "工学・工学総記", "51": "土木", "52": "建築", "53": "機械", "54": "電気", "55": "電子通信", "56": "海事", "57": "採鉱・冶金", "58": "その他の工業", "60": "産業総記", "61": "農林業", "62": "水産業", "63": "商業", "65": "交通・通信", "70": "芸術総記", "71": "絵画・彫刻", "72": "写真・工芸", "73": "音楽・舞踊", "74": "演劇・映画", "75": "体育・スポーツ", "76": "諸芸・娯楽", "77": "家事", "79": "コミックス・劇画", "80": "語学総記", "81": "日本語", "82": "英米語", "84": "ドイツ語", "85": "フランス語", "87": "各国語", "90": "文学総記", "91": "日本文学総記", "92": "日本文学詩歌", "93": "日本文学・小説・物語", "95": "日本文学・評論・随筆ほか", "97": "外国文学小説", "98": "外国文学ほか" };

export function calculateMod10CheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error("チェックデジット計算対象は数字である必要があります");
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) sum += Number(digits[i]) * ((digits.length - i) % 2 === 1 ? 3 : 1);
  return (10 - sum % 10) % 10;
}
export function validGtin(code: string): boolean { return /^\d{8}$|^\d{12,14}$/.test(code) && calculateMod10CheckDigit(code.slice(0, -1)) === Number(code.at(-1)); }
export function normalizeBarcodeInput(input: string): string { return input.replace(/[\r\n\t]+$/, "").trim().replace(/^]C1/, "").replace(/[()\-\s]/g, ""); }

function parseDueDate(raw: string): PaymentSlipCode["dueDate"] | null {
  if (raw === "999999") return { kind: "not-specified", raw };
  const year = 2000 + Number(raw.slice(0, 2)); const month = Number(raw.slice(2, 4)); const day = Number(raw.slice(4));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { kind: "date", raw, isoDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` } : null;
}
export function parsePaymentSlipCode(input: string): { ok: true; value: PaymentSlipCode } | { ok: false; error: string } {
  const code = normalizeBarcodeInput(input);
  if (!code) return { ok: false, error: "バーコードが入力されていません" };
  if (!/^\d+$/.test(code)) return { ok: false, error: "読み取ったデータに数字以外が含まれています" };
  if (code.length !== 44) return { ok: false, error: "代理収納バーコードの桁数と一致しません" };
  if (!code.startsWith("91")) return { ok: false, error: "対応する代理収納バーコードではありません" };
  if (calculateMod10CheckDigit(code.slice(0, 43)) !== Number(code[43])) return { ok: false, error: "バーコードを正しく読み取れませんでした。もう一度読み取ってください" };
  const dueDate = parseDueDate(code.slice(30, 36)); if (!dueDate) return { ok: false, error: "支払期限を正しく解析できませんでした" };
  const stampRaw = code[36]!;
  return { ok: true, value: { rawCode: code, issuerCode: code.slice(2, 8), gs1CompanyPrefix7: `4${code.slice(2, 8)}`, freeField: code.slice(8, 29), reissueCount: Number(code[29]), dueDate, stampFlag: stampRaw === "0" ? "not-required" : stampRaw === "1" ? "required-200-yen" : "reserved", amount: Number(code.slice(37, 43)), amountRaw: code.slice(37, 43), checkDigit: Number(code[43]), checkDigitValid: true } };
}
export function parseBarcode(input: string): BarcodeParseResult {
  const code = normalizeBarcodeInput(input);
  const payment = parsePaymentSlipCode(code); if (payment.ok) return { kind: "payment-slip", normalized: code, paymentSlip: payment.value }; const paymentError = (payment as { ok: false; error: string }).error;
  // 書籍の二段バーコードは、下段にも上段にも必ずチェックデジットがあるが、
  // 読み取り後はマスタ照合を優先して上下段を案内する（手入力時も同じ導線）。
  if (/^192\d{10}$/.test(code)) { const cCode = code.slice(3, 7); return { kind: "book-price", normalized: code, bookPrice: { cCode, salesTarget: SALES_TARGET[cCode[0]!] ?? "不明", publicationForm: PUBLICATION_FORM[cCode[1]!] ?? "不明", subject: SUBJECT[cCode.slice(2)] ?? "不明", priceExclTaxYen: Number(code.slice(7, 12)) } }; }
  if (/^97[89]\d{10}$/.test(code)) return { kind: "book-isbn", normalized: code, gtin: code };
  if (/^491\d{10}\d{5}$/.test(code) && validGtin(code.slice(0, 13))) {
    const magazineCode = code.slice(4, 9); const issueCode = code.slice(9, 11); const year = 2000 + Number(code[3]) * 10 + Number(code[11]); const z1 = magazineCode[0]!;
    const publicationType = z1 === "0" || z1 === "1" || ["80", "81", "86", "87", "89"].includes(magazineCode.slice(0, 2)) ? "monthly" : z1 === "2" || z1 === "3" || ["82", "83", "84", "88"].includes(magazineCode.slice(0, 2)) ? "weekly" : z1 === "8" ? "direct" : "other";
    const issueLabel = publicationType === "monthly" ? `${year}年${Number(issueCode)}月号` : publicationType === "weekly" ? `${year}年${Number(issueCode)}号` : `${year}年 ${issueCode}号`;
    const priceRaw = code.slice(14); return { kind: "periodical", normalized: code, gtin: code, periodical: { coreCode: code.slice(0, 13), magazineCode, year, issueCode, publicationType, issueLabel, priceExclTaxYen: priceRaw === "0000" ? null : Number(priceRaw) } };
  }
  if (validGtin(code)) return { kind: "gtin", normalized: code, gtin: code };
  return { kind: "unknown", normalized: code, error: paymentError };
}
