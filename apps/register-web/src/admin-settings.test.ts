import { describe, expect, it } from "vitest";
import { createNewProductDraft, ensureEventDetails, newDepartment, nextDepartmentId, productFromNewProductDraft, validateNewProductDraft } from "./admin-settings.js";

describe("管理画面の部門採番", () => {
  it("未使用の3桁連番を採番する", () => {
    expect(nextDepartmentId([])).toBe("001");
    expect(nextDepartmentId([{ departmentId: "001", code: "001", name: "青果", settlementOwnerId: "001", enabled: true }, { departmentId: "003", code: "003", name: "書籍", settlementOwnerId: "003", enabled: true }])).toBe("002");
  });

  it("新規部門は内部IDを表示名から分離する", () => {
    expect(newDepartment([])).toEqual({ departmentId: "001", code: "001", name: "新しい部門", settlementOwnerId: "001", enabled: true });
  });
});

describe("管理画面のイベント情報補完", () => {
  it("旧DBにeventがなくても編集可能な初期値を用意する", () => {
    const result = ensureEventDetails({ eventId: "event-1", products: [], quickEntries: [] });
    expect(result.event).toEqual({ name: "event-1", businessDate: "1970-01-01", seller: { circleName: "", space: "", receiptIssuerName: "" }, locale: { language: "ja-JP", currency: "JPY", timezone: "Asia/Tokyo" } });
  });
});

describe("商品データ新規登録", () => {
  const catalog = { eventId: "event-1", products: [], quickEntries: [], productTabs: [{ id: "tab-1", label: "新刊" }], departments: [{ departmentId: "001", code: "001", name: "書籍", settlementOwnerId: "001", enabled: true }] };

  it("既存コードと必須項目を検証する", () => {
    const draft = createNewProductDraft(catalog);
    expect(validateNewProductDraft([], draft)).toBe("商品コードを入力してください。");
    draft.productCode = "A001";
    draft.name = "新刊";
    expect(validateNewProductDraft([{ productCode: "A001", name: "既存", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], draft)).toBe("商品コード「A001」は登録済みです。");
  });

  it("税込・税抜価格と初期のタブ、部門を商品定義へ変換する", () => {
    const product = productFromNewProductDraft({ ...createNewProductDraft(catalog), productCode: "A002", name: "新刊", priceInput: 100, priceMode: "excluded", taxRate: 10 });
    expect(product).toMatchObject({ productCode: "A002", name: "新刊", priceInclTax: 110, priceExclTax: 100, taxCategory: "exclusive_10", tabId: "tab-1", departmentId: "001" });
  });
});
