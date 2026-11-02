export type TemplateNode =
  | { kind: "reset" }
  | { kind: "text"; text: string }
  | { kind: "row"; left: string; right: string }
  | { kind: "align"; value: "left" | "center" | "right" }
  | { kind: "emphasis"; bold: boolean; underline: boolean; invert: boolean }
  | { kind: "size"; width: number; height: number }
  | { kind: "rule"; style: "single" | "double" }
  | { kind: "feed"; lines: number }
  | { kind: "image"; assetId: string; widthDots: number }
  | { kind: "qr"; data: string; moduleSize: number; errorCorrection: "L" | "M" | "Q" | "H" }
  | { kind: "barcode"; value: string; format: "code128" | "itf"; width: number; height: number; hri: "none" | "above" | "below" | "both" }
  | { kind: "finish"; feedLines: number; cutMode: "none" | "partial" | "partial3" }
  | { kind: "each"; collection: "lines" | "discounts" | "taxSummaries" | "payments"; body: TemplateNode[] }
  | { kind: "if"; condition: string; body: TemplateNode[] };

export const GLOBAL_VARIABLE_LABELS: Array<[string, string]> = [
  ["eventName", "イベント名"], ["circleName", "サークル名"], ["publicReference", "受付番号"], ["publicReferenceRaw", "受付番号（ハイフンなし）"], ["confirmedAtPrinted", "確定日時"], ["businessDate", "営業日"], ["businessDateYYMMDD", "営業日（YYMMDD）"], ["registerNo", "レジ番号"], ["staffPrintLabel", "担当者"], ["subtotalFormatted", "小計"], ["discountTotalFormatted", "値引合計"], ["taxTotalFormatted", "税合計"], ["totalFormatted", "合計"], ["tenderedFormatted", "預り金"], ["changeFormatted", "釣銭"], ["footer", "フッター文"], ["returnPolicy", "返品ポリシー"], ["reprintLabel", "再印刷ラベル"], ["reprintNo", "再印刷番号"], ["originalReceiptNumber", "元受付番号"], ["transactionType", "取引種別"], ["originalPublicReference", "元の受付番号"], ["confirmedAt", "確定日時（ISO）"], ["transactionId", "取引ID"],
];
export const COLLECTION_VARIABLE_LABELS: Record<"lines" | "discounts" | "taxSummaries" | "payments", Array<[string, string]>> = {
  lines: [["name", "商品名"], ["productCode", "商品コード"], ["quantity", "数量"], ["unitPriceFormatted", "単価"], ["grossFormatted", "金額"], ["discountFormatted", "値引"], ["taxFormatted", "税"], ["netFormatted", "明細金額"], ["taxRateBps", "税率（bps）"]],
  discounts: [["label", "値引名"], ["amountFormatted", "値引額"]],
  taxSummaries: [["taxRateBps", "税率（bps）"], ["taxableNetFormatted", "対象額"], ["taxFormatted", "税額"]],
  payments: [["methodName", "支払方法"], ["amountFormatted", "支払額"], ["tenderedFormatted", "預り金"], ["changeFormatted", "釣銭"]],
};
export const CONDITION_LABELS: Array<[string, string]> = [["isReprint", "再印刷のとき"], ["hasOriginalTransaction", "元伝票があるとき"], ["hasDiscounts", "値引があるとき"], ["hasTendered", "預り金があるとき"], ["hasChange", "釣銭があるとき"], ["quantityOne", "数量が1のとき（明細の中だけ）"], ["quantityMoreThanOne", "数量が2以上のとき（明細の中だけ）"]];
export const COLLECTION_LABELS: Record<"lines" | "discounts" | "taxSummaries" | "payments", string> = { lines: "商品明細", discounts: "値引", taxSummaries: "税区分", payments: "支払い" };
export const NODE_LABELS: Record<TemplateNode["kind"], string> = { reset: "初期化", text: "文字", row: "左右2列", align: "行ぞろえ", emphasis: "強調", size: "文字サイズ", rule: "罫線", feed: "空行", image: "画像", qr: "QRコード", barcode: "バーコード", finish: "仕上げ（カット）", each: "繰り返し", if: "条件つき" };

