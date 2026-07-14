<script setup lang="ts">
/*
 * ActiveUsersTrendCard — "Active developers over time" (the AEUF-exceed: how many
 * devs are on EACH tool as a TREND, not just a point KPI).
 *
 * Two provider series (Claude Code = hunger magenta, GitHub Copilot = vision blue,
 * keyed by tool code via ChartTrend.colorForKey) over the same rolling/custom
 * window the spend trend uses. Counts, not dollars — the axis + tooltip format as
 * whole developers. The two series are NOT additive (a teammate active in both
 * tools counts in both), so this is deliberately two lines, never a stacked total.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartTrend from '../charts/ChartTrend.client.vue'
import type { TrendSeries } from './build-trend'
import type { ActiveTrend } from '#shared/reports/types'

const props = defineProps<{
  active: ActiveTrend | null
  /** Window label echoed in the subtitle (rolling window or custom range). */
  windowLabel?: string
}>()

const series = computed<TrendSeries[]>(() => {
  const pts = props.active?.series ?? []
  return [
    { name: 'Claude Code', key: 'claude-code', data: pts.map((p) => ({ x: p.day, y: p.claudeCode })) },
    { name: 'GitHub Copilot', key: 'copilot-cli', data: pts.map((p) => ({ x: p.day, y: p.copilot })) },
  ]
})

/** Whole developers — the y-axis is a headcount, never fractional. */
function devCount(v: number): string {
  return String(Math.round(v))
}
</script>

<template>
  <UiCard data-testid="across-active-trend-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-carbon-1">Active developers over time</div>
        <div class="text-[11px] text-carbon-3 truncate">
          Distinct developers per tool, per day<template v-if="windowLabel"> · {{ windowLabel }}</template>
        </div>
      </div>
    </div>

    <p v-if="!active" class="text-xs text-carbon-3 italic py-8 text-center">Loading developer activity…</p>
    <ChartTrend
      v-else
      :series="series"
      :value-format="devCount"
      :height="240"
    />

    <p class="mt-2 text-[11px] text-carbon-3 leading-snug">
      A developer active in both tools is counted in each line — the two are not additive.
    </p>
  </UiCard>
</template>
