/**
 * Money, at the precision the number deserves.
 *
 * A session can cost three dollars or three tenths of a cent, and one fixed
 * number of decimals cannot serve both: two decimals rounds a cheap session to
 * "$0.00", four decimals makes an expensive one unreadable. So the scale
 * decides.
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "—";
  if (cost <= 0) return "$0";
  if (cost >= 0.1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
