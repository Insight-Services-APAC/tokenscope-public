<script setup lang="ts">
/*
 * TopDriversCard — the axis-switchable whole-company drivers ranked view + table.
 *
 * The axis toggle (region / practice / teammate / model) is DriversTable's own
 * built-in select — re-used, not duplicated — and re-pivots the fetch upstream.
 * A ChartRankedBar sits above the table as the magnitude read (top 10, "Other"
 * folded), while the DriversTable keeps the precise per-row shares + the sum-back
 * check row. (Concentration + Top-models sit alongside in the View's right rail.)
 *
 * On the region axis a row drill navigates to that region's Regional scope
 * (bubbled to the container); other axes have no scope to drill into.
 *
 * Endpoint note: `/across-regions/drivers` is anchored to a MONTH here (the CSV
 * export is month-only, so screen + export stay byte-identical), so in custom-range
 * mode `monthNote` discloses which month these rows reflect.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartRankedBar from '../charts/ChartRankedBar.client.vue'
import DriversTable, { type AxisOption } from '../DriversTable.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { DriverRow } from '#shared/reports/types'
import type { AcrossDriversResp } from './across-view-types'

const props = defineProps<{
  drivers: AcrossDriversResp | null
  axis: string
  /** When set (custom-range mode), discloses the month the drivers reflect. */
  monthNote?: string | null
}>()

const emit = defineEmits<{
  'update:axis': [axis: string]
  /** A region row was drilled — the region_id to navigate to. */
  drill: [regionId: string]
}>()

const AXIS_OPTIONS: AxisOption[] = [
  { value: 'teammate', label: 'Teammate' },
  { value: 'region', label: 'Region' },
  { value: 'practice', label: 'Practice' },
  { value: 'model', label: 'Model' },
]

const barRows = computed(() =>
  (props.drivers?.rows ?? []).map((r) => ({ label: r.label, value: r.usd, meta: r.key })),
)

// Only region rows carry a real drill target; the NULL bucket key is synthetic.
function drillKey(key: string) {
  if (props.axis === 'region' && !key.startsWith('__null')) emit('drill', key)
}
function onBarSelect(row: { meta?: unknown }) {
  if (typeof row.meta === 'string') drillKey(row.meta)
}
function onRowDrill(row: DriverRow) {
  drillKey(row.key)
}
</script>

<template>
  <UiCard data-testid="across-drivers-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Top drivers</div>
      <div class="text-[11px] text-carbon-3">What is driving whole-company spend</div>
    </div>
    <p
      v-if="monthNote"
      class="text-[11px] text-brand-heart bg-brand-hunger-lite rounded-md px-2.5 py-1 mb-3 inline-block"
      data-testid="across-drivers-month-note"
    >
      {{ monthNote }}
    </p>

    <div v-if="drivers" class="mb-4">
      <ChartRankedBar
        :rows="barRows"
        :top-n="10"
        :value-format="(v) => fmtUsd(v)"
        clickable
        @select="onBarSelect"
      />
    </div>

    <DriversTable
      v-if="drivers"
      :rows="drivers.rows"
      :headline-usd="drivers.headlineUsd"
      :axis="axis"
      :axis-options="AXIS_OPTIONS"
      denominator-label="company usage"
      @update:axis="emit('update:axis', $event)"
      @drill="onRowDrill"
    />
    <p v-else class="text-xs text-carbon-3 italic py-8 text-center">Loading drivers…</p>
  </UiCard>
</template>