const collections = ["lines", "discounts", "taxSummaries", "payments"] as const;
const quoted = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try { const parsed = JSON.parse(trimmed); return typeof parsed === "string" ? parsed : null; } catch { return null; }
};
const numberValue = (value: string): number | null => /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
const inline = (value: string): Record<string, string> | null => {
  const body = value.trim().match(/^\{(.*)\}$/)?.[1];
  if (body === undefined) return null;
  const result: Record<string, string> = {};
  let position = 0;
  const pattern = /\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*("(?:\\.|[^"\\])*"|[^,}]+)\s*(?:,|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) { if (match.index !== position) return null; const parsed = quoted(match[2]!); if (parsed === null) return null; result[match[1]!] = parsed; position = pattern.lastIndex; }
  return position === body.length ? result : null;
};

export function parseReceiptTemplateNodes(sourceText: string): TemplateNode[] | null {
  const lines = sourceText.split("\n").map((line) => line.trimEnd());
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2 || lines[0] !== "schemaVersion: 1" || lines[1] !== "body:") return null;
  const parseList = (start: number, indent: number): { nodes: TemplateNode[]; index: number } | null => {
    const nodes: TemplateNode[] = []; let index = start;
    while (index < lines.length) {
      const line = lines[index]!; if (line.trim() === "") return null;
      const prefix = " ".repeat(indent) + "- "; if (!line.startsWith(prefix)) break;
      const head = line.slice(prefix.length).replace(/^([a-z]+):(?=\S)/, "$1: "); let node: TemplateNode | null = null;
      if (head === "reset: true") node = { kind: "reset" };
      else if (head.startsWith("text: ")) { const value = quoted(head.slice(6)); if (value !== null) node = { kind: "text", text: value }; }
      else if (head.startsWith("row: ")) { const v = inline(head.slice(5)); if (v?.left !== undefined && v.right !== undefined) node = { kind: "row", left: v.left, right: v.right }; }
      else if (/^align: (left|center|right)$/.test(head)) node = { kind: "align", value: head.slice(7) as "left" | "center" | "right" };
      else if (head.startsWith("emphasis: ")) { const v = inline(head.slice(10)); if (v && ["bold", "underline", "invert"].every((key) => v[key] === "true" || v[key] === "false")) node = { kind: "emphasis", bold: v.bold === "true", underline: v.underline === "true", invert: v.invert === "true" }; }
      else if (head.startsWith("size: ")) { const v = inline(head.slice(6)); const width = v?.width === undefined ? null : numberValue(v.width); const height = v?.height === undefined ? null : numberValue(v.height); if (width !== null && height !== null) node = { kind: "size", width, height }; }
      else if (/^rule: (single|double)$/.test(head)) node = { kind: "rule", style: head.slice(6) as "single" | "double" };
      else if (head.startsWith("feed: ")) { const linesValue = numberValue(head.slice(6)); if (linesValue !== null) node = { kind: "feed", lines: linesValue }; }
      else if (head.startsWith("image: ")) { const v = inline(head.slice(7)); const widthDots = v?.widthDots === undefined ? null : numberValue(v.widthDots); if (v?.assetId !== undefined && widthDots !== null) node = { kind: "image", assetId: v.assetId, widthDots }; }
      else if (head.startsWith("qr: ")) { const v = inline(head.slice(4)); const moduleSize = v?.moduleSize === undefined ? null : numberValue(v.moduleSize); if (v?.data !== undefined && moduleSize !== null && ["L", "M", "Q", "H"].includes(v.errorCorrection ?? "")) node = { kind: "qr", data: v.data, moduleSize, errorCorrection: v.errorCorrection as "L" | "M" | "Q" | "H" }; }
      else if (head.startsWith("barcode: ")) { const v = inline(head.slice(9)); const width = v?.width === undefined ? null : numberValue(v.width); const height = v?.height === undefined ? null : numberValue(v.height); const format = v?.format === undefined ? "code128" : v.format; if (v?.value !== undefined && width !== null && width >= 2 && width <= 6 && height !== null && height >= 1 && height <= 255 && ["none", "above", "below", "both"].includes(v.hri ?? "") && ["code128", "itf"].includes(format)) node = { kind: "barcode", value: v.value, format: format as "code128" | "itf", width, height, hri: v.hri as "none" | "above" | "below" | "both" }; }
      else if (head.startsWith("finish: ")) { const v = inline(head.slice(8)); const feedLines = v?.feedLines === undefined ? null : numberValue(v.feedLines); if (v && feedLines !== null && ["none", "partial", "partial3"].includes(v.cutMode ?? "")) node = { kind: "finish", feedLines, cutMode: v.cutMode as "none" | "partial" | "partial3" }; }
      else if (head.startsWith("each: ") && collections.includes(head.slice(6) as typeof collections[number])) node = { kind: "each", collection: head.slice(6) as typeof collections[number], body: [] };
      else if (head.startsWith("if: ") && CONDITION_LABELS.some(([key]) => key === head.slice(4))) node = { kind: "if", condition: head.slice(4), body: [] };
      if (!node) return null;
      index += 1;
      if (node.kind === "each" || node.kind === "if") { if (lines[index] !== `${" ".repeat(indent + 2)}body:`) return null; const child = parseList(index + 1, indent + 4); if (!child) return null; node.body = child.nodes; index = child.index; }
      nodes.push(node);
    }
    return { nodes, index };
  };
  const result = parseList(2, 2); return result && result.index === lines.length ? result.nodes : null;
}

