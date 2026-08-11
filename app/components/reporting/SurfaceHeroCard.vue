<script setup lang="ts">
/*
 * SurfaceHeroCard — "Where the AI spend goes": the usage-view composition
 * hero, rendered under the §A KPI strip on the Across + Regional usage views.
 *
 * Canonical §A USAGE basis ONLY (requirement 1 — `v_complete_usage`, weekly,
 * every surface native); one card, one basis (r1-F6), and now the SAME basis
 * as the KPI strip above it — the caption says so and the hero's totals sum
 * back to the SAME window's attributed-usage headline (test-pinned). This
 * REPLACES the former BILLED-showback basis (`v_finance_bill_showback`) that
 * fed this same hero while it was still labelled part of the usage view — the
 * "Surface Hero uses billed showback" mixed-lens defect this closes.
 *
 * ONE PANEL, NOT TWO. This card used to stack the absolute-$ bars over a
 * half-height 100%-share band of the SAME series. Two panels of one dataset
 * doubled the card's height and halved the read: a reader scanning the page met
 * the same weeks twice before reaching the next question. The $ panel stays —
 * it is the one that carries magnitude — and the share story is now told by the
 * TOTALS BAR beneath it, which is a single row rather than a second chart and
 * carries each lane's actual dollars next to its width (the prototype's
 * `weeklyChart(…) + laneLegend(…)` pair).
 *
 * The delta callout states BOTH the $ and the share movement of the non-Code
 * surfaces, computed from the UNFOLDED weekly cells (r1-F5) over the last
 * complete 4 weeks vs the prior 4 (r1-F4). The partial current week renders
 * lighter + dashed and is excluded from ranking/stats. The remainder is
 * labelled "Other surfaces (composition varies)"; its tooltip itemises each
 * week's exact composition (r2-1 disclosure).
 *
 * THE CARD NOW CARRIES ITS OWN LEGEND, and that is why the usage lens no longer
 * renders a page-level LaneLegend above the bands. The totals bar names every
 * lane in the bars AND states its window total, so it is strictly more than the
 * page legend it replaces — and it sits under the bars it names rather than
 * floating at the top of the page above two bands it did not describe.
 * Σ(slices) == the window total, cent-exact by construction (build-surface-hero).
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import ChartWeeklyLanes from './charts/ChartWeeklyLanes.client.vue'
import { useChartTheme } from './charts/useChartTheme'
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

/*
 * The totals bar: each lane's share of the window as a width, its dollars as the
 * label. Built from `built.donut.slices` — the SAME folded series as the bars
 * above, summed over the SAME window — so a lane can never appear in one and not
 * the other, and the widths cannot disagree with the heights.
 *
 * `colorForKey` is the app-wide resolution (registry lane id → its FIXED colour,
 * folded remainder → the neutral hue), the same function every other card and
 * chart resolves through, so this legend cannot drift from the bars' own hues.
 */
const { colorForKey } = useChartTheme()

const totalUsd = computed(() => props.built?.donut.totalUsd ?? 0)

const laneTotals = computed(() => {
  const total = totalUsd.value
  if (!props.built || total <= 0) return []
  return props.built.donut.slices.map((s) => ({
    lane: s.lane,
    label: s.label,
    usd: s.value,
    sharePct: s.value / total,
    colour: colorForKey(s.lane),
  }))
})
</script>

<template>
  <UiCard data-testid="surface-hero-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Where the AI spend goes</div>
      <div class="text-[11px] text-carbon-3" data-testid="surface-hero-basis">
        attributed usage · all surfaces · weekly<template v-if="windowLabel"> · {{ windowLabel }}</template>
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
      mode="usd"
      :in-progress-week="built.inProgressWeek"
      :remainder-items="built.remainderByWeek"
      :value-format="compactUsd"
    />

    <!-- The totals bar — this card's own legend, and the page's only one in the
         usage lens. Width = share of the window, label = the lane's actual
         dollars, so the composition and the magnitudes are one row rather than
         a second chart panel. -->
    <template v-if="built && hasData && laneTotals.length">
      <div class="flex h-4 rounded overflow-hidden mt-3" data-testid="surface-hero-totals-bar">
        <i
          v-for="l in laneTotals"
          :key="l.lane"
          class="block h-full"
          :style="{ width: `${(l.sharePct * 100).toFixed(1)}%`, background: l.colour }"
          :title="`${l.label} · ${fmtUsd(l.usd)} · ${fmtPct(l.sharePct)}`"
        />
      </div>
      <ul
        class="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 text-[11px] text-carbon-2 tabular-nums"
        data-testid="surface-hero-totals-legend"
      >
        <li
          v-for="l in laneTotals"
          :key="l.lane"
          class="flex items-center gap-1.5"
          :data-testid="`surface-hero-total-${l.lane}`"
        >
          <span
            class="inline-block w-2 h-2 rounded-sm shrink-0"
            :style="{ background: l.colour }"
            aria-hidden="true"
          />
          <span>{{ l.label }} {{ fmtUsd(l.usd) }}</span>
        </li>
      </ul>
    </template>

    <p
      v-else
      class="text-xs text-carbon-3 italic py-8 text-center"
      data-testid="surface-hero-empty"
    >
      No attributed usage in this window yet — the composition fills in as sessions land.
    </p>

    <!--
      BOTH TRAILING SENTENCES ARE GONE.

      "The current week is in progress — rendered lighter and excluded from the
      ranking and the delta" DESCRIBED ITS OWN ENCODING. A sentence cannot rescue
      a treatment that does not read; if the lighter week does read as in-progress
      it is noise, and if it does not, the encoding is the thing to fix. (It also
      still reads: the delta beside it names its own operand — "last complete 4
      weeks vs prior 4" — which is the part a reader cannot deduce, and that
      stays.) This is a different thing from a LEGEND: "bold = 7-day mean" names
      WHICH LINE IS WHICH; "rendered lighter" justifies a choice.

      "Attributed usage across every surface — the same lane as the KPIs above,
      over the window named in this band's header" was methodology, and its second
      half pointed at the band header — the band header exists precisely so cards
      stop restating their window. The card's own basis line at the top already
      reads "attributed usage · all surfaces · weekly · <window>".
    -->
  </UiCard>
</template>
