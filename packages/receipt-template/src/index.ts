import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { Align, CutMode, ReceiptDocument, ReceiptNode } from "@event-pos/receipt-ir";

export type ReceiptSnapshotLine = {
  productCode: string;
  name: string;
  quantity: number;
  unitPriceYen: number;
  unitPriceFormatted: string;
  grossYen: number;
  grossFormatted: string;
  discountAllocatedYen: number;
  discountFormatted: string;
  taxYen: number;
  taxFormatted: string;
  netYen: number;
  netFormatted: string;
  taxRateBps: number;
};

export type ReceiptSnapshot = {
  schemaVersion: 1;
  eventName: string;
  circleName: string;
  transactionId: string;
  publicReference: string;
  transactionType: "sale" | "void" | "return";
  originalPublicReference: string;
  confirmedAt: string;
  confirmedAtPrinted: string;
  businessDate: string;
  registerNo: string;
  staffPrintLabel: string;
  lines: ReceiptSnapshotLine[];
  discounts: Array<{ label: string; amountYen: number; amountFormatted: string }>;
  taxSummaries: Array<{ taxRateBps: number; taxableNetYen: number; taxableNetFormatted: string; taxYen: number; taxFormatted: string }>;
  payments: Array<{ methodName: string; amountYen: number; amountFormatted: string; tenderedYen: number | null; tenderedFormatted: string; changeYen: number | null; changeFormatted: string }>;
  subtotalYen: number;
  subtotalFormatted: string;
  discountTotalYen: number;
  discountTotalFormatted: string;
  taxTotalYen: number;
  taxTotalFormatted: string;
  totalYen: number;
  totalFormatted: string;
  tenderedYen: number | null;
  tenderedFormatted: string;
  changeYen: number | null;
  changeFormatted: string;
  isReprint: boolean;
  reprintLabel: string;
  reprintNo: number;
  originalReceiptNumber: string;
  footer: string;
  returnPolicy: string;
  hasOriginalTransaction: boolean;
  hasDiscounts: boolean;
  hasTendered: boolean;
  hasChange: boolean;
};

export type ReceiptAssetDescriptor = { assetId: string; version: number; sha256: string; mime: "application/x-event-pos-mono-raster"; widthDots: number; heightDots: number; rasterBase64: string };
export type TemplateValidation = { schemaVersion: 1; sourceSha256: string; warnings: string[]; referencedAssetIds: string[]; finishCount: number };
export type CompiledReceipt = { document: ReceiptDocument; warnings: string[]; humanReadable: string };

export class ReceiptTemplateError extends Error {
  constructor(message: string, public readonly path = "template") { super(`${path}: ${message}`); }
}

const GLOBAL_VARIABLES = new Set([
  "eventName", "circleName", "transactionId", "publicReference", "transactionType", "originalPublicReference", "confirmedAt", "confirmedAtPrinted", "businessDate", "registerNo", "staffPrintLabel",
  "subtotalFormatted", "discountTotalFormatted", "taxTotalFormatted", "totalFormatted", "tenderedFormatted", "changeFormatted", "isReprint", "reprintLabel", "reprintNo",
  "originalReceiptNumber", "footer", "returnPolicy", "hasOriginalTransaction", "hasDiscounts", "hasTendered", "hasChange",
]);
const COLLECTION_VARIABLES: Record<string, Set<string>> = {
  lines: new Set(["productCode", "name", "quantity", "unitPriceFormatted", "grossFormatted", "discountFormatted", "taxFormatted", "netFormatted", "taxRateBps"]),
  discounts: new Set(["label", "amountFormatted"]),
  taxSummaries: new Set(["taxRateBps", "taxableNetFormatted", "taxFormatted"]),
  payments: new Set(["methodName", "amountFormatted", "tenderedFormatted", "changeFormatted"]),
};
const CONDITIONS = new Set(["isReprint", "hasOriginalTransaction", "hasDiscounts", "hasTendered", "hasChange"]);
const NODE_NAMES = new Set(["reset", "text", "row", "align", "emphasis", "size", "rule", "feed", "image", "qr", "finish", "each", "if"]);
const VARIABLE_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReceiptTemplateError("objectが必要です", path);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ReceiptTemplateError(`未知fieldです: ${unknown.join(", ")}`, path);
}