export function serializeReceiptTemplateNodes(nodes: TemplateNode[]): string {
  const lines = ["schemaVersion: 1", "body:"]; const q = (value: string) => JSON.stringify(value);
  const write = (items: TemplateNode[], indent: number) => { for (const node of items) { const pad = " ".repeat(indent); switch (node.kind) { case "reset": lines.push(`${pad}- reset: true`); break; case "text": lines.push(`${pad}- text: ${q(node.text)}`); break; case "row": lines.push(`${pad}- row: { left: ${q(node.left)}, right: ${q(node.right)} }`); break; case "align": lines.push(`${pad}- align: ${node.value}`); break; case "emphasis": lines.push(`${pad}- emphasis: { bold: ${node.bold}, underline: ${node.underline}, invert: ${node.invert} }`); break; case "size": lines.push(`${pad}- size: { width: ${node.width}, height: ${node.height} }`); break; case "rule": lines.push(`${pad}- rule: ${node.style}`); break; case "feed": lines.push(`${pad}- feed: ${node.lines}`); break; case "image": lines.push(`${pad}- image: { assetId: ${q(node.assetId)}, widthDots: ${node.widthDots} }`); break; case "qr": lines.push(`${pad}- qr: { data: ${q(node.data)}, moduleSize: ${node.moduleSize}, errorCorrection: ${node.errorCorrection} }`); break; case "barcode": lines.push(`${pad}- barcode: { value: ${q(node.value)}, format: ${node.format}, width: ${node.width}, height: ${node.height}, hri: ${node.hri} }`); break; case "finish": lines.push(`${pad}- finish: { feedLines: ${node.feedLines}, cutMode: ${node.cutMode} }`); break; case "each": lines.push(`${pad}- each: ${node.collection}`, `${" ".repeat(indent + 2)}body:`); write(node.body, indent + 4); break; case "if": lines.push(`${pad}- if: ${node.condition}`, `${" ".repeat(indent + 2)}body:`); write(node.body, indent + 4); break; } } };
  write(nodes, 2); return `${lines.join("\n")}\n`;
}
