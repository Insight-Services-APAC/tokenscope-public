<script setup lang="ts">
/*
 * ChartsStackedBars — daily stacked bars by category (model mix over time).
 * Sparse (day × key) input; dense padded run; consistent per-key colours
 * via the shared palette (cost-share order decided by the caller).
 */
import { computed } from 'vue'
import { niceMax, padDays, seriesColor } from '../../composables/useChartScale'

const props = withDefaults(
  defineProps<{
    /** Sparse rows; keys appear in first-seen order unless keyOrder given. */
    rows: Array<{ day: string; key: string; value: number }>
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
  }>(),
  { height: 160, keyOrder: undefined, labelFor: undefined, format: undefined },
)

// Default preserves the pre-existing `$X.XX` tooltip output byte-for-byte.
const fmtVal = (v: number) => (props.format ? props.format(v) : `$${v.toFixed(2)}`)

const W = 720
const PAD = { top: 10, right: 8, bottom: 30, left: 46 }

const keys = computed(() => {
  if (props.keyOrder?.length) return props.keyOrder
  const seen: string[] = []
  for (const r of props.rows) if (!seen.includes(r.key)) seen.push(r.key)
  return seen
})

const dense = computed(() => {
  const byDay = new Map<string, Map<string, number>>()
  for (const r of props.rows) {
    const m = byDay.get(r.day) ?? new Map<string, number>()
    m.set(r.key, (m.get(r.key) ?? 0) + r.value)
    byDay.set(r.day, m)
  }
  return padDays(
    [...byDay.entries()].map(([day, m]) => ({ day, m })),
    props.windowDays,
    (day) => ({ day, m: new Map<string, number>() }),
  )
})

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

const xLabels = computed(() => {
  const d = dense.value
  if (!d.length) return []
  return [0, Math.floor(d.length / 2), d.length - 1].map((i) => ({
    x: PAD.left + i * slot.value + slot.value / 2,
    label: d[i]!.day.slice(5),
  }))
})
const display = (k: string) => (props.labelFor ? props.labelFor(k) : k)
</script>

<template>
  <div data-testid="stacked-bars">
    <svg v-if="hasData" :viewBox="`0 0 ${W} ${height}`" class="w-full" role="img" aria-label="Stacked daily breakdown">
      <rect
        v-for="(s, i) in segments"
        :key="i"
        :x="s.x" :y="s.y" :width="barW" :height="s.h"
        :fill="s.color" rx="1"
      >
        <title>{{ s.day }} · {{ display(s.key) }} — {{ fmtVal(s.value) }}</title>
      </rect>
      <text
        v-for="l in xLabels"
        :key="l.x"
        :x="l.x" :y="height - 16"
        text-anchor="middle" class="fill-carbon-3" font-size="9"
      >{{ l.label }}</text>
    </svg>
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center">No data in this window yet.</p>
    <div v-if="hasData" class="flex flex-wrap gap-x-4 gap-y-1 mt-1 px-1">
      <span v-for="(k, ki) in keys" :key="k" class="inline-flex items-center gap-1.5 text-[10px] text-carbon-2">
        <span class="inline-block w-2 h-2 rounded-sm" :style="{ background: seriesColor(ki) }" aria-hidden="true" />
        {{ display(k) }}
      </span>
    </div>
  </div>
</template>