function integer(value: unknown, min: number, max: number, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new ReceiptTemplateError(`${min}〜${max}の整数が必要です`, path);
  return Number(value);
}

function string(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new ReceiptTemplateError("文字列が必要です", path);
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function variables(value: string): string[] { return [...value.matchAll(VARIABLE_RE)].map((match) => match[1]!); }

function validateInterpolated(value: unknown, path: string, localVariables: Set<string>): string {
  const source = string(value, path);
  for (const variable of variables(source)) if (!GLOBAL_VARIABLES.has(variable) && !localVariables.has(variable)) throw new ReceiptTemplateError(`未知変数です: ${variable}`, path);
  const residue = source.replace(VARIABLE_RE, "");
  if (residue.includes("{{") || residue.includes("}}")) throw new ReceiptTemplateError("変数構文が不正です", path);
  return source;
}

function parseSource(sourceText: string): { root: Record<string, unknown>; body: unknown[] } {
  let value: unknown;
  try { value = parse(sourceText, { maxAliasCount: 0, prettyErrors: true, uniqueKeys: true }); } catch (error) { throw new ReceiptTemplateError(error instanceof Error ? error.message : "YAMLが不正です"); }
  const root = record(value, "template");
  onlyKeys(root, ["schemaVersion", "body"], "template");
  if (root.schemaVersion !== 1) throw new ReceiptTemplateError("schemaVersion: 1が必要です", "schemaVersion");
  if (!Array.isArray(root.body) || root.body.length === 0 || root.body.length > 500) throw new ReceiptTemplateError("1〜500件のbodyが必要です", "body");
  return { root, body: root.body };
}

type ValidationState = { finishCount: number; referencedAssets: Set<string>; assetIds: Set<string> };

function validateNodes(nodes: unknown[], path: string, localVariables: Set<string>, state: ValidationState): void {
  nodes.forEach((raw, index) => {
    const nodePath = `${path}[${index}]`;
    const node = record(raw, nodePath);
    const primary = Object.keys(node).filter((key) => key !== "body");
    if (primary.length !== 1 || !NODE_NAMES.has(primary[0]!)) throw new ReceiptTemplateError(`許可nodeを1個指定してください: ${primary.join(", ")}`, nodePath);
    const name = primary[0]!;
    if (name !== "each" && name !== "if" && "body" in node) throw new ReceiptTemplateError("bodyはeach/ifだけで使用できます", nodePath);
    switch (name) {
      case "reset": if (node.reset !== true) throw new ReceiptTemplateError("trueが必要です", `${nodePath}.reset`); break;
      case "text": validateInterpolated(node.text, `${nodePath}.text`, localVariables); break;
      case "row": {
        const row = record(node.row, `${nodePath}.row`); onlyKeys(row, ["left", "right"], `${nodePath}.row`);
        const left = validateInterpolated(row.left, `${nodePath}.row.left`, localVariables); const right = validateInterpolated(row.right, `${nodePath}.row.right`, localVariables);
        if (!variables(left).length && !variables(right).length && displayColumns(left) + displayColumns(right) + 1 > 32) throw new ReceiptTemplateError("384 dotsの2列幅を超えています", `${nodePath}.row`);
        break;
      }
      case "align": if (!["left", "center", "right"].includes(String(node.align))) throw new ReceiptTemplateError("left/center/rightが必要です", `${nodePath}.align`); break;
      case "emphasis": {
        const emphasis = record(node.emphasis, `${nodePath}.emphasis`); onlyKeys(emphasis, ["bold", "underline", "invert"], `${nodePath}.emphasis`);
        for (const key of ["bold", "underline", "invert"]) if (typeof emphasis[key] !== "boolean") throw new ReceiptTemplateError("booleanが必要です", `${nodePath}.emphasis.${key}`);
        break;
      }
      case "size": { const size = record(node.size, `${nodePath}.size`); onlyKeys(size, ["width", "height"], `${nodePath}.size`); integer(size.width, 1, 2, `${nodePath}.size.width`); integer(size.height, 1, 2, `${nodePath}.size.height`); break; }
      case "rule": if (node.rule !== "single" && node.rule !== "double") throw new ReceiptTemplateError("single/doubleが必要です", `${nodePath}.rule`); break;
      case "feed": integer(node.feed, 0, 8, `${nodePath}.feed`); break;
      case "image": {
        const image = record(node.image, `${nodePath}.image`); onlyKeys(image, ["assetId", "widthDots"], `${nodePath}.image`);
        const assetId = string(image.assetId, `${nodePath}.image.assetId`, false); integer(image.widthDots, 1, 384, `${nodePath}.image.widthDots`);
        if (!state.assetIds.has(assetId)) throw new ReceiptTemplateError(`assetが存在しません: ${assetId}`, `${nodePath}.image.assetId`); state.referencedAssets.add(assetId); break;
      }
      case "qr": {
        const qr = record(node.qr, `${nodePath}.qr`); onlyKeys(qr, ["data", "moduleSize", "errorCorrection"], `${nodePath}.qr`);
        const data = validateInterpolated(qr.data, `${nodePath}.qr.data`, localVariables); integer(qr.moduleSize, 1, 8, `${nodePath}.qr.moduleSize`);
        if (!["L", "M", "Q", "H"].includes(String(qr.errorCorrection))) throw new ReceiptTemplateError("L/M/Q/Hが必要です", `${nodePath}.qr.errorCorrection`);
        if (!variables(data).length && new TextEncoder().encode(data).length > 7089) throw new ReceiptTemplateError("QR容量を超えています", `${nodePath}.qr.data`); break;
      }
      case "finish": {
        const finish = record(node.finish, `${nodePath}.finish`); onlyKeys(finish, ["feedLines", "cutMode"], `${nodePath}.finish`);
        integer(finish.feedLines, 0, 8, `${nodePath}.finish.feedLines`); if (!["none", "partial", "partial3"].includes(String(finish.cutMode))) throw new ReceiptTemplateError("none/partial/partial3が必要です", `${nodePath}.finish.cutMode`);
        state.finishCount += 1; break;
      }
      case "each": {
        const collection = string(node.each, `${nodePath}.each`, false); const scoped = COLLECTION_VARIABLES[collection];
        if (!scoped) throw new ReceiptTemplateError(`反復できない変数です: ${collection}`, `${nodePath}.each`);
        if (!Array.isArray(node.body) || !node.body.length) throw new ReceiptTemplateError("bodyが必要です", `${nodePath}.body`); validateNodes(node.body, `${nodePath}.body`, scoped, state); break;
      }
      case "if": {
        const condition = string(node.if, `${nodePath}.if`, false); if (!CONDITIONS.has(condition)) throw new ReceiptTemplateError(`条件変数が不正です: ${condition}`, `${nodePath}.if`);
        if (!Array.isArray(node.body) || !node.body.length) throw new ReceiptTemplateError("bodyが必要です", `${nodePath}.body`); validateNodes(node.body, `${nodePath}.body`, localVariables, state); break;
      }
    }
  });
}

export function sha256Hex(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export function validateReceiptTemplate(sourceText: string, assets: readonly ReceiptAssetDescriptor[] = [], production = true): TemplateValidation {
  const { body } = parseSource(sourceText);
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (!asset.assetId || assetIds.has(asset.assetId)) throw new ReceiptTemplateError(`asset IDが不正または重複しています: ${asset.assetId}`, "assets");
    if (asset.widthDots < 1 || asset.widthDots > 416 || asset.heightDots < 1 || asset.heightDots > 4096 || sha256Hex(Uint8Array.from(Buffer.from(asset.rasterBase64, "base64"))) !== asset.sha256) throw new ReceiptTemplateError(`assetが不正です: ${asset.assetId}`, "assets");
    assetIds.add(asset.assetId);
  }
  const state: ValidationState = { finishCount: 0, referencedAssets: new Set(), assetIds };
  validateNodes(body, "body", new Set(), state);
  if (production && state.finishCount !== 1) throw new ReceiptTemplateError(`production templateのfinishは1個必要です（現在${state.finishCount}個）`, "body");
  return { schemaVersion: 1, sourceSha256: sha256Hex(sourceText), warnings: [], referencedAssetIds: [...state.referencedAssets].sort(), finishCount: state.finishCount };
}

function resolveValue(name: string, global: Record<string, unknown>, local: Record<string, unknown>): unknown {
  return Object.hasOwn(local, name) ? local[name] : global[name];
}

function interpolate(value: string, global: Record<string, unknown>, local: Record<string, unknown>): string {
  return value.replace(VARIABLE_RE, (_match, name: string) => String(resolveValue(name, global, local) ?? ""));
}

function collection(snapshot: ReceiptSnapshot, name: string): Record<string, unknown>[] {
  return (snapshot[name as keyof ReceiptSnapshot] as unknown[]).map((value) => record(value, name));
}

function compileNodes(rawNodes: unknown[], snapshot: ReceiptSnapshot, global: Record<string, unknown>, local: Record<string, unknown>, output: ReceiptNode[]): void {
  for (const raw of rawNodes) {
    const node = raw as Record<string, unknown>;
    const name = Object.keys(node).find((key) => key !== "body")!;
    switch (name) {
      case "reset": output.push({ kind: "reset" }); break;
      case "text": output.push({ kind: "text", value: interpolate(String(node.text), global, local) }); break;
      case "row": {
        const row = node.row as Record<string, unknown>; const left = interpolate(String(row.left), global, local); const right = interpolate(String(row.right), global, local);
        if (displayColumns(left) + displayColumns(right) + 1 > 32) throw new ReceiptTemplateError("実データが384 dotsの2列幅を超えています", "row");
        output.push({ kind: "row", left, right }); break;
      }
      case "align": output.push({ kind: "align", value: node.align as Align }); break;
      case "emphasis": { const value = node.emphasis as Record<string, boolean>; output.push({ kind: "emphasis", bold: value.bold!, underline: value.underline!, invert: value.invert! }); break; }
      case "size": { const value = node.size as Record<string, 1 | 2>; output.push({ kind: "size", width: value.width!, height: value.height! }); break; }
      case "rule": output.push({ kind: "rule", style: node.rule as "single" | "double" }); break;
      case "feed": output.push({ kind: "feed", lines: Number(node.feed) }); break;
      case "image": { const value = node.image as Record<string, unknown>; output.push({ kind: "image", assetId: String(value.assetId), widthDots: Number(value.widthDots) }); break; }
      case "qr": {
        const value = node.qr as Record<string, unknown>; const data = interpolate(String(value.data), global, local);
        if (new TextEncoder().encode(data).length > 7089) throw new ReceiptTemplateError("実データがQR容量を超えています", "qr.data");
        output.push({ kind: "qr", data, moduleSize: Number(value.moduleSize), errorCorrection: value.errorCorrection as "L" | "M" | "Q" | "H" }); break;
      }
      case "finish": { const value = node.finish as Record<string, unknown>; output.push({ kind: "feed", lines: Number(value.feedLines) }, { kind: "cut", mode: value.cutMode as CutMode }); break; }
      case "each": for (const item of collection(snapshot, String(node.each))) compileNodes(node.body as unknown[], snapshot, global, item, output); break;
      case "if": if (Boolean(global[String(node.if)])) compileNodes(node.body as unknown[], snapshot, global, local, output); break;
    }
  }
}

export function compileReceiptTemplate(sourceText: string, snapshot: ReceiptSnapshot, assets: readonly ReceiptAssetDescriptor[] = []): CompiledReceipt {
  validateReceiptTemplate(sourceText, assets, true);
  const { body } = parseSource(sourceText);
  const global = snapshot as unknown as Record<string, unknown>;
  const nodes: ReceiptNode[] = [];
  compileNodes(body, snapshot, global, {}, nodes);
  const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes };
  return { document, warnings: [], humanReadable: receiptDocumentToText(document) };
}

