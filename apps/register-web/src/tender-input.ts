export function convertToTenThousands(input: string): string {
  const units = input ? Number(input) : 1;
  return String(Math.min(999_999_999, units * 10_000));
}
