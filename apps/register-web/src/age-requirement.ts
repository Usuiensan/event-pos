import type { ProductDefinition } from "@event-pos/contracts";

// 年齢要件は商品の ageCheck のみで決める。商品名からの推定はしない（サーバーの age_requirement と一致させる）。
export function ageRequirement(product: ProductDefinition): 18 | 20 | null {
  return product.ageCheck === "18" ? 18 : product.ageCheck === "20" ? 20 : null;
}

export function isAgeRestricted(product: ProductDefinition): boolean {
  return ageRequirement(product) !== null;
}
