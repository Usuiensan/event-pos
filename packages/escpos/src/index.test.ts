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
    expect(Array.from(bytes.slice(12, 17))).toEqual([0x1d, 0x6b, 73, 12, 0x7b]);
    expect(Buffer.from(bytes.slice(17)).toString("ascii")).toContain("PS{C111234");
    expect(bytesSha256(bytes)).toBe("ebc2750712e9207d94bb7417404d1569dfe322e1169c4d0ef10ed2f88bc9e1fa");
  });

  it("数字列をコードセットCで圧縮する", () => {
    const data = (value: string) => Buffer.from(encodeBarcode(value, { width: 2, height: 96, hri: "below" }).slice(15)).toString("ascii");
    expect(data("{BPS1426110110000057")).toContain("{BPS{C1426110110000057");
    expect(data("{BPS1212345")).toContain("{BPS1{C212345");
    expect(data("{BAB12345CD")).toContain("{BAB1{C2345{BCD");
    expect(data("{BPS112")).toContain("{BPS112");
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
});
