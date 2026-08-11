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
 *
 * Headcount is a working-week signal too, and more sharply than spend: nobody is
 * active on a Sunday, so the raw daily line is a sawtooth that drops to near zero
 * twice a week. The daily line is kept faint under a bold 7-DAY TRAILING MEAN
 * (prototype fix 5), which is the line that answers "are more people using this".
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartTrend from '../charts/ChartTrend.client.vue'
import { TRAILING_MEAN_DAYS } from '../charts/chart-utils'
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
      empty-label="No Claude Code or Copilot CLI sessions in this window — this chart counts developers in those two lanes, so other surfaces' spend does not appear here."
      v-else
      :series="series"
      :value-format="devCount"
      :height="240"
      :trailing-mean-days="TRAILING_MEAN_DAYS"
    />

    <p class="mt-2 text-[11px] text-carbon-3 leading-snug">
      A developer active in both tools is counted in each line — the two are not additive.
    </p>
  </UiCard>
</template>
