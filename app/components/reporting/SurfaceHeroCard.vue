<script setup lang="ts">
/*
 * SurfaceHeroCard — "Where the AI spend goes" (lane-visuals iter-2 I1): the
 * usage-view composition hero, rendered under the §A KPI strip on the Across +
 * Regional usage views.
 *
 * BILLED basis ONLY (`v_finance_bill_showback`, weekly, GitHub §A tools
 * firewalled out server-side) — one card, one basis (r1-F6); the caption says
 * so ("billed usage · all surfaces · weekly") and no figure here is ever
 * summed with a §A number. Two stacked panels share one weekly x-axis: the
 * absolute-$ stack above, the SAME series as a half-height 100%-share band
 * below (absolute + share together, so a share shift can never invert the
 * dollar story — r1-F3).
 *
 * The delta callout states BOTH the $ and the share movement of the non-Code
 * surfaces, computed from the UNFOLDED weekly cells (r1-F5) over the last
 * complete 4 weeks vs the prior 4 (r1-F4). The partial current week renders
 * lighter + dashed and is excluded from ranking/stats. The remainder is
 * labelled "Other surfaces (composition varies)"; its tooltip itemises each
 * week's exact composition (r2-1 disclosure).
 *
 * The card renders NO legend: the page-level LaneLegend (union incl. these
 * lanes) carries identity (V1 item 5).
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartWeeklyLanes from './charts/ChartWeeklyLanes.client.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import { heroHasData, type BuiltSurfaceHero } from './build-surface-hero'

const props = defineProps<{
  built: BuiltSurfaceHero | null
  /** Window label echoed in the subtitle (the hero's shared weekly window). */
  windowLabel?: string
}>()

const hasData = computed(() => heroHasData(props.built))
const delta = computed(() => props.built?.delta ?? null)

/** "non-Code $X/wk, up N% MoM · share S%, up P pts" — both axes stated (r1-F3). */
const deltaText = computed(() => {
  const d = delta.value
  if (!d) return null
  const dir = (v: number) => (v >= 0 ? 'up' : 'down')
  const mom =
    d.nonCodeMomPct == null
      ? ''
      : `, ${dir(d.nonCodeMomPct)} ${fmtPct(Math.abs(d.nonCodeMomPct))} MoM`
  const pts =
    d.nonCodeShareDeltaPts == null
      ? ''
      : `, ${dir(d.nonCodeShareDeltaPts)} ${(Math.abs(d.nonCodeShareDeltaPts) * 100).toFixed(1)} pts`
  return (
    `Non-Code surfaces ${fmtUsd(d.nonCodeAvgWeekUsd)}/wk${mom}` +
    ` · share ${fmtPct(d.nonCodeSharePct)}${pts}`
  )
})

function compactUsd(v: number): string {
  const a = Math.abs(v)
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (a >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}
</script>

<template>
  <UiCard data-testid="surface-hero-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Where the AI spend goes</div>
      <div class="text-[11px] text-carbon-3" data-testid="surface-hero-basis">
        billed usage · all surfaces · weekly<template v-if="windowLabel"> · {{ windowLabel }}</template>
      </div>
    </div>

    <p
      v-if="deltaText"
      class="text-[12px] text-carbon-2 mb-2"
      data-testid="surface-hero-delta"
    >
      {{ deltaText }} <span class="text-carbon-3">(last complete 4 weeks vs prior 4)</span>
    </p>

    <ChartWeeklyLanes
      v-if="built && hasData"
      :weeks="built.weeks"
      :series="built.series"
      :share-series="built.shareSeries"
      mode="dual"
      :in-progress-week="built.inProgressWeek"
      :remainder-items="built.remainderByWeek"
      :value-format="compactUsd"
    />
    <p
      v-else
      class="text-xs text-carbon-3 italic py-8 text-center"
      data-testid="surface-hero-empty"
    >
      No billed showback in this window yet — the composition fills in as provider bills land.
    </p>

    <p
      v-if="built?.inProgressWeek"
      class="mt-2 text-[11px] text-carbon-3 italic"
      data-testid="surface-hero-partial-note"
    >
      The current week is in progress — rendered lighter and excluded from the ranking and the delta.
    </p>
    <p class="mt-2 text-[11px] text-carbon-3 leading-snug" data-testid="surface-hero-caveat">
      Billed showback across every Anthropic surface (top panel $, bottom panel 100% share) —
      never summed with the attributed telemetry figures in the KPIs above.
    </p>
  </UiCard>
</template>