export function displayColumns(value: string): number {
  let width = 0;
  for (const char of value.normalize("NFC")) {
    const cp = char.codePointAt(0)!;
    if (char === "\n") continue;
    if ((cp >= 0xff61 && cp <= 0xff9f) || cp <= 0x7f) width += 1;
    else width += 2;
  }
  return width;
}

export function receiptDocumentToText(document: ReceiptDocument): string {
  const result: string[] = [];
  for (const node of document.nodes) {
    if (node.kind === "text") result.push(node.value);
    else if (node.kind === "row") result.push(`${node.left}${" ".repeat(Math.max(1, 32 - displayColumns(node.left) - displayColumns(node.right)))}${node.right}`);
    else if (node.kind === "rule") result.push((node.style === "double" ? "=" : "-").repeat(32));
    else if (node.kind === "feed") for (let index = 0; index < node.lines; index += 1) result.push("");
    else if (node.kind === "image") result.push(`[画像: ${node.assetId}]`);
    else if (node.kind === "qr") result.push(`[QR: ${node.data}]`);
    else if (node.kind === "cut" && node.mode !== "none") result.push(`[部分カット: ${node.mode}]`);
  }
  return result.join("\n");
}

export const DEFAULT_RECEIPT_TEMPLATE = `schemaVersion: 1
body:
  - reset: true
  - align: center
  - emphasis: { bold: true, underline: false, invert: false }
  - text: "{{eventName}}"
  - text: "{{circleName}}"
  - emphasis: { bold: false, underline: false, invert: false }
  - align: left
  - if: isReprint
    body:
      - emphasis: { bold: true, underline: false, invert: true }
      - text: "{{reprintLabel}} #{{reprintNo}}"
      - text: "元受付番号 {{originalReceiptNumber}}"
      - emphasis: { bold: false, underline: false, invert: false }
  - row: { left: "受付番号", right: "{{publicReference}}" }
  - row: { left: "確定日時", right: "{{confirmedAtPrinted}}" }
  - row: { left: "レジ/担当", right: "{{registerNo}}/{{staffPrintLabel}}" }
  - rule: single
  - each: lines
    body:
      - row: { left: "{{name}} x{{quantity}}", right: "{{netFormatted}}" }
  - rule: single
  - row: { left: "値引", right: "{{discountTotalFormatted}}" }
  - row: { left: "税", right: "{{taxTotalFormatted}}" }
  - emphasis: { bold: true, underline: false, invert: false }
  - row: { left: "合計", right: "{{totalFormatted}}" }
  - emphasis: { bold: false, underline: false, invert: false }
  - each: payments
    body:
      - row: { left: "{{methodName}}", right: "{{amountFormatted}}" }
  - if: hasTendered
    body:
      - row: { left: "預り", right: "{{tenderedFormatted}}" }
  - if: hasChange
    body:
      - row: { left: "釣銭", right: "{{changeFormatted}}" }
  - text: "{{footer}}"
  - text: "{{returnPolicy}}"
  - finish: { feedLines: 3, cutMode: partial }
`;
