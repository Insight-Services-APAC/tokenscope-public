<script setup lang="ts">
/*
 * ChargebackDowCard — the §B "when chargeback happens" card that REPLACES the §A
 * seasonality heatmap in chargeback mode. The bill lane has no ISO-week × dow grain
 * (it is per-teammate DAILY), so the §B read is the simpler seven-bucket day-of-week
 * total: Σ Anthropic chargeback (`v_finance_bill_chargeback`) per weekday over the
 * window. Copilot is absent (pooled, monthly).
 *
 * Rendered as magnitude ranked bars (Mon..Sun order preserved — the kit keeps caller
 * order when no top-N collapse is asked), the SAME single-hue treatment as the §B
 * chargeback-by-cost-centre / -region rankings. Shared by Across + Regional.
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartRankedBar from './charts/ChartRankedBar.client.vue'
import type { ChargeDowBucket } from '#shared/reports/types'

const props = defineProps<{
  buckets: ChargeDowBucket[]
  /** Inclusive window label echoed in the subtitle. */
  windowLabel?: string
}>()

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Keep the natural Mon..Sun order (not ranked) — ChartRankedBar preserves caller
// order without a top-N. Guard the label lookup so an unexpected dow can't blank a bar.
const barRows = computed(() =>
  props.buckets.map((b) => ({ label: DAY_LABELS[b.dow] ?? `Day ${b.dow}`, value: b.chargeUsd })),
)

function compactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
</script>

<template>
  <UiCard data-testid="chargeback-dow-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-carbon-1">When chargeback happens</div>
        <div class="text-[11px] text-carbon-3 truncate">
          Anthropic chargeback by day of week<template v-if="windowLabel"> · {{ windowLabel }}</template>
        </div>
      </div>
    </div>

    <ChartRankedBar :rows="barRows" :value-format="compactUsd" />

    <p class="mt-2 text-[11px] text-carbon-3 leading-snug" data-testid="chargeback-dow-caveat">
      Anthropic per-teammate chargeback · Copilot is pooled per cost-centre (monthly, see the cost-centre ranking).
    </p>
  </UiCard>
</template>
