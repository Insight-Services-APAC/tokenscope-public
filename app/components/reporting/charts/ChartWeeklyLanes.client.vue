<script setup lang="ts">
/*
 * ChartWeeklyLanes — stacked WEEKLY lane bars (ECharts, SVG), the kit chart
 * behind the usage-view composition hero and the weekly chargeback lane trend
 * (lane-visuals iter-2 I1/I2).
 *
 * Three modes:
 *   - 'dual'  — TWO stacked panels sharing ONE x-axis (I1): absolute-$ bars on
 *     top, the SAME series as a half-height 100%-share band below, so a share
 *     shift can never invert the dollar story (r1-F3).
 *   - 'usd'   — the absolute-$ stack alone (the chargeback '$' rendering).
 *   - 'share' — the 100%-share stack alone (the chargeback 'share %' rendering).
 *
 * PARTIAL current week (r1-F4): its bars render LIGHTER with a dashed outline
 * and the tooltip flags "in progress" — visible, never ranked.
 * REMAINDER disclosure (r2-1): when the folded remainder is hovered, the
 * tooltip itemises its exact per-week composition from `remainderItems`.
 *
 * Colours key off the lane REGISTRY via useChartTheme().colorForKey (identity
 * follows the lane id, never stack position). No in-chart legend: pages carry
 * ONE page-level LaneLegend (V1 item 5); identity = legend + tooltips.
 *
 * Client-only: `.client.vue` + <ClientOnly>, so ECharts never touches `window`
 * during SSR.
 */
import { computed } from 'vue'
import { useChartTheme } from './useChartTheme'
import { escapeHtml, shortDay } from './chart-utils'
import { FOLDED_LANE_ID } from './fold-lanes'
import type { WeeklyLaneSeries } from './weekly-lanes'

const props = withDefaults(
  defineProps<{
    /** Zero-filled ISO-week axis (Monday keys), ascending. */
    weeks: string[]
    /** Folded absolute-$ series (kept lanes + remainder last). */
    series: WeeklyLaneSeries[]
    /** The same series as per-week 100%-shares (percent units). */
    shareSeries?: WeeklyLaneSeries[]
    /** Panel layout — 'dual' (hero), 'usd' or 'share' (single stack). */
    mode?: 'dual' | 'usd' | 'share'
    /** The partial current week's Monday — rendered lighter + dashed. */
    inProgressWeek?: string | null
    /** Per-week remainder composition (weekStart → folded lanes' $) — tooltip
     *  itemisation for the `other-lanes` series (r2-1 disclosure). */
    remainderItems?: Record<string, Array<{ lane: string; label: string; usd: number }>>
    /** $ formatter for axis + tooltip. */
    valueFormat?: (v: number) => string
    height?: number
  }>(),
  {
    shareSeries: undefined,
    mode: 'usd',
    inProgressWeek: null,
    remainderItems: undefined,
    valueFormat: undefined,
    height: undefined,
  },
)

const { baseOption, colorForKey, readVar } = useChartTheme()

// ONE fixed left gutter for EVERY grid, no containLabel (iter2 review r1):
// containLabel sizes each panel's plot origin by its own y-label width, so the
// $ panel ("$1.2K") and the share panel ("100%") started at different x — the
// dual panels' bars didn't align vertically. A common explicit `left` pins both
// plot areas to the same origin; 48px fits the widest compact-USD / percent
// label at fontSize 10.
const GRID_LEFT = 56

const fmtUsdV = (v: number) => (props.valueFormat ? props.valueFormat(v) : String(v))
const fmtShare = (v: number) => `${v.toFixed(v % 1 === 0 ? 0 : 2)}%`

const isDual = computed(() => props.mode === 'dual')
const chartHeight = computed(() => props.height ?? (isDual.value ? 340 : 300))

const hasData = computed(
  () => props.weeks.length > 0 && props.series.some((s) => s.data.some((p) => p.y !== 0)),
)

/** Bar data for one series on one grid, with the partial week styled lighter + dashed. */
function barData(s: WeeklyLaneSeries, color: string) {
  const byX = new Map(s.data.map((p) => [p.x, p.y]))
  return props.weeks.map((w) => {
    const value = byX.get(w) ?? 0
    if (w !== props.inProgressWeek) return value
    return {
      value,
      itemStyle: { opacity: 0.45, borderColor: color, borderWidth: 1, borderType: 'dashed' as const },
    }
  })
}

