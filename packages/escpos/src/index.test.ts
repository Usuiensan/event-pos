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
    expect(Array.from(bytes.slice(12, 17))).toEqual([0x1d, 0x6b, 73, 10, 0x7b]);
    expect(bytesSha256(bytes)).toBe("e202d7d200f9db4eab12fa4fb310bf9d1130670340c79e2a97baa87d3fa45e48");
  });

  it("384 dotsの内容幅と416 dotsの物理上限を別々に検証する", () => {
    expect(() => receiptDocumentToEscPos({ ...document, nodes: [{ kind: "image", assetId: "wide", widthDots: 384 }] }, [{ ...asset, assetId: "wide", widthDots: 416 }])).toThrow("寸法");
  });
});
