import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import { parseCanonicalReceiptIr, validateDocument, type ReceiptDocument } from "@event-pos/receipt-ir";

const ESC = 0x1b; const GS = 0x1d; const FS = 0x1c; const LF = 0x0a;
export const ESCPOS_RENDERER_VERSION = "event-pos-escpos-v1";
export const BUILTIN_FONT = { id: "tm-t70ii-cp932", version: 1, sha256: "builtin-tm-t70ii-cp932-v1" } as const;
export const DEFAULT_FINISHING_POLICY = { id: "receipt-partial-cut", version: 2 } as const;

export type EscPosRasterAsset = { assetId: string; version: number; sha256: string; widthDots: number; heightDots: number; rasterBase64: string };

export class EscPosError extends Error {}

export function bytesSha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function normalizeCp932Text(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC").replaceAll("\u00a5", "\\");
}

export function encodeCp932(value: string): Uint8Array {
  const normalized = normalizeCp932Text(value);
  const bytes = iconv.encode(normalized, "cp932");
  if (iconv.decode(bytes, "cp932") !== normalized) throw new EscPosError("CP932非対応文字が含まれています");
  return Uint8Array.from(bytes);
}

function columns(value: string): number {
  let result = 0;
  for (const char of value.normalize("NFC")) { const cp = char.codePointAt(0)!; result += cp <= 0x7f || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2; }
  return result;
}

function rowText(left: string, right: string): string {
  const padding = 32 - columns(left) - columns(right);
  if (padding < 1) throw new EscPosError("2列が384 dotsの内容幅を超えています");
  return `${left}${" ".repeat(padding)}${right}`;
}

function qrBytes(dataValue: string, moduleSize: number, errorCorrection: "L" | "M" | "Q" | "H"): Uint8Array {
  const data = new TextEncoder().encode(dataValue);
  if (!data.length || data.length > 7089 || moduleSize < 1 || moduleSize > 8) throw new EscPosError("QR引数が範囲外です");
  const error = { L: 48, M: 49, Q: 50, H: 51 }[errorCorrection]; const length = data.length + 3;
  return Uint8Array.from([
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, error,
    GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, 0x50, 0x30, ...data,
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30, LF,
  ]);
}

