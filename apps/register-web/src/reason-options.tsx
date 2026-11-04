export const REASON_OPTIONS = ["用紙不具合", "システム不具合", "売主都合", "買主都合", "その他"] as const;
export const DEFAULT_REASON = "その他";

export function ReasonSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}>{REASON_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
}
