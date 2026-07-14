<script setup lang="ts">
/*
 * ChartRankedBar — horizontal ranked bars (ECharts, SVG).
 *
 * Replaces the hand-rolled SVG RankedBars (and its black-bar bug). Rankings are
 * MAGNITUDE, not identity, so every bar wears the SAME single hue
 * (useChartTheme().magnitudeColor) with the value labelled at the bar end —
 * never a categorical colour cycle. Optional top-N collapse folds the tail into
 * an "Other" bar. Rows are clickable (emits `select` with the original row).
 */
import { computed } from 'vue'
import { useChartTheme } from './useChartTheme'
import { escapeHtml } from './chart-utils'

export interface RankedRow {
  label: string
  value: number
  /** Opaque passthrough returned on `select` (e.g. an id the caller drills on). */
  meta?: unknown
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
// (mirrors the old RankedBars, which trusted the incoming order).
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

// Bars need vertical room per row; derive a height when the caller doesn't fix one.
const resolvedHeight = computed(
  () => props.height ?? Math.max(96, displayRows.value.length * 34 + 16),
)

const option = computed<ECOption>(() => {
  const rows = displayRows.value
  const color = magnitudeColor()
  const carbon = readVar('--carbon')
  const carbon2 = readVar('--carbon-2')

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
    xAxis: {
      type: 'value',
      max: props.max,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category',
      inverse: true, // rank 1 sits at the top
      data: rows.map((r) => r.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: carbon2,
        fontSize: 12,
        width: 160,
        overflow: 'truncate',
      },
    },
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
      :aria-label="`Ranked bars — ${displayRows.length} rows, top: ${displayRows[0]?.label ?? 'none'}`"
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
