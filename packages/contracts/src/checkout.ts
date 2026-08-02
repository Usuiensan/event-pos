import { calculateAutoDiscounts, type AutoDiscountRule } from "./auto-discount.js";
import type { TaxCategory } from "./catalog.js";

export type ManualDiscountInput = { kind: "rate" | "amount"; value: number };
export type SaleCalculationLineInput = {
  lineId: string;
  lineNo: number;
  productCode: string;
  name: string;
  priceInclTax: number;
  taxRate: number;
  taxCategory: TaxCategory;
  quantity: number;
  status: "active" | "canceled";
  manualDiscount?: ManualDiscountInput;
};
export type DiscountAllocation = { lineId: string; amountYen: number; quantity: number };
export type CalculatedDiscount = {
  id: string;
  kind: "auto" | "manual" | "no_charge";
  label: string;
  valueKind: "amount" | "rate";
  value: number;
  amountYen: number;
  allocations: DiscountAllocation[];
};
export type CalculatedSaleLine = SaleCalculationLineInput & {
  grossYen: number;
  discountYen: number;
  taxYen: number;
  netYen: number;
};
export type TaxSummary = {
  taxRateBps: number;
  taxableGrossYen: number;
  discountAllocatedYen: number;
  taxableNetYen: number;
  taxAmountYen: number;
  roundingMode: "floor";
};
export type SaleCalculation = {
  lines: CalculatedSaleLine[];
  discounts: CalculatedDiscount[];
  taxSummaries: TaxSummary[];
  subtotalYen: number;
  discountTotalYen: number;
  taxTotalYen: number;
  totalYen: number;
};

export class SaleCalculationError extends Error {
  constructor(public readonly code: "INVALID_LINE" | "INVALID_MANUAL_DISCOUNT" | "DISCOUNT_EXCEEDS_TARGET", message: string) { super(message); }
}

type WeightedTarget = { lineId: string; weight: number; capacity: number; quantity: number; tie: number };

function allocateLargestRemainder(amount: number, targets: WeightedTarget[]): DiscountAllocation[] {
  if (amount === 0) return targets.map(({ lineId, quantity }) => ({ lineId, quantity, amountYen: 0 }));
  const capacity = targets.reduce((sum, target) => sum + target.capacity, 0);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > capacity) throw new SaleCalculationError("DISCOUNT_EXCEEDS_TARGET", "値引額が対象額を超えています");
  const positive = targets.filter((target) => target.capacity > 0);
  const totalWeight = positive.reduce((sum, target) => sum + target.weight, 0);
  let remaining = amount;
  const allocated = positive.map((target) => {
    const exact = totalWeight > 0 ? amount * target.weight / totalWeight : 0;
    const base = Math.min(target.capacity, Math.floor(exact));
    remaining -= base;
    return { ...target, amountYen: base, remainder: exact - Math.floor(exact) };
  });
  allocated.sort((a, b) => b.remainder - a.remainder || a.tie - b.tie || a.lineId.localeCompare(b.lineId));
  while (remaining > 0) {
    let progressed = false;
    for (const candidate of allocated) {
      if (candidate.amountYen >= candidate.capacity) continue;
      candidate.amountYen += 1;
      remaining -= 1;
      progressed = true;
      if (remaining === 0) break;
    }
    if (!progressed) throw new SaleCalculationError("DISCOUNT_EXCEEDS_TARGET", "値引額が対象額を超えています");
  }
  return allocated.sort((a, b) => a.tie - b.tie || a.lineId.localeCompare(b.lineId)).map(({ lineId, quantity, amountYen }) => ({ lineId, quantity, amountYen }));
}

function validateLine(line: SaleCalculationLineInput): void {
  if (!line.lineId || !line.productCode || !line.name || !Number.isSafeInteger(line.lineNo) || line.lineNo < 1 || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || !Number.isSafeInteger(line.priceInclTax) || line.priceInclTax < 0) {
    throw new SaleCalculationError("INVALID_LINE", "販売明細が不正です");
  }
}

