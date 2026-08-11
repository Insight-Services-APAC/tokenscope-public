<script setup lang="ts">
/*
 * ChartRankedBar — horizontal ranked bars (ECharts, SVG).
 *
 * Replaces the hand-rolled SVG RankedBars (and its black-bar bug). Rankings are
 * MAGNITUDE, not identity, so every bar wears the SAME single hue
 * (useChartTheme().magnitudeColor) with the value labelled at the bar end —
 * never a categorical colour cycle. Optional top-N collapse folds the tail into
 * an "Other" bar. Rows are clickable (emits `select` with the original row).
 *
 * OPTIONAL STACKED MODE (requirement 3 — "stacked teammate bars ... in the
 * shared DriversTable/ChartRankedBar path where feasible"): when at least one
 * row carries `segments` (e.g. a teammate row's per-surface breakdown), every
 * bar renders as a stack of its named segments instead of one magnitude hue.
 * A row with no segments (e.g. a topN-folded "Other" row) still renders — as
 * ONE segment in the magnitude hue spanning its full value — so folding never
 * produces a gap. Segment colours/labels are supplied by the caller (from the
 * shared registry helper, `useChartScale`'s `vendorLaneColor`/`VENDOR_LABELS` —
 * never invented here), so this component stays registry-agnostic. Tooltip
 * switches to an axis-trigger breakdown listing every segment + the row total
 * (accessible: the same figures are ALSO in the caller's data table, never
 * colour-alone).
 */
import { computed } from 'vue'
import { useChartTheme } from './useChartTheme'
import { escapeHtml } from './chart-utils'

export interface RankedRowSegment {
  /** Stacking + colour-lookup key (a registry lane id in practice). */
  key: string
  label: string
  value: number
  color: string
}

export interface RankedRow {
  label: string
  value: number
  /** Opaque passthrough returned on `select` (e.g. an id the caller drills on). */
  meta?: unknown
  /** Optional per-segment breakdown of `value` (requirement 3). Segment order
   *  is preserved (registry order, by the caller's convention); Σ segment
   *  values should equal `value` (not enforced here — the caller's contract). */
  segments?: RankedRowSegment[]
}

const props = withDefaults(
  defineProps<{
    rows: RankedRow[]
    /** x-axis maximum. Defaults to the largest row value. */
    max?: number
    /** Value formatter for the end label + tooltip. Defaults to a plain number. */
    valueFormat?: (v: number) => string
    /** When set, keep the top-N by value and fold the remainder into "Other". */
    topN?: number
    otherLabel?: string
    clickable?: boolean
    height?: number
  }>(),
  {
    max: undefined,
    valueFormat: undefined,
    topN: undefined,
    otherLabel: 'Other',
    clickable: false,
    height: undefined,
  },
)

const emit = defineEmits<{ select: [row: RankedRow] }>()

const { baseOption, magnitudeColor, readVar } = useChartTheme()

const fmt = (v: number) => (props.valueFormat ? props.valueFormat(v) : String(v))

// topN opts into ranking + "Other" collapse; without it, caller order is kept
// (mirrors the old RankedBars, which trusted the incoming order). The folded
// "Other" row carries no segments — it is a magnitude-only aggregate.
const displayRows = computed<RankedRow[]>(() => {
  const rows = props.rows
  if (!props.topN || rows.length <= props.topN) return rows
  const sorted = [...rows].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, props.topN)
  const tail = sorted.slice(props.topN)
  const otherValue = tail.reduce((a, r) => a + (r.value || 0), 0)
  return otherValue > 0
    ? [...head, { label: props.otherLabel, value: otherValue, meta: undefined }]
    : head
})

const hasData = computed(
  () => displayRows.value.length > 0 && displayRows.value.some((r) => r.value > 0),
)

// Stacked mode activates when ANY row carries a real segment breakdown.
const isStacked = computed(() => displayRows.value.some((r) => (r.segments?.length ?? 0) > 0))

// The union of segment keys across every row, in FIRST-SEEN order (the
// registry order the caller already sorted its own segments in — never
// re-sorted here, so a lane's stacking position never depends on which row
// happens to carry it). Scans through `rowSegments` (not raw `r.segments`) so
// an unsegmented row's synthetic fallback lane gets its OWN series too — a
// topN-folded "Other" row (or any caller row with no breakdown) must still
// render its full value, never silently vanish from every stacked series.
const segmentKeys = computed<{ key: string; label: string; color: string }[]>(() => {
  const color = magnitudeColor()
  const seen = new Map<string, { key: string; label: string; color: string }>()
  for (const r of displayRows.value) {
    for (const s of rowSegments(r, color)) {
      if (!seen.has(s.key)) seen.set(s.key, { key: s.key, label: s.label, color: s.color })
    }
  }
  return [...seen.values()]
})

// Bars need vertical room per row; derive a height when the caller doesn't fix one.
const resolvedHeight = computed(
  () => props.height ?? Math.max(96, displayRows.value.length * 34 + 16),
)

/** A row's segments — synthesised as ONE magnitude-hue segment when absent
 *  (a topN-folded "Other" row, or a caller that never opted into segments). */
