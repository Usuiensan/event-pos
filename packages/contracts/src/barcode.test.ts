import { calculateMod10CheckDigit, parseBarcode, parsePaymentSlipCode } from "./barcode.js";
import { describe, expect, it } from "vitest";

describe("barcode parsing", () => {
  it("書籍JANの上下段を解析する", () => {
    expect(parseBarcode("9784123456789")).toMatchObject({ kind: "book-isbn" });
    expect(parseBarcode("1920095001203")).toMatchObject({ kind: "book-price", bookPrice: { cCode: "0095", priceExclTaxYen: 120 } });
  });
  it("定期刊行物JANを解析する", () => expect(parseBarcode("491217631016501000")).toMatchObject({ kind: "periodical", periodical: { coreCode: "4912176310165", priceExclTaxYen: 1000 } }));
  it("代理収納票を検証して自由使用欄を返す", () => {
    const first43 = `91${"123451"}${"123456789012345678901"}1${"250131"}0${"012340"}`;
    const code = `${first43}${calculateMod10CheckDigit(first43)}`;
    const result = parsePaymentSlipCode(`]C1${code}\r`);
    expect(result).toMatchObject({ ok: true, value: { issuerCode: "123451", amount: 12340, dueDate: { isoDate: "2025-01-31" } } });
  });
});
