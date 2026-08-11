<script setup lang="ts">
/*
 * SpendPerDeveloperCard — "Spend per active developer": the number that
 * separates hiring from behaviour
 * (docs/design/reporting-consolidation/04-prototype-delta.md §5).
 *
 * WHY THIS CARD EXISTS. Total spend rising tells you nothing on its own. If
 * per-head is flat, the line is headcount and there is no problem to solve; if
 * per-head is climbing on flat headcount, something changed in how people work
 * and THAT is the conversation. The product has shown the numerator (Spend
 * trend) and the denominator (Active developers) on two separate cards for
 * months and never divided them.
 *
 * THE THREE DELTAS ARE THE ANSWER, and they are not narrated. A flat line only
 * reads as an answer beside the headcount that produced it, so per-head, active
 * developers and total spend sit together and the reader draws the conclusion.
 * An earlier version also PRINTED that conclusion ("Both headcount and per-head
 * spend moved"), which is interpretation of two numbers already on screen —
 * deleted, with the methodology paragraph that followed it. All three are the
 * trailing 30 days against the 30 before, on the SAME series the chart draws, so
 * no figure here was computed over a different period from another.
 *
 * IT CREATES NO QUERY. `buildPerDeveloperSeries` divides two figures
 * `fetchDailyMetrics` already returns, and the CSV export calls the same
 * function — so the screen and the file cannot drift.
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartTrend, { type TrendSeries } from './charts/ChartTrend.client.vue'
import { TRAILING_MEAN_DAYS, trailingRatioMean } from './charts/chart-utils'
import { fmtUsd, signedPct } from '../../composables/useFormat'
import type { PerDeveloperDelta, PerDeveloperSeries } from '#shared/reports/per-developer'

const props = defineProps<{
  series: PerDeveloperSeries | null
  /** Window label echoed in the subtitle (rolling window or custom range). */
  windowLabel?: string
}>()

const trendSeries = computed<TrendSeries[]>(() => {
  const pts = props.series?.points ?? []
  /*
   * The 7-day line is a RATIO OF SUMS over seven CALENDAR days — Σ spend ÷ Σ
   * daily actives — not the mean of the daily ratios. It is computed here
   * rather than by the chart because only this card holds both sides, and both
   * sides are what make the window seven days wide even when a day inside it
   * has no denominator at all. It is also the basis the three deltas below use
   * (shared/reports/per-developer.ts), so the line and the figures agree.
   */
  const mean = trailingRatioMean(
    pts.map((p) => p.spendUsd),
    pts.map((p) => p.activeDevelopers),
    TRAILING_MEAN_DAYS,
  )
  return [
    {
      name: 'Per active developer',
      key: 'per-developer',
      // Days with NO active developer are omitted, so the line shows a GAP.
      // Plotting 0 there would claim spend-per-head collapsed, when in fact
      // there was no denominator at all.
      data: pts
        .filter((p) => p.perDeveloperUsd !== null)
        .map((p) => ({ x: p.day, y: p.perDeveloperUsd as number })),
      mean: pts
        .map((p, i) => ({ x: p.day, y: mean[i] }))
        .filter((p): p is { x: string; y: number } => p.y != null),
    },
  ]
})

/** The three deltas, in the order the prototype states them. */
const deltas = computed(() => {
  const d = props.series?.deltas
  if (!d) return null
  return [
    { label: 'per head', delta: d.perDeveloperUsd, format: (v: number) => fmtUsd(v) },
    {
      label: 'active developers',
      delta: d.activeDevelopers,
      format: (v: number) => v.toFixed(1),
    },
    { label: 'total spend', delta: d.totalSpendUsd, format: (v: number) => fmtUsd(v) },
  ]
})

/** Below this a delta is not a movement, and the tone stays neutral. */
const MOVED = 0.1

function toneOf(d: PerDeveloperDelta): string {
  if (d.deltaPct === null || Math.abs(d.deltaPct) < MOVED) return 'text-carbon-2'
  return d.deltaPct > 0 ? 'text-rag-amber' : 'text-rag-green'
}
</script>

<template>
  <UiCard data-testid="spend-per-developer-card">
    <div class="text-sm font-semibold text-carbon-1">Spend per active developer</div>
    <div class="text-[11px] text-carbon-3 mb-3">
      Daily attributed usage divided by developers active that day<template v-if="windowLabel">
        · {{ windowLabel }}</template
      >
    </div>

    <p v-if="!series" class="text-xs text-carbon-3 italic py-8 text-center">
      Loading per-developer spend…
    </p>

    <template v-else>
      <ChartTrend
        :series="trendSeries"
        :value-format="(v) => fmtUsd(v)"
        :height="200"
        :trailing-mean-days="TRAILING_MEAN_DAYS"
      />

      <div v-if="deltas" class="flex flex-wrap gap-x-6 gap-y-1 mt-3" data-testid="per-developer-deltas">
        <div v-for="d in deltas" :key="d.label" class="text-[11px] text-carbon-3">
          <span class="font-semibold tabular-nums mr-1.5" :class="toneOf(d.delta)">
            {{ d.delta.deltaPct === null ? 'n/a' : signedPct(d.delta.deltaPct) }}
          </span>
          <span>{{ d.label }}</span>
        </div>
      </div>
      <p v-else class="mt-3 text-[11px] text-carbon-3" data-testid="per-developer-no-deltas">
        Needs two full {{ series.deltaDays }}-day halves to compare.
      </p>

      <!-- NO VERDICT SENTENCE, and no methodology paragraph.

           "Both headcount and per-head spend moved" told the reader what two
           numbers directly above it already say — interpretation is the reader's,
           and the card's job was to put the two numbers side by side, which it
           does. The paragraph under it ("each point is that day's distinct active
           developers…", "the same basis as the deltas above…") was how the series
           is computed; that lives in this file's comments and in
           shared/reports/per-developer.ts.

           The legend ChartTrend renders ("bold = 7-day mean") stays: it names
           WHICH LINE IS WHICH, which a reader cannot deduce. -->
    </template>
  </UiCard>
</template>
