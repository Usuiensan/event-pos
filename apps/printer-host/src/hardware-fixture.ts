import { bytesSha256, receiptDocumentToEscPos, type EscPosRasterAsset } from "@event-pos/escpos";
import { canonicalizeReceiptDocument, type ReceiptDocument } from "@event-pos/receipt-ir";

export const HARDWARE_FIXTURE_ID = "tm-t70ii-parity-v1";
export const HARDWARE_FIXTURE_VERSION = 1;

const raster = Uint8Array.from([
  0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81,
  0x00, 0x7e, 0x42, 0x42, 0x42, 0x42, 0x7e, 0x00,
]);

export type HardwareFixture = {
  fixtureId: typeof HARDWARE_FIXTURE_ID;
  fixtureVersion: typeof HARDWARE_FIXTURE_VERSION;
  canonicalIr: string;
  irSha256: string;
  bytes: Uint8Array;
  bytesSha256: string;
  assets: readonly EscPosRasterAsset[];
};

/** Pure deterministic fixture; it never uses a production documentType or arbitrary raw payload. */
export function buildHardwareFixture(): HardwareFixture {
  const asset: EscPosRasterAsset = {
    assetId: "parity-mark", version: 1, sha256: bytesSha256(raster), widthDots: 8, heightDots: 16,
    rasterBase64: Buffer.from(raster).toString("base64"),
  };
  const document: ReceiptDocument = {
    schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416,
    nodes: [
      { kind: "reset" }, { kind: "align", value: "center" }, { kind: "text", value: "EVENT-POS HARDWARE PROBE" },
      { kind: "align", value: "left" }, { kind: "text", value: "ASCII: ABC xyz 123" }, { kind: "text", value: "日本語: テスト 印字" },
      { kind: "text", value: "YEN: \u00a5100" }, { kind: "row", left: "12345678901234567890", right: "12345678901" },
      { kind: "rule", style: "single" }, { kind: "image", assetId: asset.assetId, widthDots: asset.widthDots },
      { kind: "qr", data: "https://event-pos.invalid/probe/PS111234", moduleSize: 4, errorCorrection: "M" },
      { kind: "barcode", value: "{BPS111234", width: 3, height: 96, hri: "below" }, { kind: "feed", lines: 3 }, { kind: "cut", mode: "partial" },
    ],
  };
  const canonicalIr = canonicalizeReceiptDocument(document);
  const bytes = receiptDocumentToEscPos(document, [asset]);
  return { fixtureId: HARDWARE_FIXTURE_ID, fixtureVersion: HARDWARE_FIXTURE_VERSION, canonicalIr, irSha256: bytesSha256(new TextEncoder().encode(canonicalIr)), bytes, bytesSha256: bytesSha256(bytes), assets: [asset] };
}
