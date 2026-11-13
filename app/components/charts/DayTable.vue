<script setup lang="ts">
/*
 * ChartsDayTable — a day-grain chart's numbers as a table (#584, WCAG 1.1.1).
 *
 * The personal charts are SVGs whose values lived only in hover titles, which a
 * keyboard cannot reach. The chart primitives (StackedBars, TrendArea) render
 * this from THEIR OWN axis and values, so the table can never list a day or a
 * total the chart did not draw.
 *
 * Days are UTC provider days, read as "29 Oct" like the chart's axis (#610),
 * with the year when the table spans more than one year. A day bucket never
 * converts to the viewer's zone (CLAUDE.md, the clock). The CSV export keeps
 * `YYYY-MM-DD`. The still-filling day is labelled in words, not only by the
 * chart's faded bar.
 */
import { computed } from 'vue'
import { fmtUtcDay } from '../../composables/useFormat'

const props = defineProps<{
  /** The chart's axis, in order. */
  days: string[]
  /** One column per series, in the chart's order. Omit for a single-value chart. */
  columns: { key: string; label: string }[]
  /** value(day, key) for a series column; for a single-value chart, key is ''. */
  value: (day: string, key: string) => number
  /** The admitted still-filling day, if the chart drew one. */
  partialDay: string | null
  format: (v: number) => string
  caption: string
}>()

const multi = computed(() => props.columns.length > 1)
const withYear = computed(() => new Set(props.days.map((d) => d.slice(0, 4))).size > 1)
const rows = computed(() =>
  props.days.map((day) => {
    const cells = props.columns.map((c) => props.value(day, c.key))
    return {
      day,
      label: fmtUtcDay(day, { year: withYear.value }),
      cells,
      total: cells.reduce((a, b) => a + b, 0),
      partial: day === props.partialDay,
    }
  }),
)
</script>

<template>
  <div class="overflow-x-auto max-h-80 overflow-y-auto" data-testid="chart-day-table">
    <table class="w-full text-[12px]">
      <caption class="sr-only">{{ caption }}</caption>
      <thead class="sticky top-0 bg-white">
        <tr class="border-b border-calm-2">
          <th scope="col" class="text-left font-bold text-carbon-3 px-2 py-1.5 whitespace-nowrap">Day (UTC)</th>
          <th
            v-for="c in columns"
            :key="c.key"
            scope="col"
            class="text-right font-bold text-carbon-3 px-2 py-1.5 whitespace-nowrap"
          >{{ c.label }}</th>
          <th v-if="multi" scope="col" class="text-right font-bold text-carbon-3 px-2 py-1.5">Total</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-calm-1">
        <tr v-for="r in rows" :key="r.day" :data-testid="`chart-day-row-${r.day}`">
          <th scope="row" class="text-left font-normal text-carbon px-2 py-1 whitespace-nowrap tabular-nums">
            {{ r.label }}<span v-if="r.partial" class="text-carbon-3 italic" data-testid="chart-day-partial"> (still filling)</span>
          </th>
          <td v-for="(v, i) in r.cells" :key="i" class="text-right px-2 py-1 tabular-nums text-carbon-2">{{ format(v) }}</td>
          <td v-if="multi" class="text-right px-2 py-1 tabular-nums font-semibold text-carbon">{{ format(r.total) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
