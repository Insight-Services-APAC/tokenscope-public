<script setup lang="ts">
/*
 * BudgetStateCell — THE against-budget cell (developer pages build D15.2),
 * extracted from DriversTable's against-budget column so the reporting tables
 * and the me pages render budget state through ONE implementation.
 *
 * THREE states, verbatim from the source cell (04-prototype-delta.md §5b):
 *   - a number       — consumption against this row's OWN allocation,
 *                      "87% of $6,024" (never a share of the scope);
 *   - `budgetUsd: null` — "no budget set": a decision nobody has made about a
 *                      row that COULD hold one. Never 0% and never $0.
 *   - `budgetUsd` ABSENT — "—" not-applicable: this row has nothing a budget
 *                      could be set ON (the untagged bucket, the folded
 *                      multi-project remainder).
 *
 * A ZERO allocation is NOT a budget to consume: dividing by it yields
 * Infinity, and "∞% of $0" is noise where "no budget set" is the true
 * statement.
 *
 * The optional SECONDARY line is the pace figure — "on pace for ~$X by
 * {monthEnd}". The caller passes THIS row's own `projectedMonthEnd()` output
 * (per-bucket, never the portfolio figure — 07-r1-M4) and decides when the
 * line renders (Home's precedent: only under a pace-over verdict). The cell
 * never computes a projection itself; it would need a calendar it does not
 * hold.
 *
 * `costCentreBudgetState` stays the ONE reporting tint function (D15.3) —
 * this component colours by it and never re-derives thresholds.
 */
import { computed } from 'vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import { costCentreBudgetState, type CostCentreBudgetState } from '#shared/reports/types'

const props = defineProps<{
  /** This row's own spend for the window. */
  usd: number
  /**
   * The allocation: a number is a budget to consume; `null` is "no budget
   * set"; ABSENT (undefined) is a row with no budget concept at all (n/a).
   */
  budgetUsd?: number | null
  /**
   * THIS row's own month-end landing in dollars (`projectedMonthEnd` of the
   * row's spend — per-bucket, never the portfolio figure). Absent/null ⇒ no
   * pace line.
   */
  projectedUsd?: number | null
  /** Month-end date label for the pace line (e.g. "July 31"); falls back to "month end". */
  monthEnd?: string | null
}>()

const hasBudgetConcept = computed(() => props.budgetUsd !== undefined)
const consumed = computed(() =>
  props.budgetUsd != null && props.budgetUsd > 0 ? props.usd / props.budgetUsd : null,
)
const state = computed(() => costCentreBudgetState(consumed.value))

// EXHAUSTIVE by type, not by habit: `costCentreBudgetState` gaining a member
// (D26's `not-started`) is a compile error here until this map answers for it.
// `not-started` is NEUTRAL — a budget nothing has been spent against yet is not
// healthy, it is unbegun, and green would say the wrong one.
const TEXT_CLASS: Record<CostCentreBudgetState, string> = {
  over: 'text-rag-red',
  warn: 'text-rag-amber',
  ok: 'text-rag-green',
  'not-started': 'text-carbon-3',
  none: 'text-carbon-3',
}
/*
 * Projected spend as a percentage of budget, ONLY when it exceeds it. Null
 * otherwise, so the ordinary pace line keeps its quiet treatment — severity is
 * spent where it is earned, not sprayed across every row.
 */
const projectedOverPct = computed(() => {
  const b = props.budgetUsd
  const proj = props.projectedUsd
  if (b == null || proj == null || Number(b) <= 0) return null
  /*
   * THRESHOLD ON THE RAW RATIO, ROUND ONLY TO DISPLAY. Rounding first put the
   * decision on the wrong side of the boundary it exists to guard: a projection
   * at 100.3% rounds to 100, `100 > 100` is false, and a row that IS over budget
   * rendered with the quiet under-budget treatment. The one case this styling
   * exists for is the case it dropped. (External review, 2026-08-07.)
   */
  const ratio = Number(proj) / Number(b)
  return ratio > 1 ? Math.round(ratio * 100) : null
})
</script>

<template>
  <span class="inline-block text-right tabular-nums text-[12px]" data-testid="budget-state-cell">
    <template v-if="consumed != null">
      <span class="font-semibold" :class="TEXT_CLASS[state]" data-testid="budget-state-consumed">
        {{ fmtPct(consumed) }}
      </span>
      <span class="text-carbon-3"> of {{ fmtUsd(budgetUsd!) }}</span>
    </template>
    <span v-else-if="hasBudgetConcept" class="text-carbon-3 italic">no budget set</span>
    <!-- Not "no budget set": this row has nothing a budget could be set ON. -->
    <span v-else class="text-carbon-3" aria-label="not applicable">—</span>

    <!--
      THE PACE LINE CARRIES ITS OWN SEVERITY. It used to render at one weight
      whatever it said, so "~$962.50 by Aug 31" against a $203.21 budget — 474%
      of it — was set in the same 11px grey as a pace that lands comfortably. The
      alarming fact and the mundane one were typographically identical, and the
      alarming one was the third clause of three.
      A projection over budget is now a FIGURE, not a clause: the multiple leads,
      the money follows.
    -->
    <span
      v-if="projectedUsd != null && projectedOverPct != null"
      class="block text-[13px] font-semibold text-rag-red"
      style="font-variant-numeric: tabular-nums"
      data-testid="budget-state-pace-over"
    >{{ projectedOverPct }}% projected
      <span class="block text-[11px] font-normal text-carbon-3"
      >~{{ fmtUsd(projectedUsd) }} by {{ monthEnd || 'month end' }}</span>
    </span>
    <span
      v-else-if="projectedUsd != null"
      class="block text-[11px] font-normal text-carbon-3"
      style="font-variant-numeric: tabular-nums"
      data-testid="budget-state-pace"
    >on pace for ~{{ fmtUsd(projectedUsd) }} by {{ monthEnd || 'month end' }}</span>
  </span>
</template>
