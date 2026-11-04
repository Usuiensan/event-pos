import { describe, expect, it } from "vitest";
import { canonicalizeReceiptDocument, type ReceiptDocument } from "@event-pos/receipt-ir";
import { bytesSha256, canonicalIrToEscPos, encodeBarcode, encodeCp932, receiptDocumentToEscPos, type EscPosRasterAsset } from "./index.js";

const raster = Uint8Array.from([0x80, 0x40]);
const asset: EscPosRasterAsset = { assetId: "logo", version: 1, sha256: bytesSha256(raster), widthDots: 8, heightDots: 2, rasterBase64: Buffer.from(raster).toString("base64") };
const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes: [
  { kind: "reset" }, { kind: "text", value: "日本語 ¥100" }, { kind: "image", assetId: "logo", widthDots: 8 },
  { kind: "qr", data: "PS111234", moduleSize: 4, errorCorrection: "M" }, { kind: "feed", lines: 3 }, { kind: "cut", mode: "partial" },
] };

describe("pure ESC/POS renderer", () => {
  it("CP932の日本語とU+00A5をnative bytesへ決定的に変換する", () => {
    const bytes = encodeCp932("日本語 ¥100");
    expect(Array.from(bytes.slice(-5))).toEqual([0x20, 0x5c, 0x31, 0x30, 0x30]);
    expect(bytesSha256(bytes)).toBe("29e408c93672bbae2b8fff6f056aa301c2efa06d75cf442203d001e3253979c0");
  });

  it("画像・QR・紙送り・部分カットのgolden bytesを固定する", () => {
    const first = receiptDocumentToEscPos(document, [asset]); const second = canonicalIrToEscPos(canonicalizeReceiptDocument(document), [asset]);
    expect(first).toEqual(second);
    expect(Array.from(first.slice(-5))).toEqual([0x0a, 0x0a, 0x0a, 0x1b, 0x69]);
    expect(bytesSha256(first)).toBe("7f0b55795f8f9effffbead43aed214ef6e98694479dd1c4849002adbe05c7d1d");
  });

  it("Code 128 barcodeのcharacterization bytesを固定する", () => {
    const bytes = encodeBarcode("{BPS111234", { width: 3, height: 96, hri: "below" });
    expect(Array.from(bytes.slice(12, 17))).toEqual([0x1d, 0x6b, 73, 9, 0x7b]);
    // コードセットC区間は数字ペアがバイナリ値 (11, 12, 34) になる
    expect(Array.from(bytes.slice(16, 25))).toEqual([0x7b, 66, 80, 83, 0x7b, 67, 11, 12, 34]);
    expect(bytesSha256(bytes)).toBe("ccb63f55eef1d15a2a29be4c2154133ce5f5bfd659041ad1c77e88fb52459c81");
  });

  it("数字列をコードセットCで圧縮する", () => {
    const data = (value: string) => Array.from(encodeBarcode(value, { width: 2, height: 96, hri: "below" }).slice(16, -4));
    expect(data("{BPS1426110110000057")).toEqual([0x7b, 66, 80, 83, 0x7b, 67, 14, 26, 11, 1, 10, 0, 0, 57]);
    expect(data("{BPS1212345")).toEqual([0x7b, 66, 80, 83, 49, 0x7b, 67, 21, 23, 45]);
    expect(data("{BAB12345CD")).toEqual([0x7b, 66, 65, 66, 49, 0x7b, 67, 23, 45, 0x7b, 66, 67, 68]);
    expect(data("{BPS112")).toEqual([0x7b, 66, 80, 83, 49, 49, 50]);
  });

  it("ITFバーコードを印字コマンドへ変換する", () => {
    const bytes = encodeBarcode("26110110000015", { type: "itf", width: 2, height: 96, hri: "below" });
    expect(Array.from(bytes.slice(12, 16))).toEqual([0x1d, 0x6b, 70, 14]);
    expect(Buffer.from(bytes.slice(16, 30)).toString("ascii")).toBe("26110110000015");
    expect(() => encodeBarcode("2611011000001", { type: "itf" })).toThrow("ITF");
    expect(() => encodeBarcode("2611011000001A", { type: "itf" })).toThrow("ITF");
  });

  it("384 dotsの内容幅と416 dotsの物理上限を別々に検証する", () => {
    expect(() => receiptDocumentToEscPos({ ...document, nodes: [{ kind: "image", assetId: "wide", widthDots: 384 }] }, [{ ...asset, assetId: "wide", widthDots: 416 }])).toThrow("寸法");
  });

  it("180度回転では行順・状態・cutの位置を反転する", () => {
    const rotated = receiptDocumentToEscPos({ ...document, nodes: [
      { kind: "reset" }, { kind: "align", value: "center" }, { kind: "text", value: "TITLE" },
      { kind: "align", value: "left" }, { kind: "text", value: "LINE1\nLINE2" }, { kind: "feed", lines: 1 }, { kind: "cut", mode: "partial" },
    ] }, [], { rotate180: true });
    const bytes = Array.from(rotated);
    expect(bytes.slice(0, 13)).toEqual([0x1b, 0x40, 0x1b, 0x33, 24, 0x1b, 0x52, 8, 0x1c, 0x43, 1, 0x1c, 0x26]);
    expect(bytes.slice(13, 16)).toEqual([0x1b, 0x7b, 1]);
    const text = Buffer.from(rotated).toString("binary");
    expect(text.indexOf("LINE2")).toBeLessThan(text.indexOf("LINE1"));
    expect(bytes.filter((value, index) => value === 0x1b && bytes[index + 1] === 0x61)).toHaveLength(4);
    expect(bytes.slice(-2)).toEqual([0x1b, 0x69]);
  });

  it("180度回転ではラスターのバイト順とビット順を反転する", () => {
    const source = Uint8Array.from([0b10000001, 0b00000110]);
    const rotated = receiptDocumentToEscPos({ ...document, nodes: [{ kind: "reset" }, { kind: "image", assetId: "logo", widthDots: 8 }] }, [
      { ...asset, rasterBase64: Buffer.from(source).toString("base64"), sha256: bytesSha256(source) },
    ], { rotate180: true });
    const header = Array.from(rotated).findIndex((value, index) => value === 0x1d && rotated[index + 1] === 0x76 && rotated[index + 2] === 0x30);
    expect(Array.from(rotated.slice(header + 8, header + 10))).toEqual([0b01100000, 0b10000001]);
  });

  it("180度回転でもbarcodeとQRのコマンド内容を保つ", () => {
    const nodes = [{ kind: "reset" as const }, { kind: "barcode" as const, value: "ABC", width: 3, height: 96, hri: "below" as const }, { kind: "qr" as const, data: "QR", moduleSize: 4, errorCorrection: "M" as const }, { kind: "cut" as const, mode: "partial" as const }];
    const normal = receiptDocumentToEscPos({ ...document, nodes });
    const rotated = receiptDocumentToEscPos({ ...document, nodes }, [], { rotate180: true });
    expect(Buffer.from(rotated).includes(Buffer.from(encodeBarcode("ABC", { width: 3, height: 96, hri: "below" })))).toBe(true);
    expect(Array.from(rotated).filter((value, index) => value === 0x1d && rotated[index + 1] === 0x6b)).toHaveLength(Array.from(normal).filter((value, index) => value === 0x1d && normal[index + 1] === 0x6b).length);
  });

  it("改行を含むtextは無回転時のバイトを保ち、回転時は行単位で逆転する", () => {
    const nodes = [{ kind: "reset" as const }, { kind: "text" as const, value: "A\nB" }, { kind: "cut" as const, mode: "partial" as const }];
    const normal = receiptDocumentToEscPos({ ...document, nodes });
    const split = receiptDocumentToEscPos({ ...document, nodes: [{ kind: "reset" }, { kind: "text", value: "A" }, { kind: "text", value: "B" }, { kind: "cut", mode: "partial" }] });
    expect(normal).toEqual(split);
    const rotated = Buffer.from(receiptDocumentToEscPos({ ...document, nodes }, [], { rotate180: true })).toString("binary");
    expect(rotated.indexOf("B")).toBeLessThan(rotated.indexOf("A"));
  });
});
