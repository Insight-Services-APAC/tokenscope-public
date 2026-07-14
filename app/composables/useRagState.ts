/*
 * useRagState — shared RAG threshold computation.
 *
 * Single source of truth for "percent → severity" — used by UiPbar,
 * UiRagChip, UiKpi, and any consumer that needs RAG state without a
 * component. Thresholds match design-notes §Screen 2:
 *   < 0.75 → green / harmony  (Healthy)
 *   ≥ 0.75 → amber             (Watch)
 *   ≥ 0.90 → red               (Critical — approaching budget)
 *   > 1.00 → red               (Over — actually over budget)
 *
 * COLOUR (ragOf) and LABEL (ragLabel) are deliberately distinct: red at 90–100%
 * is a hard warning but NOT "over". "Over" is reserved for spend that has crossed
 * the budget (pct > 1) — labelling 91% as "Over" reads as over-budget when it isn't.
 */
export type RagSeverity = 'green' | 'amber' | 'red'

export function ragOf(pct: number): RagSeverity {
  if (pct >= 0.9) return 'red'
  if (pct >= 0.75) return 'amber'
  return 'green'
}

/** Human label for a RAG percentage. "Over" only once the budget is exceeded. */
export function ragLabel(pct: number): string {
  if (pct > 1) return 'Over'
  if (pct >= 0.9) return 'Critical'
  if (pct >= 0.75) return 'Watch'
  return 'Healthy'
}

export function useRagState(pct: () => number) {
  const sev = ragOf(pct())
  return { sev }
}
