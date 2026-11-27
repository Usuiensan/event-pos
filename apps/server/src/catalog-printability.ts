import type { EventCatalog } from "@event-pos/contracts";
import { findCp932UnprintableChars } from "@event-pos/escpos";

// 帳票へ印字されるカタログ項目に、プリンター（CP932）で印字できない文字が
// 含まれていたら保存を拒否する。営業開始後に会計・精算が止まる事態を、
// 開局前の保存時点で防ぐための検証（F-070 / F-071）。
// 既に保存済みのデータについては escpos 側の印字時置換が防御する。
export function validateCatalogPrintability(catalog: EventCatalog): void {
  const targets: Array<{ field: string; value: string | undefined }> = [];
  catalog.products.forEach((product, index) => {
    targets.push({ field: `products[${index}].name（商品コード ${product.productCode}）`, value: product.name });
    targets.push({ field: `products[${index}].receiptNote（商品コード ${product.productCode}）`, value: product.receiptNote });
  });
  catalog.departments?.forEach((department, index) => {
    targets.push({ field: `departments[${index}].name`, value: department.name });
  });
  catalog.autoDiscountRules?.forEach((rule, index) => {
    targets.push({ field: `autoDiscountRules[${index}].label`, value: rule.label });
  });
  catalog.staffMembers?.forEach((member, index) => {
    targets.push({ field: `staffMembers[${index}].displayName`, value: member.displayName });
  });
  if (catalog.event) {
    targets.push({ field: "event.name", value: catalog.event.name });
    targets.push({ field: "event.seller.circleName", value: catalog.event.seller.circleName });
    targets.push({ field: "event.seller.space", value: catalog.event.seller.space });
    targets.push({ field: "event.seller.receiptIssuerName", value: catalog.event.seller.receiptIssuerName });
  }
  // レシートのスナップショットは event.seller.circleName ではなく
  // customerWelcome.circleName を参照するため、こちらも検証対象にする（F-089）。
  if (catalog.customerWelcome) {
    targets.push({ field: "customerWelcome.circleName", value: catalog.customerWelcome.circleName });
  }
  const commonText = catalog.receiptSettings?.commonText;
  if (commonText) {
    targets.push({ field: "receiptSettings.commonText.footer", value: commonText.footer });
    targets.push({ field: "receiptSettings.commonText.returnPolicy", value: commonText.returnPolicy });
    targets.push({ field: "receiptSettings.commonText.reprintLabel", value: commonText.reprintLabel });
  }
  for (const target of targets) {
    if (!target.value) continue;
    const unprintable = findCp932UnprintableChars(target.value);
    if (unprintable.length) throw new Error(`${target.field}にプリンターで印字できない文字が含まれています: ${unprintable.join(" ")}`);
  }
}
