<script setup lang="ts">
/*
 * ChartsTrendArea — daily spend area chart (SVG, no chart dependency,
 * brief §6.6). Sparse day series in; dense padded run rendered. Native
 * title tooltips per day point. Empty window → quiet empty state.
 */
import { computed } from 'vue'
import { niceMax, padDays } from '../../composables/useChartScale'
import { dayAxis } from '#shared/reports/day-axis'

const props = withDefaults(
  defineProps<{
    series: Array<{ day: string; cost_usd: string }>
    windowDays: number
    /**
     * Last day of the axis (`YYYY-MM-DD`, UTC) — the SETTLED edge
     * (`clock.settledThrough`) or the caller's own window `to`. REQUIRED (F1/D5):
     * this component used to anchor its run on the browser's today and pad that
     * still-filling day to a genuine `0`, which draws as a collapse rather than
     * as a day that is not finished.
     */
    endDay: string
    /**
     * The still-filling UTC day (`clock.today`). Drawn as a distinct marker
     * BEYOND `endDay`, and only when the series actually carries it — an empty
     * partial day is silence, not a zero. Excluded from the area/line shape.
     */
    partialDay?: string | null
    height?: number
    /**
     * Format a value (axis tick + point tooltip). Additive — when omitted, the
     * original `$`-prefixed behaviour is preserved exactly (axis: whole dollars
     * ≥ 10 else 2dp; tooltip: 2dp), so existing call sites are unchanged. Pass a
     * formatter to retire the `$` hardwire (e.g. tokens / credits).
     */
    format?: (v: number) => string
    /**
     * Empty-state sentence. Additive: omitted keeps a lane-neutral default.
     * Pass one wherever the chart draws a SINGLE lane, so an empty chart says
     * which lane is empty instead of denying spend the page is showing.
     */
    emptyLabel?: string
  }>(),
  { height: 160, format: undefined, partialDay: null, emptyLabel: undefined },
)

