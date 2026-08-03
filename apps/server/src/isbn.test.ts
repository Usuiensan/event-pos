import { describe, expect, it } from "vitest";
import { parseNdlIsbnXml } from "./isbn.js";

describe("NDL ISBN OpenSearch XML", () => {
  it("書誌情報と価格を抽出する", () => {
    const xml = `<rss><channel><item><dc:title>吾輩は猫である</dc:title><dc:creator>夏目漱石</dc:creator><dc:publisher>岩波書店</dc:publisher><dcterms:issued>1990.4</dcterms:issued><dcndl:price>410円 (税込)</dcndl:price></item></channel></rss>`;
    expect(parseNdlIsbnXml(xml, "9784003101018", "2026-08-03T00:00:00.000Z")).toMatchObject({ code: "9784003101018", productName: "吾輩は猫である", author: "夏目漱石", publisherName: "岩波書店", issued: "1990.4", price: 410 });
  });

  it("書誌がない結果を拒否する", () => expect(() => parseNdlIsbnXml("<rss><channel /></rss>", "9784003101018")).toThrow("NDLサーチにISBNの書誌情報がありません"));
});
