export const REASON_OPTIONS = ["用紙不具合", "システム不具合", "売主都合", "買主都合", "その他"] as const;
export const DEFAULT_REASON = "その他";

export const PAY_IN_REASON_OPTIONS = ["釣銭補充", "両替", "金庫から補充", "他レジから", "売掛回収", "立替返済", "預り金", "その他"] as const;
export const PAY_OUT_REASON_OPTIONS = ["両替", "売上金回収・金庫へ", "銀行入金", "立替精算", "消耗品・備品", "交通費", "仕入・買い出し", "返金", "その他"] as const;

export function cashMovementReasonOptions(movementType: "pay_in" | "pay_out"): readonly string[] {
  return movementType === "pay_in" ? PAY_IN_REASON_OPTIONS : PAY_OUT_REASON_OPTIONS;
}

export function ReasonSelect({ value, onChange, options = REASON_OPTIONS }: { value: string; onChange: (value: string) => void; options?: readonly string[] }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
}
