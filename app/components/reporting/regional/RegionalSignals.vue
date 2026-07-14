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
import { fmtUsd, signedPct } from '../../../composables/useFormat'

interface Exception {
  teammateId: string
  name: string
  currentWeekUsd: number
  baselineMeanUsd: number
  deltaPct: number
}

const props = defineProps<{
  exceptions: Exception[]
  velocityThreshold: number
}>()

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
          <div class="text-sm text-carbon-1 truncate">{{ e.name }}</div>
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