function compressCode128(value: string): string {
  // 4桁以上の数字列はコードセットCへ切り替えて桁を半分に圧縮する（横幅対策）。
  let prefix = "";
  let rest = value;
  if (/^\{[ABC]/.test(value)) { prefix = value.slice(0, 2); rest = value.slice(2); }
  let out = prefix || "{B";
  let inC = prefix === "{C";
  let i = 0;
  while (i < rest.length) {
    let j = i;
    while (j < rest.length && rest.charAt(j) >= "0" && rest.charAt(j) <= "9") j++;
    const run = j - i;
    if (run >= 4) {
      let start = i;
      if (run % 2 === 1) {
        if (inC) { out += "{B"; inC = false; }
        out += rest.slice(start, start + 1); start += 1;
      }
      if (!inC) { out += "{C"; inC = true; }
      out += rest.slice(start, j);
      i = j;
    } else {
      if (inC) { out += "{B"; inC = false; }
      out += rest.slice(i, i + 1);
      i += 1;
    }
  }
  return out;
}

export function encodeBarcode(value: string, options: { type?: "code128" | "itf"; width?: number; height?: number; hri?: "none" | "above" | "below" | "both" } = {}): Uint8Array {
  const width = options.width ?? 3; const height = options.height ?? 96; const hri = options.hri ?? "below";
  if (!Number.isSafeInteger(width) || width < 2 || width > 6 || !Number.isSafeInteger(height) || height < 1 || height > 255) throw new EscPosError("barcode引数が範囲外です");
  const hriValue = { none: 0, above: 1, below: 2, both: 3 }[hri];
  if (options.type === "itf") {
    if (!/^[0-9]+$/.test(value) || value.length % 2 !== 0 || value.length > 255) throw new EscPosError("ITFデータが不正です");
    const data = Uint8Array.from(Buffer.from(value, "ascii"));
    return Uint8Array.from([ESC, 0x61, 1, GS, 0x48, hriValue, GS, 0x77, width, GS, 0x68, height, GS, 0x6b, 70, data.length, ...data, LF, ESC, 0x61, 0]);
  }
  const data = Uint8Array.from(Buffer.from(compressCode128(value), "ascii"));
  if (!value || Buffer.from(value, "ascii").toString("ascii") !== value || data.length > 255) throw new EscPosError("Code 128データが不正です");
  return Uint8Array.from([ESC, 0x61, 1, GS, 0x48, hriValue, GS, 0x77, width, GS, 0x68, height, GS, 0x6b, 73, data.length, ...data, LF, ESC, 0x61, 0]);
}

function rasterBytes(asset: EscPosRasterAsset, requestedWidth: number): Uint8Array {
  if (requestedWidth !== asset.widthDots || requestedWidth > 384 || asset.widthDots > 416 || asset.heightDots < 1 || asset.heightDots > 4096) throw new EscPosError(`画像assetの寸法が不正です: ${asset.assetId}`);
  const raster = Uint8Array.from(Buffer.from(asset.rasterBase64, "base64")); const widthBytes = Math.ceil(asset.widthDots / 8);
  if (raster.length !== widthBytes * asset.heightDots || bytesSha256(raster) !== asset.sha256) throw new EscPosError(`画像assetのhashまたは長さが不正です: ${asset.assetId}`);
  return Uint8Array.from([ESC, 0x61, 1, GS, 0x76, 0x30, 0, widthBytes & 0xff, (widthBytes >> 8) & 0xff, asset.heightDots & 0xff, (asset.heightDots >> 8) & 0xff, ...raster, LF, ESC, 0x61, 0]);
}

function append(parts: number[], bytes: Uint8Array): void { parts.push(...bytes); }

export function receiptDocumentToEscPos(document: ReceiptDocument, assets: readonly EscPosRasterAsset[] = []): Uint8Array {
  validateDocument(document);
  const assetsById = new Map(assets.map((asset) => [asset.assetId, asset])); const output: number[] = [];
  for (const node of document.nodes) {
    switch (node.kind) {
      case "reset": output.push(ESC, 0x40, ESC, 0x33, 24, ESC, 0x52, 8, FS, 0x43, 1, FS, 0x26); break;
      case "text": append(output, encodeCp932(node.value)); output.push(LF); break;
      case "align": output.push(ESC, 0x61, { left: 0, center: 1, right: 2 }[node.value]); break;
      case "emphasis": output.push(ESC, 0x45, node.bold ? 1 : 0, ESC, 0x2d, node.underline ? 1 : 0, FS, 0x2d, node.underline ? 1 : 0, GS, 0x42, node.invert ? 1 : 0); break;
      case "size": output.push(GS, 0x21, ((node.width - 1) << 4) | (node.height - 1)); break;
      case "row": append(output, encodeCp932(rowText(node.left, node.right))); output.push(LF); break;
      case "rule": append(output, encodeCp932((node.style === "double" ? "=" : "-").repeat(32))); output.push(LF); break;
      case "feed": output.push(...new Array<number>(node.lines).fill(LF)); break;
      case "image": { const asset = assetsById.get(node.assetId); if (!asset) throw new EscPosError(`画像assetがありません: ${node.assetId}`); append(output, rasterBytes(asset, node.widthDots)); break; }
      case "qr": output.push(ESC, 0x61, 1); append(output, qrBytes(node.data, node.moduleSize, node.errorCorrection)); output.push(ESC, 0x61, 0); break;
      case "barcode": append(output, encodeBarcode(node.value, { type: node.format ?? "code128", width: node.width, height: node.height, hri: node.hri })); break;
      case "cut": if (node.mode === "partial") output.push(ESC, 0x69); else if (node.mode === "partial3") output.push(ESC, 0x6d); break;
    }
  }
  return Uint8Array.from(output);
}

export function canonicalIrToEscPos(source: string, assets: readonly EscPosRasterAsset[] = []): Uint8Array {
  return receiptDocumentToEscPos(parseCanonicalReceiptIr(source), assets);
}
