/*
 * What the Provider governance page calls each governance cutover status
 * (#545). The page used to print the raw status (`not_started`); every badge
 * now reads from this one map. The statuses are server/governance/cutover.ts
 * `CutoverStatus`; tests/unit/shared/cutover-status.test.ts keeps the two in
 * step.
 */

export const CUTOVER_STATUSES = ['not_started', 'preflight_verified', 'activated', 'rolled_back'] as const
export type CutoverStatusKey = (typeof CUTOVER_STATUSES)[number]

export const CUTOVER_STATUS_LABELS: Record<CutoverStatusKey, string> = {
  not_started: 'Not started',
  preflight_verified: 'Preflight passed',
  activated: 'Active',
  rolled_back: 'Rolled back',
}

/** The badge text for a status. An unknown status says so rather than printing a key. */
export function cutoverStatusLabel(status: string | null | undefined): string {
  return (CUTOVER_STATUS_LABELS as Record<string, string>)[status ?? ''] ?? 'Unknown'
}
