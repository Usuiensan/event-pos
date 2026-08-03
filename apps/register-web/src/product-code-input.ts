import type { ProductDefinition } from "@event-pos/contracts";

/** 手入力した内部商品コードを、バーコード解析を介さず完全一致で探す。 */
export function findProductByManualCode(products: ProductDefinition[], input: string): ProductDefinition | undefined {
  const code = input.trim();
  return code ? products.find((product) => product.productCode === code) : undefined;
}
