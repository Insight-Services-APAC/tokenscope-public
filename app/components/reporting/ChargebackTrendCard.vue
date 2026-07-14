<script setup lang="ts">
/*
 * ChargebackTrendCard — the §B day-grain chargeback trend that REPLACES the §A
 * spend-trend (usage) card in chargeback mode. A SINGLE Anthropic series
 * (`v_finance_bill_chargeback`, the per-teammate DAILY bill lane) over the selected
 * window — Copilot is ABSENT here (its chargeback is pooled per cost-centre,
 * MONTH-grained), so there is no second series and the caveat explains why.
 *
 * The series key is `claude-code` so ChartTrend's colorForKey paints it hunger
 * MAGENTA (Anthropic), reusing the validated brand hue. No run-rate tail: this is
 * the actual accrued bill, not a projection. Shared by Across + Regional.
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartTrend from './charts/ChartTrend.client.vue'
import type { ChargeDailyPoint } from '#shared/reports/types'

const props = defineProps<{
  series: ChargeDailyPoint[]
  /** Inclusive window label, e.g. "Last 60 days" / "2026-07-01 → 2026-07-31". */
  windowLabel?: string
}>()

// One Anthropic series; `key: 'claude-code'` resolves to the magenta hue in ChartTrend.
const trendSeries = computed(() => [
  {
    name: 'Anthropic',
    key: 'claude-code',
    data: props.series.map((d) => ({ x: d.day, y: d.chargeUsd })),
  },
])

/** Compact $ for axis/tooltip — bill sums run to thousands. */
function compactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
</script>

<template>
  <UiCard data-testid="chargeback-trend-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-carbon-1">Chargeback trend</div>
        <div class="text-[11px] text-carbon-3 truncate">
          Daily Anthropic chargeback<template v-if="windowLabel"> · {{ windowLabel }}</template>
        </div>
      </div>
    </div>

    <ChartTrend :series="trendSeries" :value-format="compactUsd" :height="300" />

    <p class="mt-2 text-[11px] text-carbon-3 leading-snug" data-testid="chargeback-trend-caveat">
      Anthropic per-teammate chargeback · Copilot is pooled per cost-centre (monthly, see the cost-centre ranking).
    </p>
  </UiCard>
</template>
