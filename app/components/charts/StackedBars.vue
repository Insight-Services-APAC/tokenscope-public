<script setup lang="ts">
/*
 * ChartsStackedBars — daily stacked bars by category (model mix over time).
 * Sparse (day × key) input; dense padded run; consistent per-key colours
 * via the shared palette (cost-share order decided by the caller).
 *
 * HEIGHT IS A CSS FACT, NOT A VIEWBOX RATIO (F2/D12). The SVG used to carry
 * `viewBox="0 0 720 {height}"` with `class="w-full"` and nothing else, so its
 * DRAWN height was `containerWidth × height/720` — the `height` prop was an
 * aspect ratio wearing a pixel name. On the project page's ~1100px content
 * column that rendered Daily burn at ~245px, roughly twice the prototype's
 * fixed 150px, and it was wrong by a different amount at every width. The SVG
 * now takes its height in CSS px and stretches horizontally
 * (`preserveAspectRatio="none"`, the prototype's own idiom, D:239).
 *
 * WHICH IS WHY THE X LABELS LEFT THE SVG. Under a non-uniform stretch, text
 * inside the viewBox would be stretched with it. The three day labels render as
 * HTML positioned by percentage — the same positions, in ink that cannot
 * distort. Nothing else in this chart is text.
 */
import { computed } from 'vue'
import { niceMax, seriesColor } from '../../composables/useChartScale'
import { dayAxis } from '#shared/reports/day-axis'

const props = withDefaults(
  defineProps<{
    /** Sparse rows; keys appear in first-seen order unless keyOrder given. */
    rows: Array<{ day: string; key: string; value: number }>
    /**
     * Preferred stacking ORDER. It is not a filter (external review): a key
     * present in `rows` but absent from `keyOrder` is appended, never dropped.
     *
     * This used to be `keys = keyOrder ?? firstSeen`, so anything the caller's
     * ordering did not name lost its band SILENTLY — money out of a money chart
     * with nothing on screen saying so. The project page hit it exactly: its
     * order came from the PAGE-window model mix while the series is the burn
     * card's own TRAILING window, so a model that ran 20 days ago and not this
     * month simply vanished from the bars.
     */
    keyOrder?: string[]
    /** Maps a raw key to its display label (e.g. model id → "Fable 5"). */
    labelFor?: (key: string) => string
    windowDays: number
    height?: number
    /**
     * Format a segment value for the tooltip. Additive — defaults to the
     * original `$X.XX` behaviour, so existing call sites are unchanged. Pass a
     * non-currency formatter (e.g. tokens / credits) to retire the `$` hardwire.
     */
    format?: (v: number) => string
    /**
     * Last day of the axis (`YYYY-MM-DD`, UTC) — the SETTLED edge
     * (`clock.settledThrough`) or the caller's own window end. REQUIRED (F1/D5):
     * it used to DEFAULT TO THE BROWSER'S TODAY, which zero-filled a day the
     * server refuses to claim and drew it as a collapse. There is no default now,
     * because a default is a second clock.
     */
    endDay: string
    /**
     * The still-filling day (`clock.today`), drawn FADED beyond `endDay` — the
     * prototype's "today partial" treatment (W3 D27.3, prototype :691). Admitted
     * only when it is genuinely beyond the edge AND carries data: an empty
     * partial day is silence, not a zero. The legend states it so a low final bar
     * reads as "not finished", never as a drop.
     */
    partialDay?: string | null
    /**
     * Keys that are drawn in the stack but are NOT categories of the axis this
     * chart's legend names — the reason-typed remainders (F2/D13). "Copilot
     * day-grain money" sitting between "opus-5" and "sonnet-5" with a legend dot
     * reads as a model name; it is the opposite, a bucket for money the provider
     * reports with NO model. The money stays in the bars (conservation is not
     * negotiable); the key moves to a footer in the coverage register the model
     * panel already uses, with its swatch, so the band is still identifiable.
     */
    remainderKeys?: string[]
  }>(),
  {
    height: 160,
    keyOrder: undefined,
    labelFor: undefined,
    format: undefined,
    partialDay: null,
    remainderKeys: () => [],
  },
)

// Default preserves the pre-existing `$X.XX` tooltip output byte-for-byte.
const fmtVal = (v: number) => (props.format ? props.format(v) : `$${v.toFixed(2)}`)

const W = 720
/* `bottom` was 30 to reserve room for the in-SVG day labels. They are HTML now,
 * below the box, so the bars get that space back rather than the chart drawing
 * a fifth of itself as blank. */
const PAD = { top: 10, right: 8, bottom: 6, left: 46 }

// The caller's order first, then any key the rows carry that it did not name —
// in first-seen order, so an unnamed key is ranked but never lost.
const keys = computed(() => {
  const out = [...(props.keyOrder ?? [])]
  for (const r of props.rows) if (!out.includes(r.key)) out.push(r.key)
  return out
})

const byDay = computed(() => {
  const m = new Map<string, Map<string, number>>()
  for (const r of props.rows) {
    const inner = m.get(r.day) ?? new Map<string, number>()
    inner.set(r.key, (inner.get(r.key) ?? 0) + r.value)
    m.set(r.day, inner)
  }
  return m
})
/*
 * The axis: `windowDays` settled days ending at `endDay`, plus the still-filling
 * day beyond it when it genuinely carries rows. `dayAxis` is the SAME shaper
 * TrendArea uses, so the two primitives cannot disagree about which days exist.
 */
const axis = computed(() =>
  dayAxis({
    endDay: props.endDay,
    days: props.windowDays,
    partialDay: props.partialDay,
    presentDays: byDay.value.keys(),
  }),
)
const dense = computed(() =>
  axis.value.days.map((day) => ({ day, m: byDay.value.get(day) ?? new Map<string, number>() })),
)

