<script setup lang="ts">
/*
 * TopModelsCard — "Top models by spend" (AEUF Cost-Analysis parity).
 *
 * A dedicated, always-model-axis ranked view (independent of the drivers-table
 * axis toggle) sourced from `/across-regions/drivers?axis=model`. Ranking is
 * MAGNITUDE, so ChartRankedBar wears the single magnitude hue with the $ at the
 * bar tip — never a categorical colour cycle.
 *
 * THE NULL-MODEL BUCKETS ARE NOT BARS (prototype note `fix 3`). They used to
 * arrive as ordinary rows in the same ranking, which let a row that is not a
 * model out-rank every model on a card called "Top models". `ModelSplitPanel` —
 * shared with the region card so both widths answer alike — ranks the models and
 * gives each bucket its own labelled group beneath.
 *
 * THE CAPTION STATES THE LANE IT MEASURED, from the response rather than from a
 * constant — see the identical note on TopDriversCard. In the chargeback lane
 * these bars are the provider's own per-model breakdown, and "By attributed
 * usage" would name the wrong relation.
 *
 * AND WHOSE SPEND IT IS. A per-MODEL charge is Anthropic's alone: Copilot raises
 * one pooled invoice per cost centre and reports no model on it, so "By billed
 * spend" over these bars was a whole-company claim about one provider's money.
 * The caption now carries the scope clause and the card renders the reason
 * underneath, both from the response's `chargebackCoverage`.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ModelSplitPanel from '../ModelSplitPanel.vue'
import { chargebackScopeClause } from '#shared/reports/types'
import type { AcrossDriversResp } from './across-view-types'

const props = defineProps<{
  /** The axis=model drivers response (own fetch), or null while loading. */
  models: AcrossDriversResp | null
  /** When set (custom-range mode), discloses the month these model rows reflect. */
  monthNote?: string | null
}>()

const isBilled = computed(() => props.models?.measureLanes?.rows === 'billed')
const scopeClause = computed(() => chargebackScopeClause(props.models?.chargebackCoverage))
const caption = computed(() =>
  isBilled.value
    ? `By billed spend, per the provider${scopeClause.value ? ` · ${scopeClause.value}` : ''}`
    : 'By attributed usage',
)
/** The unavailable-for-this-lane sentences, in the server's own words. */
const gaps = computed(() => props.models?.chargebackCoverage?.gaps ?? [])
</script>

<template>
  <UiCard data-testid="across-top-models">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Top models</div>
      <div class="text-[11px] text-carbon-3" data-testid="across-top-models-lane">{{ caption }}</div>
    </div>
    <p
      v-if="monthNote"
      class="text-[11px] text-brand-heart bg-brand-hunger-lite rounded-md px-2.5 py-1 mb-3 inline-block"
    >
      {{ monthNote }}
    </p>

    <!-- Whose charge these bars are NOT, above them rather than under them. -->
    <div
      v-if="gaps.length"
      class="mb-3 rounded-md border border-calm-2 bg-calm-1/50 px-3 py-2"
      data-testid="across-top-models-gaps"
      role="note"
    >
      <p v-for="(g, i) in gaps" :key="i" class="text-[11px] leading-snug text-carbon-2">
        {{ g.reason }}
      </p>
    </div>

    <ModelSplitPanel
      :rows="models ? models.rows : null"
      :denominator-usd="models?.headlineUsd ?? null"
      :lane="models?.measureLanes?.rows ?? 'attributed'"
      :billed-lane="models?.billedLane"
      :top-n="8"
    />
  </UiCard>
</template>