function rowSegments(r: RankedRow, fallbackColor: string): RankedRowSegment[] {
  if (r.segments?.length) return r.segments
  return [{ key: '__unsegmented', label: r.label, value: r.value, color: fallbackColor }]
}

const option = computed<ECOption>(() => {
  const rows = displayRows.value
  const color = magnitudeColor()
  const carbon = readVar('--carbon')
  const carbon2 = readVar('--carbon-2')

  const yAxis = {
    type: 'category' as const,
    inverse: true, // rank 1 sits at the top
    data: rows.map((r) => r.label),
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: carbon2,
      fontSize: 12,
      width: 160,
      overflow: 'truncate' as const,
    },
  }
  const xAxis = {
    type: 'value' as const,
    max: props.max,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { show: false },
    splitLine: { show: false },
  }

  if (isStacked.value) {
    const keys = segmentKeys.value
    const series = keys.map((seg, i) => ({
      type: 'bar' as const,
      name: seg.label,
      stack: 'total',
      data: rows.map((r) => rowSegments(r, color).find((s) => s.key === seg.key)?.value ?? 0),
      barMaxWidth: 22,
      itemStyle: { color: seg.color },
      // Only the LAST series in the stack carries the end label — showing the
      // ROW TOTAL (not its own segment value), via a closure over `rows`.
      label:
        i === keys.length - 1
          ? {
              show: true,
              position: 'right' as const,
              color: carbon,
              fontSize: 12,
              formatter: (p: { dataIndex?: number }) => fmt(rows[p.dataIndex ?? -1]?.value ?? 0),
            }
          : { show: false },
      cursor: props.clickable ? 'pointer' : 'default',
      emphasis: { focus: 'series' as const },
    }))
    return {
      ...baseOption({ tooltipTrigger: 'axis' }),
      grid: { top: 8, right: 56, bottom: 8, left: 8, containLabel: true },
      tooltip: {
        ...(baseOption({ tooltipTrigger: 'axis' }).tooltip as Record<string, unknown>),
        formatter: (raw: unknown) => {
          const arr = Array.isArray(raw) ? raw : [raw]
          const first = arr[0] as { dataIndex?: number; name?: string }
          const row = rows[first?.dataIndex ?? -1]
          if (!row) return ''
          const segLines = rowSegments(row, color)
            .filter((s) => s.value !== 0)
            .map(
              (s) =>
                `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:4px"></span>` +
                `${escapeHtml(s.label)}&nbsp;&nbsp;<b>${escapeHtml(fmt(s.value))}</b>`,
            )
            .join('<br/>')
          return (
            `<b>${escapeHtml(row.label)}</b><br/>${segLines}` +
            `<br/><b>Total&nbsp;&nbsp;${escapeHtml(fmt(row.value))}</b>`
          )
        },
      },
      xAxis,
      yAxis,
      series,
    }
  }

  return {
    ...baseOption({ tooltipTrigger: 'item' }),
    grid: { top: 8, right: 56, bottom: 8, left: 8, containLabel: true },
    tooltip: {
      ...(baseOption({ tooltipTrigger: 'item' }).tooltip as Record<string, unknown>),
      formatter: (raw: unknown) => {
        const p = raw as { name?: string; value?: unknown; marker?: string }
        const v = typeof p.value === 'number' ? fmt(p.value) : ''
        return (
          `${p.marker ?? ''}${escapeHtml(p.name ?? '')}` +
          `&nbsp;&nbsp;<b>${escapeHtml(v)}</b>`
        )
      },
    },
    xAxis,
    yAxis,
    series: [
      {
        type: 'bar',
        data: rows.map((r) => r.value),
        barMaxWidth: 22,
        itemStyle: { color, borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: 'right',
          color: carbon,
          fontSize: 12,
          formatter: (p) => fmt(Number(p.value ?? 0)),
        },
        cursor: props.clickable ? 'pointer' : 'default',
        emphasis: { focus: 'self' },
      },
    ],
  }
})

function onClick(params: unknown) {
  if (!props.clickable) return
  const p = params as { componentType?: string; dataIndex?: number }
  if (p.componentType !== 'series') return
  const row = displayRows.value[p.dataIndex ?? -1]
  if (row) emit('select', row)
}
</script>

<template>
  <ClientOnly>
    <VChart
      v-if="hasData"
      :option="option"
      :style="{ height: `${resolvedHeight}px`, width: '100%' }"
      autoresize
      :aria-label="
        isStacked
          ? `Ranked bars, stacked by surface — ${displayRows.length} rows, top: ${displayRows[0]?.label ?? 'none'}`
          : `Ranked bars — ${displayRows.length} rows, top: ${displayRows[0]?.label ?? 'none'}`
      "
      data-testid="chart-ranked-bar"
      @click="onClick"
    />
    <p
      v-else
      class="text-xs text-carbon-3 italic py-8 text-center"
      data-testid="chart-ranked-bar-empty"
    >
      No data to rank yet.
    </p>
    <template #fallback>
      <div
        :style="{ height: `${resolvedHeight ?? 160}px` }"
        class="w-full animate-pulse bg-calm-1/40 rounded-lg"
      />
    </template>
  </ClientOnly>
</template>
