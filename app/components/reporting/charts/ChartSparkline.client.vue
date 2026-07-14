<script setup lang="ts">
/*
 * ChartSparkline — tiny inline trend for KPI tiles (ECharts, SVG).
 *
 * No axes, grid, legend, or tooltip: it is a de-emphasised shape that supports
 * the number beside it, not a chart you read values off. Decorative for AT
 * (aria-hidden) — the KPI value carries the data. Defaults to the magnitude hue.
 */
import { computed } from 'vue'
import { useChartTheme } from './useChartTheme'

const props = withDefaults(
  defineProps<{
    data: number[]
    color?: string
    /** Fill under the line as a faint wash. */
    area?: boolean
    smooth?: boolean
    height?: number
  }>(),
  { color: undefined, area: true, smooth: true, height: 32 },
)

const { magnitudeColor } = useChartTheme()

const hasData = computed(() => props.data.length >= 2)

const option = computed<ECOption>(() => {
  const color = props.color || magnitudeColor()
  return {
    animationDuration: 400,
    grid: { top: 2, right: 2, bottom: 2, left: 2 },
    xAxis: {
      type: 'category',
      show: false,
      boundaryGap: false,
      data: props.data.map((_, i) => i),
    },
    yAxis: { type: 'value', show: false, scale: true },
    series: [
      {
        type: 'line',
        data: props.data,
        showSymbol: false,
        smooth: props.smooth,
        silent: true,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        ...(props.area ? { areaStyle: { color, opacity: 0.15 } } : {}),
      },
    ],
  }
})
</script>

<template>
  <ClientOnly>
    <VChart
      v-if="hasData"
      :option="option"
      :style="{ height: `${height}px`, width: '100%' }"
      autoresize
      aria-hidden="true"
      data-testid="chart-sparkline"
    />
    <template #fallback>
      <div :style="{ height: `${height}px` }" class="w-full" aria-hidden="true" />
    </template>
  </ClientOnly>
</template>
