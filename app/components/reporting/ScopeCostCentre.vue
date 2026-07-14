<script setup lang="ts">
/*
 * ScopeCostCentre — the DATA CONTAINER for the Cost-Centre reporting scope
 * (build-design §3, Wave 3). Owns the fetches (`/reports/cost-centres{,/[ccId]}`)
 * and the URL state (via useReportState — the sole owner of month/cc), then hands
 * everything to the pure ScopeCostCentreView tree. The presentational states +
 * the two distinct on-track mechanics are unit-tested on the view.
 *
 * Fetches are client-only + reactive: the grid refetches on month change; the
 * drill fetches on `cc` / month / axis change (the URL is the source of truth for
 * scope; axis is table-local).
 */
import { computed, ref, watch } from 'vue'
import ScopeCostCentreView from './ScopeCostCentreView.vue'
import { useReportState } from '../../composables/useReportState'
import type { CostCentreReport, CostCentreDrill } from './cost-centre/cost-centre-view-types'

const rs = useReportState()

// The drivers axis is table-local (not URL state). Reset when entering/leaving a
// drill so a stale axis can't survive a cost-centre change.
const axis = ref('teammate')
watch(
  () => rs.cc.value,
  () => {
    axis.value = 'teammate'
  },
)

// The grid AND the §A burn DRILL window on the SAME active period: a custom
// `from`/`to` range when present (both win over `month` server-side), else the
// `month`. Keeping them in lock-step means the drill headline reconciles to the
// tracker card burn in EVERY mode (This month / Last month / This quarter / Custom).
function windowParams(): Record<string, string> {
  if (rs.from.value && rs.to.value) return { from: rs.from.value, to: rs.to.value }
  if (rs.month.value) return { month: rs.month.value }
  return {}
}
const gridQuery = computed(windowParams)

const {
  data: report,
  pending,
  error,
} = useFetch<CostCentreReport>('/api/v1/reports/cost-centres', {
  query: gridQuery,
  key: 'reports-cost-centres',
  lazy: true,
  server: false,
})

// The drill is a per-`cc` resource — fetch imperatively so a null `cc` never fires
// a request to a placeholder id (and a foreign/unowned `cc` surfaces its 403 here).
const drill = ref<CostCentreDrill | null>(null)
const drillPending = ref(false)
const drillError = ref<unknown>(null)
watch(
  [() => rs.cc.value, () => rs.month.value, () => rs.from.value, () => rs.to.value, axis],
  async () => {
    const cc = rs.cc.value
    if (!cc) {
      drill.value = null
      drillError.value = null
      drillPending.value = false
      return
    }
    drillPending.value = true
    drillError.value = null
    try {
      const q: Record<string, string> = { axis: axis.value, ...windowParams() }
      drill.value = await $fetch<CostCentreDrill>(`/api/v1/reports/cost-centres/${cc}`, { query: q })
    } catch (e) {
      drillError.value = e
      drill.value = null
    } finally {
      drillPending.value = false
    }
  },
  { immediate: true },
)

// Exports window on the SAME active period as the screen (byte-identical rule).
const exportParams = computed(() => ({ scope: 'cost-centre', report: 'cards', ...windowParams() }))
// Range-aware slug so a quarter/custom export names the window (not "current") and
// two different ranges never collide on one filename.
const windowSlug = computed(() =>
  rs.from.value && rs.to.value ? `${rs.from.value}_${rs.to.value}` : (rs.month.value ?? 'current'),
)
const exportFilename = computed(() => `tokenscope-cost-centres-${windowSlug.value}.csv`)

const drillExportParams = computed(() => {
  const p: Record<string, string> = { scope: 'cost-centre', report: 'drivers', axis: axis.value, ...windowParams() }
  if (rs.cc.value) p.cc = rs.cc.value
  return p
})
const drillExportFilename = computed(
  () => `tokenscope-cost-centre-drivers-${axis.value}-${windowSlug.value}.csv`,
)
</script>

<template>
  <ScopeCostCentreView
    :report="report ?? null"
    :drill="drill"
    :is-drill="Boolean(rs.cc.value)"
    :pending="pending"
    :error="error"
    :drill-pending="drillPending"
    :drill-error="drillError"
    :drivers-axis="axis"
    :lane="rs.lane.value"
    :export-params="exportParams"
    :export-filename="exportFilename"
    :drill-export-params="drillExportParams"
    :drill-export-filename="drillExportFilename"
    @drill="rs.patch({ cc: $event })"
    @clear-drill="rs.patch({ cc: null })"
    @update:drivers-axis="axis = $event"
  />
</template>
