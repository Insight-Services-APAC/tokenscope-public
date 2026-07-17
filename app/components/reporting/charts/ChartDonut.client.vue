<script setup lang="ts">
/*
 * ChartDonut — composition donut with a centre total (ECharts, SVG).
 *
 * The centre carries the headline (`centerValue` over `centerLabel`); the ring
 * is the composition. Slice colours default to the DATAVIZ provider split when
 * the slice name is a tool (Claude=hunger, Copilot=vision, Other=carbon-3) and
 * honour an explicit `color` otherwise. A 2px surface ring between segments is
 * the gap (dataviz marks-and-anatomy). Identity also lives in the HTML legend
 * beside the ring, so it is never colour-alone.
 */
import { computed } from 'vue'
import { useChartTheme } from './useChartTheme'
import { escapeHtml } from './chart-utils'

export interface DonutSlice {
  name: string
  value: number
  /** Colour key (a registry lane id / laned tool) — preferred over fuzzy-matching
   *  the display `name` (lane-visuals V1: one colour system app-wide). */
  key?: string
  /** Explicit slice colour; when absent, resolved from `key` (else the name). */
  color?: string
}

const props = withDefaults(
  defineProps<{
    slices: DonutSlice[]
    centerLabel?: string
    centerValue?: string
    /** Tooltip value formatter. Defaults to a plain number. */
    valueFormat?: (v: number) => string
    height?: number
    /**
     * Render the per-card HTML legend (default). Pages that carry ONE page-level
     * LaneLegend (lane-visuals V1 item 5 — cards render NO legends there) pass
     * false; identity then lives in the page legend + tooltips.
     */
    legend?: boolean
  }>(),
  {
    centerLabel: undefined,
    centerValue: undefined,
    valueFormat: undefined,
    height: 200,
    legend: true,
  },
)

const { baseOption, colorForKey, readVar } = useChartTheme()

const fmt = (v: number) => (props.valueFormat ? props.valueFormat(v) : String(v))

const shown = computed(() => props.slices.filter((s) => s.value > 0))
const total = computed(() => shown.value.reduce((a, s) => a + s.value, 0))
const hasData = computed(() => total.value > 0)

function sliceColor(s: DonutSlice): string {
  return s.color || colorForKey(s.key ?? s.name)
}

// HTML legend rows (text tokens; the swatch carries identity, never the text).
const legendRows = computed(() =>
  shown.value.map((s) => ({
    name: s.name,
    color: sliceColor(s),
    pct: total.value > 0 ? Math.round((s.value / total.value) * 100) : 0,
  })),
)

const option = computed<ECOption>(() => {
  const surface = readVar('--paper') || '#ffffff'
  const carbon = readVar('--carbon')
  const carbon3 = readVar('--carbon-3')
  const font = readVar('--font-sans')

  return {
    ...baseOption({ tooltipTrigger: 'item' }),
    grid: undefined,
    // Centre total via the GraphicComponent (TitleComponent is deliberately not
    // registered — the config ships `graphic` for exactly this overlay). Two
    // stacked text nodes: the value on the ring's centre line, the label just
    // below it.
    ...(props.centerValue || props.centerLabel
      ? {
          graphic: [
            {
              type: 'text',
              left: 'center',
              top: 'center',
              z: 10,
              style: {
                text: props.centerValue ?? '',
                fill: carbon,
                font: `700 18px ${font}`,
                textAlign: 'center',
                textVerticalAlign: 'middle',
              },
            },
            {
              type: 'text',
              left: 'center',
              top: '58%',
              z: 10,
              style: {
                text: props.centerLabel ?? '',
                fill: carbon3,
                font: `400 11px ${font}`,
                textAlign: 'center',
              },
            },
          ],
        }
      : {}),
    tooltip: {
      ...(baseOption({ tooltipTrigger: 'item' }).tooltip as Record<string, unknown>),
      formatter: (raw: unknown) => {
        const p = raw as { name?: string; value?: unknown; percent?: number; marker?: string }
        const v = typeof p.value === 'number' ? fmt(p.value) : ''
        const pct = typeof p.percent === 'number' ? ` · ${p.percent}%` : ''
        return (
          `${p.marker ?? ''}${escapeHtml(p.name ?? '')}` +
          `&nbsp;&nbsp;<b>${escapeHtml(v)}</b>${escapeHtml(pct)}`
        )
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['62%', '86%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: surface, borderWidth: 2, borderRadius: 4 },
        data: shown.value.map((s) => ({
          name: s.name,
          value: s.value,
          itemStyle: { color: sliceColor(s) },
        })),
      },
    ],
  }
})
</script>

<template>
  <div class="flex items-center gap-4" data-testid="chart-donut">
    <ClientOnly>
      <VChart
        v-if="hasData"
        :option="option"
        :style="{ width: `${height}px`, height: `${height}px`, flex: '0 0 auto' }"
        autoresize
        :aria-label="`Composition — ${centerValue ?? ''} ${centerLabel ?? ''}`.trim()"
        data-testid="chart-donut-svg"
      />
      <p v-else class="text-xs text-carbon-3 italic py-6" data-testid="chart-donut-empty">
        Nothing here yet.
      </p>
      <template #fallback>
        <div
          :style="{ width: `${height}px`, height: `${height}px` }"
          class="animate-pulse bg-calm-1/40 rounded-full shrink-0"
        />
      </template>
    </ClientOnly>

    <ul v-if="hasData && legend" class="space-y-1 min-w-0">
      <li
        v-for="l in legendRows"
        :key="l.name"
        class="flex items-center gap-1.5 text-[11px] text-carbon-2"
      >
        <span
          class="inline-block w-2 h-2 rounded-sm shrink-0"
          :style="{ background: l.color }"
          aria-hidden="true"
        />
        <span class="truncate">{{ l.name }}</span>
        <span class="text-carbon-3 shrink-0">{{ l.pct }}%</span>
      </li>
    </ul>
  </div>
</template>
