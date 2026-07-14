<script setup lang="ts">
/*
 * TopModelsCard — "Top models by spend" (AEUF Cost-Analysis parity).
 *
 * A dedicated, always-model-axis ranked view (independent of the drivers-table
 * axis toggle) sourced from `/across-regions/drivers?axis=model`. Ranking is
 * MAGNITUDE, so ChartRankedBar wears the single magnitude hue with the $ at the
 * bar tip — never a categorical colour cycle. The NULL-model bucket arrives as an
 * explicit "unattributed" row so the composition still sums back to genuine.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartRankedBar from '../charts/ChartRankedBar.client.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { AcrossDriversResp } from './across-view-types'

const props = defineProps<{
  /** The axis=model drivers response (own fetch), or null while loading. */
  models: AcrossDriversResp | null
  /** When set (custom-range mode), discloses the month these model rows reflect. */
  monthNote?: string | null
}>()

const rows = computed(() =>
  (props.models?.rows ?? []).map((r) => ({ label: r.label, value: r.usd })),
)
</script>

<template>
  <UiCard data-testid="across-top-models">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Top models</div>
      <div class="text-[11px] text-carbon-3">By attributed usage</div>
    </div>
    <p
      v-if="monthNote"
      class="text-[11px] text-brand-heart bg-brand-hunger-lite rounded-md px-2.5 py-1 mb-3 inline-block"
    >
      {{ monthNote }}
    </p>

    <ChartRankedBar
      v-if="models"
      :rows="rows"
      :top-n="8"
      :value-format="(v) => fmtUsd(v)"
    />
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center">Loading models…</p>
  </UiCard>
</template>
