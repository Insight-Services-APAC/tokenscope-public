<script setup lang="ts">
/*
 * ChartsRankedBars — horizontal ranked bars (SVG, no chart dependency).
 *
 * Extraction of the practice-page inline flex-bar idiom (app/pages/practice/
 * [ouId].vue "Top models" / comparison) into a reusable primitive. Accessible
 * image house-idiom per build-design §7: `role="img"` + `aria-label` + a
 * per-bar `<title>`.
 *
 * `spendClass` tints informational (non-charge) rows distinctly from metered
 * spend — a Copilot `pooled-usage` bar must never read like a hard dollar.
 *
 * onSelect (optional) is a POINTER convenience for the ranked overview; the
 * keyboard/AT-accessible drill lives in the DriversTable, so keeping the SVG a
 * pure `role="img"` accessible image (rather than nesting interactive controls
 * inside it, which role=img would hide from AT) is deliberate.
 */
import { computed } from 'vue'
import { fmtUsd } from '../../composables/useFormat'
import type { SpendClass } from '#shared/reports/types'

export interface RankedBarRow {
  label: string
  value: number
  /** Optional short tag rendered beside the label (e.g. "pooled"). */
  badge?: string
  spendClass?: SpendClass
}

const props = withDefaults(
  defineProps<{
    rows: RankedBarRow[]
    /** Axis maximum. Defaults to the largest row value. */
    max?: number
    /** Value formatter. Defaults to `fmtUsd`. */
    format?: (v: number) => string
    /** Pointer-drill callback; when set, bars become clickable. */
    onSelect?: (row: RankedBarRow) => void
  }>(),
  { max: undefined, format: undefined, onSelect: undefined },
)

const W = 720
const ROW_H = 26
const LABEL_W = 200
const VALUE_W = 84
const PAD_R = 8
const trackX = LABEL_W + 8
const trackW = W - trackX - VALUE_W - PAD_R

const fmt = (v: number) => (props.format ? props.format(v) : fmtUsd(v))
const axisMax = computed(() => props.max ?? Math.max(0, ...props.rows.map((r) => r.value)))
const hasData = computed(() => props.rows.length > 0 && axisMax.value > 0)
const height = computed(() => props.rows.length * ROW_H)
const interactive = computed(() => typeof props.onSelect === 'function')

// spendClass → bar colour. Metered = brand; informational classes are muted so
// a share/pooled figure never reads as a hard charge.
function barColor(sc?: SpendClass): string {
  if (sc === 'pooled-usage') return 'var(--carbon-3)'
  if (sc === 'indicative') return 'var(--brand-vision)'
  return 'var(--brand-harmony)'
}
function truncate(s: string): string {
  return s.length > 26 ? `${s.slice(0, 25)}…` : s
}

interface Bar extends RankedBarRow {
  y: number
  w: number
  color: string
  short: string
}
const bars = computed<Bar[]>(() =>
  props.rows.map((r, i) => ({
    ...r,
    y: i * ROW_H,
    w: axisMax.value > 0 ? Math.max(0, (r.value / axisMax.value) * trackW) : 0,
    color: barColor(r.spendClass),
    short: truncate(r.label),
  })),
)

const ariaLabel = computed(
  () => `Ranked bars — ${props.rows.length} rows, top: ${props.rows[0]?.label ?? 'none'}`,
)

function select(row: RankedBarRow) {
  props.onSelect?.(row)
}
</script>

<template>
  <div data-testid="ranked-bars">
    <svg
      v-if="hasData"
      :viewBox="`0 0 ${W} ${height}`"
      class="w-full"
      role="img"
      :aria-label="ariaLabel"
    >
      <g
        v-for="b in bars"
        :key="b.label"
        :class="interactive ? 'cursor-pointer' : ''"
        @click="interactive && select(b)"
      >
        <title>{{ b.label }} — {{ fmt(b.value) }}{{ b.badge ? ` (${b.badge})` : '' }}</title>
        <text
          :x="0"
          :y="b.y + ROW_H / 2"
          dominant-baseline="middle"
          class="fill-carbon-2"
          font-size="12"
        >{{ b.short }}</text>
        <text
          v-if="b.badge"
          :x="LABEL_W"
          :y="b.y + ROW_H / 2"
          text-anchor="end"
          dominant-baseline="middle"
          class="fill-carbon-3"
          font-size="9"
        >{{ b.badge }}</text>
        <rect
          :x="trackX"
          :y="b.y + 5"
          :width="trackW"
          :height="ROW_H - 12"
          rx="3"
          class="fill-calm-1"
        />
        <rect
          :x="trackX"
          :y="b.y + 5"
          :width="b.w"
          :height="ROW_H - 12"
          rx="3"
          :fill="b.color"
        />
        <text
          :x="W - PAD_R"
          :y="b.y + ROW_H / 2"
          text-anchor="end"
          dominant-baseline="middle"
          class="fill-carbon-1 tabular-nums"
          font-size="12"
        >{{ fmt(b.value) }}</text>
      </g>
    </svg>
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center">No data to rank yet.</p>
  </div>
</template>
