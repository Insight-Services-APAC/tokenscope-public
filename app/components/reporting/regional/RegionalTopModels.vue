<script setup lang="ts">
/*
 * RegionalTopModels — the region's top models by spend (ChartRankedBar).
 *
 * A magnitude read of `/reports/regional/drivers?axis=model`: a SINGLE-hue ranked
 * bar (top 10, tail folded into "Other") with the $ labelled at the bar end —
 * never a categorical colour cycle (a ranking is magnitude, not identity). Models
 * have no scope to drill into, so the bars are not clickable.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartRankedBar from '../charts/ChartRankedBar.client.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { DriverRow } from '#shared/reports/types'

const props = defineProps<{ rows: DriverRow[] | null }>()

const barRows = computed(() =>
  (props.rows ?? []).map((r) => ({ label: r.label, value: r.usd, meta: r.key })),
)
</script>

<template>
  <UiCard data-testid="regional-top-models">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Top models</div>
      <div class="text-[11px] text-carbon-3">Model spend across the region · usage lane</div>
    </div>
    <div class="mt-3">
      <ChartRankedBar
        v-if="rows"
        :rows="barRows"
        :top-n="10"
        :value-format="(v) => fmtUsd(v)"
      />
      <p v-else class="text-xs text-carbon-3 italic py-8 text-center">Loading models…</p>
    </div>
  </UiCard>
</template>
