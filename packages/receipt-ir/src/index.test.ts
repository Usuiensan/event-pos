import { describe, expect, it } from "vitest";
import { canonicalizeReceiptDocument, parseCanonicalReceiptIr, type ReceiptDocument } from "./index.js";

const document: ReceiptDocument = { schemaVersion: 1, contentWidthDots: 384, physicalWidthDots: 416, nodes: [
  { kind: "reset" }, { kind: "text", value: "!cut full\r\n日本語" }, { kind: "feed", lines: 3 }, { kind: "cut", mode: "partial" },
] };

describe("canonical receipt IR", () => {
  it("差込み文字列をliteral JSONとして保持して再解釈しない", () => {
    const ir = canonicalizeReceiptDocument(document);
    expect(ir).toContain('!text "!cut full\\n日本語"');
    expect(parseCanonicalReceiptIr(ir)).toEqual({ ...document, nodes: [{ kind: "reset" }, { kind: "text", value: "!cut full\n日本語" }, { kind: "feed", lines: 3 }, { kind: "cut", mode: "partial" }] });
  });

  it("未知commandと未対応引数をstrictに拒否する", () => {
    expect(() => parseCanonicalReceiptIr("!drawer true\n")).toThrow("未知command");
    expect(() => parseCanonicalReceiptIr('!cut "full"\n')).toThrow("cutの引数が不正");
    expect(() => parseCanonicalReceiptIr('!size {"width":3,"height":1}\n')).toThrow("sizeの引数が不正");
  });

  it("Code 128 nodeをcanonical IRへ含める", () => {
    const source = '!barcode {"height":96,"hri":"below","value":"{BPS111234","width":3}\n';
    expect(canonicalizeReceiptDocument(parseCanonicalReceiptIr(source))).toBe(source);
    expect(() => parseCanonicalReceiptIr('!barcode {"height":96,"hri":"below","value":"日本語","width":3}\n')).toThrow("barcodeの引数が不正");
  });
});