const max = computed(() =>
  niceMax(Math.max(...dense.value.map((d) => [...d.m.values()].reduce((a, b) => a + b, 0)), 0)),
)
const hasData = computed(() => max.value > 0 && props.rows.length > 0)

const innerW = computed(() => W - PAD.left - PAD.right)
const innerH = computed(() => props.height - PAD.top - PAD.bottom)
const slot = computed(() => innerW.value / Math.max(1, dense.value.length))
const barW = computed(() => Math.max(2, slot.value * 0.7))

interface Seg {
  day: string
  key: string
  x: number
  y: number
  h: number
  color: string
  value: number
}
const segments = computed<Seg[]>(() => {
  const out: Seg[] = []
  dense.value.forEach((d, i) => {
    let acc = 0
    keys.value.forEach((k, ki) => {
      const v = d.m.get(k) ?? 0
      if (v <= 0) return
      const h = (v / max.value) * innerH.value
      acc += h
      out.push({
        day: d.day,
        key: k,
        x: PAD.left + i * slot.value + (slot.value - barW.value) / 2,
        y: PAD.top + innerH.value - acc,
        h,
        color: seriesColor(ki),
        value: v,
      })
    })
  })
  return out
})

/* Positioned as a PERCENTAGE of the box: the horizontal stretch is linear, so a
 * viewBox x maps to `x / W` of the rendered width whatever that width is. */
const xLabels = computed(() => {
  const d = dense.value
  if (!d.length) return []
  return [0, Math.floor(d.length / 2), d.length - 1].map((i) => ({
    leftPct: ((PAD.left + i * slot.value + slot.value / 2) / W) * 100,
    label: d[i]!.day.slice(5),
  }))
})

/*
 * The palette index is the key's position in `keys` — the SAME index `segments`
 * colours by — so splitting the row into two registers can never re-colour a
 * band. The legend names CATEGORIES; a reason-typed remainder is not one (D13).
 */
const entries = computed(() => keys.value.map((k, ki) => ({ key: k, color: seriesColor(ki) })))
const legendEntries = computed(() => entries.value.filter((e) => !props.remainderKeys.includes(e.key)))
/** Summed over the DRAWN days only — a footer figure the bars do not show would
 *  be a second window hiding inside a caption. */
const remainderEntries = computed(() =>
  entries.value
    .filter((e) => props.remainderKeys.includes(e.key))
    .map((e) => ({
      ...e,
      total: dense.value.reduce((a, d) => a + (d.m.get(e.key) ?? 0), 0),
    }))
    .filter((e) => e.total > 0),
)
const display = (k: string) => (props.labelFor ? props.labelFor(k) : k)
// The "today partial" hint reads the SAME admission decision that shaped the
// axis — re-deriving it is how a key ends up claiming a treatment the chart did
// not apply.
const partialOnAxis = computed(() => axis.value.partialDay != null)
</script>

<template>
  <div data-testid="stacked-bars">
    <svg
      v-if="hasData"
      :viewBox="`0 0 ${W} ${height}`"
      preserveAspectRatio="none"
      :style="{ height: `${height}px` }"
      class="block w-full"
      role="img"
      aria-label="Stacked daily breakdown"
    >
      <rect
        v-for="(s, i) in segments"
        :key="i"
        :x="s.x" :y="s.y" :width="barW" :height="s.h"
        :fill="s.color" rx="1"
        :fill-opacity="s.day === partialDay ? 0.45 : undefined"
        :data-partial="s.day === partialDay ? 'true' : undefined"
      >
        <title>{{ s.day }} · {{ display(s.key) }} — {{ fmtVal(s.value) }}</title>
      </rect>
    </svg>
    <!-- The day labels, in HTML: see the header note on the stretch. -->
    <div v-if="hasData" class="relative h-3.5" data-testid="stacked-bars-x-labels">
      <span
        v-for="l in xLabels"
        :key="l.label"
        class="absolute -translate-x-1/2 text-[9px] text-carbon-3 whitespace-nowrap"
        :style="{ left: `${l.leftPct.toFixed(2)}%` }"
      >{{ l.label }}</span>
    </div>
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center">No data in this window yet.</p>
    <div v-if="hasData" class="flex flex-wrap gap-x-4 gap-y-1 mt-1 px-1">
      <span
        v-for="e in legendEntries"
        :key="e.key"
        class="inline-flex items-center gap-1.5 text-[10px] text-carbon-2"
      >
        <span class="inline-block w-2 h-2 rounded-sm" :style="{ background: e.color }" aria-hidden="true" />
        {{ display(e.key) }}
      </span>
      <span
        v-if="partialOnAxis"
        class="ml-auto text-[10px] text-carbon-3 italic"
        title="drawn faded until the day completes"
        data-testid="stacked-bars-partial-note"
      >today partial</span>
    </div>
    <!-- The coverage register (D13): in the bars, named here, never a legend
         entry that reads as another category. -->
    <p
      v-if="hasData && remainderEntries.length"
      class="mt-1.5 px-1 text-[10px] leading-snug text-carbon-3"
      data-testid="stacked-bars-remainder-note"
    >
      In the bars, not a model:<span v-for="e in remainderEntries" :key="e.key">
        <span
          class="inline-block w-2 h-2 rounded-sm align-middle mx-1"
          :style="{ background: e.color }"
          aria-hidden="true"
        />{{ fmtVal(e.total) }} {{ display(e.key) }}</span>
    </p>
  </div>
</template>