export function calculateSale(inputLines: readonly SaleCalculationLineInput[], rules: readonly AutoDiscountRule[] = [], noCharge = false): SaleCalculation {
  inputLines.forEach(validateLine);
  const activeInputs = inputLines.filter((line) => line.status === "active");
  if (activeInputs.length === 0) throw new SaleCalculationError("INVALID_LINE", "有効な販売明細がありません");
  const lines: CalculatedSaleLine[] = activeInputs.map((line) => ({ ...line, grossYen: line.priceInclTax * line.quantity, discountYen: 0, taxYen: 0, netYen: line.priceInclTax * line.quantity }));
  const discounts: CalculatedDiscount[] = [];
  const quantities = lines.reduce((map, line) => map.set(line.productCode, (map.get(line.productCode) ?? 0) + line.quantity), new Map<string, number>());

  for (const applied of calculateAutoDiscounts(quantities, rules)) {
    const rule = rules.find((candidate) => candidate.id === applied.ruleId)!;
    const required = new Map(rule.requiredProducts.map((item) => [item.productCode, item.quantity * applied.applications]));
    const targets: WeightedTarget[] = [];
    for (const line of lines) {
      const remainingQuantity = required.get(line.productCode) ?? 0;
      if (remainingQuantity <= 0) continue;
      const quantity = Math.min(line.quantity, remainingQuantity);
      required.set(line.productCode, remainingQuantity - quantity);
      const amount = line.priceInclTax * quantity;
      targets.push({ lineId: line.lineId, weight: amount, capacity: line.netYen, quantity, tie: line.lineNo });
    }
    const allocations = allocateLargestRemainder(Math.min(applied.discountYen, targets.reduce((sum, target) => sum + target.capacity, 0)), targets);
    for (const allocation of allocations) {
      const line = lines.find((candidate) => candidate.lineId === allocation.lineId)!;
      line.discountYen += allocation.amountYen;
      line.netYen -= allocation.amountYen;
    }
    discounts.push({ id: `auto:${applied.ruleId}`, kind: "auto", label: applied.label, valueKind: "amount", value: rule.discountYen, amountYen: allocations.reduce((sum, item) => sum + item.amountYen, 0), allocations });
  }

  for (const line of lines) {
    const manual = line.manualDiscount;
    if (!manual) continue;
    if (!Number.isSafeInteger(manual.value) || manual.value < 0 || (manual.kind === "rate" && manual.value > 100)) throw new SaleCalculationError("INVALID_MANUAL_DISCOUNT", manual.kind === "rate" ? "値引率は0～100％で指定してください" : "値引額は0以上の整数で指定してください");
    const requested = manual.kind === "rate" ? line.netYen - Math.floor(line.netYen * (100 - manual.value) / 100) : manual.value * line.quantity;
    if (requested > line.netYen) throw new SaleCalculationError("DISCOUNT_EXCEEDS_TARGET", "値引額が対象額を超えています");
    line.discountYen += requested;
    line.netYen -= requested;
    discounts.push({ id: `manual:${line.lineId}`, kind: "manual", label: manual.kind === "rate" ? `${manual.value}%値引` : `${manual.value}円値引`, valueKind: manual.kind, value: manual.value, amountYen: requested, allocations: [{ lineId: line.lineId, amountYen: requested, quantity: line.quantity }] });
  }

  if (noCharge) {
    const amount = lines.reduce((sum, line) => sum + line.netYen, 0);
    const allocations = lines.map((line) => ({ lineId: line.lineId, amountYen: line.netYen, quantity: line.quantity }));
    for (const line of lines) { line.discountYen += line.netYen; line.netYen = 0; }
    discounts.push({ id: "no-charge", kind: "no_charge", label: "無配", valueKind: "amount", value: amount, amountYen: amount, allocations });
  }

  const taxSummaries: TaxSummary[] = [];
  const rates = [...new Set(lines.map((line) => line.taxRate * 100))].sort((a, b) => b - a);
  for (const taxRateBps of rates) {
    const group = lines.filter((line) => line.taxRate * 100 === taxRateBps);
    const taxableGrossYen = group.reduce((sum, line) => sum + line.grossYen, 0);
    const taxableNetYen = group.reduce((sum, line) => sum + line.netYen, 0);
    const discountAllocatedYen = taxableGrossYen - taxableNetYen;
    const taxAmountYen = taxRateBps === 0 ? 0 : Math.floor(taxableNetYen * taxRateBps / (10_000 + taxRateBps));
    const taxAllocations = allocateLargestRemainder(taxAmountYen, group.map((line) => ({ lineId: line.lineId, weight: line.netYen, capacity: line.netYen, quantity: line.quantity, tie: line.lineNo })));
    for (const allocation of taxAllocations) lines.find((line) => line.lineId === allocation.lineId)!.taxYen = allocation.amountYen;
    taxSummaries.push({ taxRateBps, taxableGrossYen, discountAllocatedYen, taxableNetYen, taxAmountYen, roundingMode: "floor" });
  }
  const subtotalYen = lines.reduce((sum, line) => sum + line.grossYen, 0);
  const discountTotalYen = lines.reduce((sum, line) => sum + line.discountYen, 0);
  const taxTotalYen = taxSummaries.reduce((sum, summary) => sum + summary.taxAmountYen, 0);
  return { lines, discounts, taxSummaries, subtotalYen, discountTotalYen, taxTotalYen, totalYen: subtotalYen - discountTotalYen };
}