const option = computed<ECOption>(() => {
  const carbon3 = readVar('--carbon-3')
  const calm = readVar('--calm')
  const calm2 = readVar('--calm-2')

  const activeMode = props.mode
  const shareAvailable = (props.shareSeries?.length ?? 0) > 0
  const showUsd = activeMode !== 'share'
  const showShare = (activeMode === 'dual' || activeMode === 'share') && shareAvailable

  const axisLabel = {
    color: carbon3,
    fontSize: 10,
    formatter: (v: string) => shortDay(v),
  }
  const grids: Record<string, unknown>[] = []
  const xAxes: Record<string, unknown>[] = []
  const yAxes: Record<string, unknown>[] = []
  const series: NonNullable<ECOption['series']> = []

  let gridIdx = -1
  if (showUsd) {
    gridIdx++
    // Dual mode: the $ panel takes the top ~58%; single mode fills the card.
    grids.push(
      showShare && activeMode === 'dual'
        ? { top: 8, right: 16, bottom: '44%', left: GRID_LEFT }
        : { top: 16, right: 16, bottom: 28, left: GRID_LEFT },
    )
    xAxes.push({
      type: 'category',
      gridIndex: gridIdx,
      data: props.weeks,
      axisLine: { lineStyle: { color: calm } },
      axisTick: { show: false },
      // In dual mode the SHARED x-axis labels render once, on the bottom panel.
      axisLabel: showShare && activeMode === 'dual' ? { show: false } : axisLabel,
      splitLine: { show: false },
    })
    yAxes.push({
      type: 'value',
      gridIndex: gridIdx,
      min: 0,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: carbon3, fontSize: 10, formatter: (v: number) => fmtUsdV(v) },
      splitLine: { lineStyle: { color: calm2, width: 1 } },
    })
    for (const s of props.series) {
      const color = colorForKey(s.key)
      series.push({
        name: s.name,
        type: 'bar',
        stack: 'usd',
        xAxisIndex: gridIdx,
        yAxisIndex: gridIdx,
        data: barData(s, color),
        itemStyle: { color },
        barMaxWidth: 36,
        emphasis: { focus: 'series' },
      })
    }
  }
  if (showShare) {
    gridIdx++
    grids.push(
      activeMode === 'dual'
        ? { top: '62%', right: 16, bottom: 28, left: GRID_LEFT }
        : { top: 16, right: 16, bottom: 28, left: GRID_LEFT },
    )
    xAxes.push({
      type: 'category',
      gridIndex: gridIdx,
      data: props.weeks,
      axisLine: { lineStyle: { color: calm } },
      axisTick: { show: false },
      axisLabel,
      splitLine: { show: false },
    })
    yAxes.push({
      type: 'value',
      gridIndex: gridIdx,
      min: 0,
      max: 100,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: carbon3, fontSize: 10, formatter: (v: number) => `${v}%` },
      splitLine: { lineStyle: { color: calm2, width: 1 } },
    })
    for (const s of props.shareSeries ?? []) {
      const color = colorForKey(s.key)
      series.push({
        name: s.name,
        type: 'bar',
        stack: 'share',
        xAxisIndex: gridIdx,
        yAxisIndex: gridIdx,
        data: barData(s, color),
        itemStyle: { color },
        barMaxWidth: 36,
        emphasis: { focus: 'series' },
      })
    }
  }

  // Tooltip composed from OUR data by week index (not the hovered grid alone):
  // one panel hovered → the whole week's $ AND share rows, remainder itemised.
  const shareByKeyWeek = new Map<string, number>()
  for (const s of props.shareSeries ?? []) {
    for (const p of s.data) shareByKeyWeek.set(`${s.key} ${p.x}`, p.y)
  }

  return {
    ...baseOption({ tooltipTrigger: 'axis' }),
    grid: grids as ECOption['grid'],
    xAxis: xAxes as ECOption['xAxis'],
    yAxis: yAxes as ECOption['yAxis'],
    tooltip: {
      ...(baseOption({ tooltipTrigger: 'axis' }).tooltip as Record<string, unknown>),
      formatter: (raw: unknown) => {
        const arr = (Array.isArray(raw) ? raw : [raw]) as Array<{ dataIndex?: number }>
        const idx = arr[0]?.dataIndex ?? -1
        const week = props.weeks[idx]
        if (!week) return ''
        const inProgress = week === props.inProgressWeek
        const head = `Week of ${escapeHtml(shortDay(week))}${inProgress ? ' · in progress' : ''}`
        const rows: string[] = []
        for (const s of props.series) {
          const y = s.data.find((p) => p.x === week)?.y ?? 0
          if (y === 0) continue
          const share = shareByKeyWeek.get(`${s.key} ${week}`)
          const marker = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorForKey(s.key)};margin-right:6px"></span>`
          rows.push(
            `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.6">` +
              `<span>${marker}${escapeHtml(s.name)}</span>` +
              `<b>${escapeHtml(fmtUsdV(y))}${share != null ? ` · ${escapeHtml(fmtShare(share))}` : ''}</b></div>`,
          )
          // r2-1 disclosure: the remainder itemises its exact composition this week.
          if (s.key === FOLDED_LANE_ID) {
            for (const item of props.remainderItems?.[week] ?? []) {
              rows.push(
                `<div style="display:flex;justify-content:space-between;gap:16px;line-height:1.5;padding-left:14px;color:${readVar('--carbon-3')}">` +
                  `<span>${escapeHtml(item.label)}</span>` +
                  `<span>${escapeHtml(fmtUsdV(item.usd))}</span></div>`,
              )
            }
          }
        }
        return `<div style="font-weight:600;margin-bottom:4px">${head}</div>${rows.join('')}`
      },
    },
    series,
  }
})
</script>

<template>
  <ClientOnly>
    <VChart
      v-if="hasData"
      :option="option"
      :style="{ height: `${chartHeight}px`, width: '100%' }"
      autoresize
      :aria-label="`Weekly lane stack — ${series.map((s) => s.name).join(', ')}`"
      data-testid="chart-weekly-lanes"
    />
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center" data-testid="chart-weekly-lanes-empty">
      No billed spend in this window yet — the chart fills in as bills land.
    </p>
    <template #fallback>
      <div :style="{ height: `${chartHeight}px` }" class="w-full animate-pulse bg-calm-1/40 rounded-lg" />
    </template>
  </ClientOnly>
</template>
