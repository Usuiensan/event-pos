import { describe, expect, it } from "vitest";
import { canonicalizeReceiptDocument, type ReceiptDocument } from "@event-pos/receipt-ir";
import { bytesSha256, canonicalIrToEscPos, encodeBarcode, encodeCp932, receiptDocumentToEscPos, type EscPosRasterAsset } from "./index.js";
import iconv from "iconv-lite";

const displayWidth = (value: string): number => { let result = 0; for (const char of value) { const cp = char.codePointAt(0)!; result += cp <= 0x7f || cp === 0xa5 || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2; } return result; };

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

  it("¥を含むrowは32列ちょうどに右揃えされる", () => {
    const bytes = receiptDocumentToEscPos({ ...document, nodes: [
      { kind: "reset" }, { kind: "row", left: "TOTAL", right: "¥500" }, { kind: "cut", mode: "partial" },
    ] });
    const line = Buffer.from(bytes).toString("latin1").split("\n").find((value) => value.includes("TOTAL"))!;
    // TOTAL (5列) + 空白 (23列) + \500 (4列) = 32列。¥を2列と数えると31列になる。
    expect(line.endsWith("TOTAL" + " ".repeat(23) + "\\500")).toBe(true);
    expect(line.length - line.indexOf("TOTAL")).toBe(32);
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

  it("180度回転では文書末尾feedを反転列へ残し、cut直前へ固定4行を追加する", () => {
    const nodes = (feedLines: number) => [
      { kind: "reset" as const }, { kind: "text" as const, value: "A" }, { kind: "feed" as const, lines: feedLines }, { kind: "cut" as const, mode: "partial" as const },
    ];
    for (const feedLines of [1, 8]) {
      const bytes = Array.from(receiptDocumentToEscPos({ ...document, nodes: nodes(feedLines) }, [], { rotate180: true }));
      expect(bytes.slice(-6)).toEqual([0x0a, 0x0a, 0x0a, 0x0a, 0x1b, 0x69]);
      const firstFeed = bytes.indexOf(0x0a, 16);
      expect(bytes.slice(firstFeed, firstFeed + feedLines)).toEqual(new Array(feedLines).fill(0x0a));
      expect(bytes.filter((value) => value === 0x0a)).toHaveLength(feedLines + 5);
    }
  });

  it("cutがない回転文書のfeedは従来どおり反転する", () => {
    const nodes = [{ kind: "reset" as const }, { kind: "text" as const, value: "A" }, { kind: "feed" as const, lines: 2 }];
    const bytes = Array.from(receiptDocumentToEscPos({ ...document, nodes }, [], { rotate180: true }));
    expect(bytes.slice(-2)).toEqual([0x41, 0x0a]);
    expect(bytes.indexOf(0x0a)).toBeLessThan(bytes.indexOf(0x41));
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

  it("左側が長いrowは例外にせず折り返し、金額を最終行の右端にそろえる", () => {
    const name = "あいうえおかきくけこさしすせそた"; // 全角16文字 = 32列
    const bytes = receiptDocumentToEscPos({ ...document, nodes: [
      { kind: "reset" }, { kind: "row", left: `${name} ×1`, right: "¥100" }, { kind: "cut", mode: "partial" },
    ] });
    const text = iconv.decode(Buffer.from(bytes), "cp932");
    // 制御命令のバイト列を避け、名前の開始位置から折り返した2行を取り出す
    const lines = text.slice(text.indexOf("あ")).split("\n").slice(0, 2);
    expect(lines.length).toBe(2);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(32);
    // 切り捨てず全文が残り、金額は最終行の右端（32列目）までそろう（¥はCP932復号で \ になる）
    expect(lines[0]).toBe(name);
    expect(lines.join("").replace(/ /g, "")).toBe(`${name}×1\\100`);
    expect(lines.at(-1)!.endsWith("100")).toBe(true);
    expect(displayWidth(lines.at(-1)!)).toBe(32);
  });

  it("180度回転でも折り返したrowの行順が保たれる", () => {
    const name = "あいうえおかきくけこさしすせそた";
    const bytes = receiptDocumentToEscPos({ ...document, nodes: [
      { kind: "reset" }, { kind: "align", value: "left" }, { kind: "row", left: `${name} ×1`, right: "¥100" }, { kind: "cut", mode: "partial" },
    ] }, [], { rotate180: true });
    const text = iconv.decode(Buffer.from(bytes), "cp932");
    // 回転出力は行順を反転して送るため、金額のある最終行が名前の先頭より先に現れる
    expect(text.indexOf("100")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("あいうえお")).toBeGreaterThan(text.indexOf("100"));
  });
});