// Defaults reproduce the pre-existing output byte-for-byte per render site.
const fmtAxis = (v: number) =>
  props.format ? props.format(v) : v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`
const fmtPoint = (v: number) => (props.format ? props.format(v) : `$${v.toFixed(2)}`)

const W = 720
const PAD = { top: 10, right: 8, bottom: 22, left: 46 }

const rows = computed(() => props.series.map((s) => ({ day: s.day, value: Number(s.cost_usd) })))
/*
 * The SETTLED run — the shape the area and the line are drawn from. It stops at
 * `endDay`; the still-filling day is deliberately not part of it, so it cannot
 * dip the line.
 *
 * IT DOES SET THE AXIS, THOUGH, and this comment used to deny it (external
 * review): `max` below takes the partial value too. That is deliberate and it is
 * the same rule `StackedBars` follows — a scale computed without the partial day
 * would draw a big partial ABOVE the plot area, off the canvas, which is a
 * worse lie than a compressed trend. The scale covers everything drawn.
 * `chart-trend-mean.test.ts` pins it, so the two cannot drift apart again.
 */
const dense = computed(() =>
  padDays(rows.value, props.windowDays, props.endDay, (day) => ({ day, value: 0 })),
)
/*
 * The partial day, admitted only when it is genuinely beyond the settled edge
 * AND genuinely carries a row. `dayAxis` owns that decision so the marker and
 * the axis cannot disagree about whether today was drawn.
 */
const axis = computed(() =>
  dayAxis({
    endDay: props.endDay,
    days: props.windowDays,
    partialDay: props.partialDay,
    presentDays: rows.value.map((r) => r.day),
  }),
)
const partial = computed(() => {
  const p = axis.value.partialDay
  if (!p) return null
  const row = rows.value.find((r) => r.day === p)
  return row ? { day: p, value: row.value } : null
})
const max = computed(() =>
  niceMax(Math.max(...dense.value.map((d) => d.value), partial.value?.value ?? 0, 0)),
)
const hasData = computed(() => dense.value.some((d) => d.value > 0) || (partial.value?.value ?? 0) > 0)

const innerW = computed(() => W - PAD.left - PAD.right)
const innerH = computed(() => props.height - PAD.top - PAD.bottom)
/*
 * The x domain spans the settled run PLUS the partial day's slot when one was
 * admitted, so today sits BEYOND the settled edge rather than displacing a
 * settled day off the axis.
 */
const axisLen = computed(() => dense.value.length + (partial.value ? 1 : 0))
const x = (i: number) =>
  PAD.left + (axisLen.value <= 1 ? 0 : (i / (axisLen.value - 1)) * innerW.value)
const y = (v: number) => PAD.top + innerH.value * (1 - v / max.value)

const linePath = computed(() =>
  dense.value.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' '),
)
const areaPath = computed(
  () =>
    `${linePath.value} L${x(dense.value.length - 1).toFixed(1)},${(PAD.top + innerH.value).toFixed(1)} L${PAD.left},${(PAD.top + innerH.value).toFixed(1)} Z`,
)
const gridLines = computed(() => [0.25, 0.5, 0.75, 1].map((f) => ({ f, yv: y(max.value * f) })))
// First-of-window, mid, last labels keep the axis readable at 30 or 90 days
// (deduped — a 1–2 day window must not stack identical labels).
const xLabels = computed(() => {
  const d = dense.value
  if (!d.length) return []
  const idx = [...new Set([0, Math.floor(d.length / 2), d.length - 1])]
  return idx.map((i) => ({ i, label: d[i]!.day.slice(5) }))
})
</script>

<template>
  <div data-testid="trend-area">
    <svg v-if="hasData" :viewBox="`0 0 ${W} ${height}`" class="w-full" role="img" aria-label="Daily spend trend">
      <line
        v-for="g in gridLines"
        :key="g.f"
        :x1="PAD.left" :x2="W - PAD.right" :y1="g.yv" :y2="g.yv"
        stroke="var(--calm-2, #eee)" stroke-width="1"
      />
      <text
        v-for="g in gridLines"
        :key="'t' + g.f"
        :x="PAD.left - 6" :y="g.yv + 3"
        text-anchor="end" class="fill-carbon-3" font-size="9"
      >{{ fmtAxis(max * g.f) }}</text>
      <path :d="areaPath" fill="var(--brand-harmony)" opacity="0.10" />
      <path :d="linePath" fill="none" stroke="var(--brand-harmony)" stroke-width="2" />
      <g v-for="(d, i) in dense" :key="d.day">
        <circle v-if="d.value > 0" :cx="x(i)" :cy="y(d.value)" r="2.5" fill="var(--brand-harmony)">
          <title>{{ d.day }} — {{ fmtPoint(d.value) }}</title>
        </circle>
      </g>
      <!-- The still-filling day: hollow, faded, OFF the line (D4). It is not
           joined to the area path, so a day that is three hours old cannot read
           as a drop. -->
      <!--
        A TICK, NOT A CIRCLE. This was an r=2.5 circle, and the SVG scales
        non-uniformly (`w-full` against a fixed `height`), so it rendered as a
        stretched ellipse — a stray blob at the end of the line that nobody could
        name without hovering. A vertical tick is immune to that scaling by
        construction: it has no width to distort.
        It also says the right thing. The mark means "this day is still filling",
        which is a BOUNDARY, not a data point — a tick reads as an edge where a
        dot reads as another reading.
      -->
      <g v-if="partial" :data-partial-day="partial.day" data-testid="trend-area-partial">
        <line
          :x1="x(dense.length)" :x2="x(dense.length)"
          :y1="y(partial.value) - 4" :y2="y(partial.value) + 4"
          stroke="var(--brand-harmony)" stroke-width="1.5" stroke-opacity="0.55"
          stroke-linecap="round"
        />
        <title>{{ partial.day }} — {{ fmtPoint(partial.value) }} · still accruing</title>
      </g>
      <text
        v-for="l in xLabels"
        :key="l.i"
        :x="x(l.i)" :y="height - 6"
        text-anchor="middle" class="fill-carbon-3" font-size="9"
      >{{ l.label }}</text>
    </svg>
    <!--
      The default no longer promises SESSIONS. This chart draws OTel-observed
      spend, which is one lane; a person whose spend arrived as provider-recorded
      days has no session behind any of it, so "fills in as sessions land" told
      them to wait for something that is never coming — directly under a headline
      showing the money they had already spent. Callers that know their lane pass
      `emptyLabel` and name it.
    -->
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="trend-area-empty">
      {{ emptyLabel ?? 'No spend in this window yet.' }}
    </p>
    <p
      v-if="hasData && partial"
      class="text-[10px] text-carbon-3 italic mt-1 text-right"
      data-testid="trend-area-partial-note"
    >today partial — still accruing</p>
  </div>
</template>
