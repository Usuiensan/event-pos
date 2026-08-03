import { describe, expect, it } from "vitest";
import { parseIsdnXml } from "./isdn.js";

describe("ISDN XML", () => {
  it("公開XMLを商品情報へ変換する", () => {
    const info = parseIsdnXml("<isdn><item><disp-isdn>ISDN278-4-702901-97-8</disp-isdn><product-name>みほん&amp;本</product-name><publisher-name>見本サークル</publisher-name><price>100</price><price-unit>JPY</price-unit><barcode2>2923055001007</barcode2></item></isdn>", "2784702901978", "2026-08-03T00:00:00.000Z");
    expect(info).toMatchObject({ code: "2784702901978", displayCode: "ISDN278-4-702901-97-8", productName: "みほん&本", publisherName: "見本サークル", price: 100, priceUnit: "JPY", barcode2: "2923055001007", sourceUrl: "https://isdn.jp/xml/2784702901978" });
  });
  it("itemがないXMLを拒否する", () => expect(() => parseIsdnXml("<isdn />", "2784702901978")).toThrow("ISDNの商品情報が見つかりません"));
});
