export type AutoDiscountRule = {
  id: string;
  label: string;
  requiredProducts: Array<{ productCode: string; quantity: number }>;
  discountYen: number;
  priority?: number;
};

export type AppliedAutoDiscount = { ruleId: string; label: string; discountYen: number; applications: number };

type Candidate = { rule: AutoDiscountRule; applications: number };

function canApply(remaining: Map<string, number>, rule: AutoDiscountRule): boolean {
  return rule.requiredProducts.every((item) => (remaining.get(item.productCode) ?? 0) >= item.quantity);
}

function apply(remaining: Map<string, number>, rule: AutoDiscountRule): Map<string, number> {
  const next = new Map(remaining);
  for (const item of rule.requiredProducts) next.set(item.productCode, (next.get(item.productCode) ?? 0) - item.quantity);
  return next;
}

function signature(candidates: Candidate[]): string {
  return candidates.filter((candidate) => candidate.applications > 0).map((candidate) => `${candidate.rule.priority ?? 0}:${candidate.rule.id}:${candidate.applications}`).join("|");
}

/** Applies each product quantity token to at most one automatic discount and finds the greatest total discount. */
export function calculateAutoDiscounts(quantities: ReadonlyMap<string, number>, rules: readonly AutoDiscountRule[]): AppliedAutoDiscount[] {
  const sortedRules = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  let best: Candidate[] = [];
  let bestYen = 0;
  const search = (remaining: Map<string, number>, candidates: Candidate[], discountYen: number) => {
    if (discountYen > bestYen || (discountYen === bestYen && signature(candidates) < signature(best))) { bestYen = discountYen; best = candidates.map((candidate) => ({ ...candidate })); }
    for (let index = 0; index < sortedRules.length; index += 1) {
      const rule = sortedRules[index]!;
      if (!canApply(remaining, rule)) continue;
      const next = candidates.map((candidate) => candidate.rule.id === rule.id ? { ...candidate, applications: candidate.applications + 1 } : candidate);
      if (!next.some((candidate) => candidate.rule.id === rule.id)) next.push({ rule, applications: 1 });
      search(apply(remaining, rule), next, discountYen + rule.discountYen);
    }
  };
  search(new Map(quantities), [], 0);
  return best.filter((candidate) => candidate.applications > 0).map((candidate) => ({ ruleId: candidate.rule.id, label: candidate.rule.label, discountYen: candidate.rule.discountYen * candidate.applications, applications: candidate.applications }));
}
