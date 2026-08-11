<script setup lang="ts">
/*
 * RegionalSignals — a compact "Signals" strip for velocity-flagged teammates.
 *
 * Teammates whose current-week usage spikes over their 4-week baseline by ≥ the
 * governance dial. This IS a status read (over the dial), so RAG is appropriate
 * and reserved-for-status here: a spike ≥ 2× the dial reads `over` (red), else
 * `warn` (amber) — via a UiBadge, with the signed delta as the label. The delta
 * itself is neutral text; only the status pill carries RAG.
 */
import UiCard from '../../ui/Card.vue'
import UiBadge from '../../ui/Badge.vue'
import DrillName from '../DrillName.vue'
import { teammateDrillTarget, NO_DRILL_GRANTS, type DrillFrame, type DrillGrants } from '../drill-contract'
import { fmtUsd, signedPct } from '../../../composables/useFormat'

interface Exception {
  teammateId: string
  name: string
  currentWeekUsd: number
  baselineMeanUsd: number
  deltaPct: number
  /*
   * THE TWO DRILL FACTS (D34), server-carried by `fetchRegionalExceptions` via
   * `server/reporting/teammate-drill-facts.ts`. Both OPTIONAL only so a test
   * fixture or an older payload degrades to PLAIN TEXT — the `=== true` reads
   * below are what make an absent fact fail CLOSED, and they are the whole
   * reason the fields are not read as booleans directly.
   */
  isActive?: boolean
  /**
   * `teammate.provisional` — the conjunct this strip was missing (r5-H1). A
   * shadow identity is ACTIVE, so it satisfied every other conjunct and rendered
   * as a live link onto a page that 403s, under an unauthenticated email claim.
   */
  isProvisional?: boolean
}

const props = withDefaults(
  defineProps<{
    exceptions: Exception[]
    velocityThreshold: number
    /*
     * THE DRILL CONTRACT (D29, fix 7). A signals row names a person, so it is a
     * link or plain text BY GRANT — never a live-looking dead name. Both are
     * passed by the container rather than fetched here so a strip rendered in a
     * test, or on a surface with no frame, is plain text by default.
     */
    drillGrants?: DrillGrants
    drillFrame?: DrillFrame
  }>(),
  { drillGrants: () => NO_DRILL_GRANTS, drillFrame: () => ({ src: null }) },
)

function targetFor(e: Exception) {
  return teammateDrillTarget(
    props.drillGrants,
    {
      id: e.teammateId,
      // Passed through as-is: `teammateDrillTarget` fails closed on an absent
      // fact for every call site at once (r6-H1).
      isActive: e.isActive,
      isProvisional: e.isProvisional,
    },
    props.drillFrame,
  )
}

// ≥ 2× the dial → `over` (red); otherwise `warn` (amber). Both are already over.
function isOver(deltaPct: number): boolean {
  return deltaPct >= 2 * (props.velocityThreshold ?? 0.25)
}
</script>

<template>
  <UiCard data-testid="regional-signals">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Signals</div>
      <div class="text-[11px] text-carbon-3">Current-week usage over the 4-week baseline by ≥ the governance dial</div>
    </div>

    <ul class="mt-2 divide-y divide-calm-1">
      <li
        v-for="e in exceptions"
        :key="e.teammateId"
        class="flex items-center justify-between gap-3 py-2"
        data-testid="regional-signal-row"
      >
        <div class="min-w-0">
          <div class="text-sm truncate">
            <DrillName :target="targetFor(e)" :label="e.name" />
          </div>
          <div class="text-[11px] text-carbon-3 tabular-nums">
            {{ fmtUsd(e.currentWeekUsd) }} this week · {{ fmtUsd(e.baselineMeanUsd) }} baseline
          </div>
        </div>
        <UiBadge
          :kind="isOver(e.deltaPct) ? 'rag-red' : 'rag-amber'"
          :dot="isOver(e.deltaPct) ? 'red' : 'amber'"
        >{{ signedPct(e.deltaPct) }}</UiBadge>
      </li>
    </ul>
  </UiCard>
</template>
