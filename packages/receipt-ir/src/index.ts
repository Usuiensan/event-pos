export type Align = "left" | "center" | "right";
export type CutMode = "none" | "partial" | "partial3";

export type ReceiptNode =
  | { kind: "reset" }
  | { kind: "text"; value: string }
  | { kind: "align"; value: Align }
  | { kind: "emphasis"; bold: boolean; underline: boolean; invert: boolean }
  | { kind: "size"; width: 1 | 2; height: 1 | 2 }
  | { kind: "row"; left: string; right: string }
  | { kind: "rule"; style: "single" | "double" }
  | { kind: "feed"; lines: number }
  | { kind: "image"; assetId: string; widthDots: number }
  | { kind: "qr"; data: string; moduleSize: number; errorCorrection: "L" | "M" | "Q" | "H" }
  | { kind: "barcode"; value: string; width: number; height: number; hri: "none" | "above" | "below" | "both" }
  | { kind: "cut"; mode: CutMode };

export type ReceiptDocument = {
  schemaVersion: 1;
  contentWidthDots: 384;
  physicalWidthDots: 416;
  nodes: ReceiptNode[];
};

export class ReceiptIrError extends Error {
  constructor(message: string, public readonly line?: number) { super(line ? `${line}行目: ${message}` : message); }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function command(name: string, value?: unknown): string {
  return value === undefined ? `!${name}` : `!${name} ${JSON.stringify(value)}`;
}

export function canonicalizeReceiptDocument(document: ReceiptDocument): string {
  validateDocument(document);
  const lines = document.nodes.map((node): string => {
    switch (node.kind) {
      case "reset": return command("reset");
      case "text": return command("text", normalizeText(node.value));
      case "align": return command("align", node.value);
      case "emphasis": return command("emphasis", { bold: node.bold, invert: node.invert, underline: node.underline });
      case "size": return command("size", { height: node.height, width: node.width });
      case "row": return command("row", { left: normalizeText(node.left), right: normalizeText(node.right) });
      case "rule": return command("rule", node.style);
      case "feed": return command("feed", node.lines);
      case "image": return command("image", { assetId: node.assetId, widthDots: node.widthDots });
      case "qr": return command("qr", { data: normalizeText(node.data), errorCorrection: node.errorCorrection, moduleSize: node.moduleSize });
      case "barcode": return command("barcode", { height: node.height, hri: node.hri, value: node.value, width: node.width });
      case "cut": return command("cut", node.mode);
    }
  });
  return `${lines.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], line: number): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ReceiptIrError(`引数が不正です: ${actual.join(",")}`, line);
}

function parseJson(raw: string, line: number): unknown {
  try { return JSON.parse(raw); } catch { throw new ReceiptIrError("JSON引数が不正です", line); }
}

export function parseCanonicalReceiptIr(source: string): ReceiptDocument {
  if (source.includes("\r")) throw new ReceiptIrError("canonical IRにCRは使用できません");
  const physicalLines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  if (physicalLines.some((line) => !line)) throw new ReceiptIrError("空行は使用できません");
  const nodes: ReceiptNode[] = physicalLines.map((line, index): ReceiptNode => {
    const lineNo = index + 1;
    const match = /^!([a-z]+)(?: (.+))?$/.exec(line);
    if (!match) throw new ReceiptIrError("command形式が不正です", lineNo);
    const [, name, raw] = match;
    if (name === "reset") { if (raw !== undefined) throw new ReceiptIrError("resetに引数はありません", lineNo); return { kind: "reset" }; }
    if (raw === undefined) throw new ReceiptIrError(`${name}に引数が必要です`, lineNo);
    const value = parseJson(raw, lineNo);
    switch (name) {
      case "text": if (typeof value === "string") return { kind: "text", value: normalizeText(value) }; break;
      case "align": if (value === "left" || value === "center" || value === "right") return { kind: "align", value }; break;
      case "emphasis":
        if (isRecord(value)) { exactKeys(value, ["bold", "invert", "underline"], lineNo); if ([value.bold, value.invert, value.underline].every((item) => typeof item === "boolean")) return { kind: "emphasis", bold: value.bold as boolean, invert: value.invert as boolean, underline: value.underline as boolean }; }
        break;
      case "size":
        if (isRecord(value)) { exactKeys(value, ["height", "width"], lineNo); if ((value.width === 1 || value.width === 2) && (value.height === 1 || value.height === 2)) return { kind: "size", width: value.width, height: value.height }; }
        break;
      case "row":
        if (isRecord(value)) { exactKeys(value, ["left", "right"], lineNo); if (typeof value.left === "string" && typeof value.right === "string") return { kind: "row", left: normalizeText(value.left), right: normalizeText(value.right) }; }
        break;
      case "rule": if (value === "single" || value === "double") return { kind: "rule", style: value }; break;
      case "feed": if (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8) return { kind: "feed", lines: Number(value) }; break;
      case "image":
        if (isRecord(value)) { exactKeys(value, ["assetId", "widthDots"], lineNo); if (typeof value.assetId === "string" && value.assetId.length > 0 && Number.isSafeInteger(value.widthDots) && Number(value.widthDots) > 0 && Number(value.widthDots) <= 384) return { kind: "image", assetId: value.assetId, widthDots: Number(value.widthDots) }; }
        break;
      case "qr":
        if (isRecord(value)) { exactKeys(value, ["data", "errorCorrection", "moduleSize"], lineNo); if (typeof value.data === "string" && new TextEncoder().encode(value.data).length <= 7089 && Number.isSafeInteger(value.moduleSize) && Number(value.moduleSize) >= 1 && Number(value.moduleSize) <= 8 && ["L", "M", "Q", "H"].includes(String(value.errorCorrection))) return { kind: "qr", data: normalizeText(value.data), moduleSize: Number(value.moduleSize), errorCorrection: value.errorCorrection as "L" | "M" | "Q" | "H" }; }
        break;
      case "barcode":
        if (isRecord(value)) {
          exactKeys(value, ["height", "hri", "value", "width"], lineNo);
          if (typeof value.value === "string" && /^[\x20-\x7e]+$/.test(value.value) && value.value.length <= 255 && Number.isSafeInteger(value.width) && Number(value.width) >= 2 && Number(value.width) <= 6 && Number.isSafeInteger(value.height) && Number(value.height) >= 1 && Number(value.height) <= 255 && ["none", "above", "below", "both"].includes(String(value.hri))) return { kind: "barcode", value: value.value, width: Number(value.width), height: Number(value.height), hri: value.hri as "none" | "above" | "below" | "both" };
        }
        break;
      case "cut": if (value === "none" || value === "partial" || value === "partial3") return { kind: "cut", mode: value }; break;
      default: throw new ReceiptIrError(`未知commandです: ${name}`, lineNo);
    }
    throw new ReceiptIrError(`${name}の引数が不正です`, lineNo);
  });
  const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes };
  validateDocument(document);
  if (canonicalizeReceiptDocument(document) !== source) throw new ReceiptIrError("IRがcanonical形式ではありません");
  return document;
}

export function validateDocument(document: ReceiptDocument): void {
  if (document.schemaVersion !== 1 || document.contentWidthDots !== 384 || document.physicalWidthDots !== 416) throw new ReceiptIrError("ReceiptDocumentの固定値が不正です");
  if (!Array.isArray(document.nodes) || document.nodes.length === 0 || document.nodes.length > 500) throw new ReceiptIrError("node数が不正です");
  if (document.nodes.some((node) => !node || typeof node !== "object")) throw new ReceiptIrError("nodeが不正です");
}
