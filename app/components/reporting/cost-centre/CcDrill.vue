<script setup lang="ts">
/*
 * CcDrill — the per-cost-centre §A USAGE BURN drill (the SAME lane as the budget
 * tracker's card burn: `v_complete_usage WHERE cost_owning_unit_id`). Reached by
 * selecting a row in the tracker; it answers "WHO/WHAT is burning this budget?" and
 * reconciles to the tracker row — including a spender whose current placement has
 * moved (§A homes by emit-time cost_owning_unit_id, so they never vanish).
 *
 * Built to the reporting design language + the branded chart kit: a burn headline
 * (framed against the CC allocation when set), a "Burn by vendor" donut over the §A
 * vendor split (Claude = magenta, Copilot = blue — but Copilot pooled rows carry a
 * NULL cost-owning unit and are excluded here, so the split is usually ~100% Claude),
 * and the reused DriversTable (teammate | model) with a magnitude ranked-bar above.
 * The §B chargeback/billing for this cost centre lives in the Finance tab — NOT here.
 */
import { computed } from 'vue'
import ChartDonut from '../charts/ChartDonut.client.vue'
import ChartRankedBar from '../charts/ChartRankedBar.client.vue'
import DriversTable, { type AxisOption } from '../DriversTable.vue'
import ProviderFreshnessBar from '../ProviderFreshnessBar.vue'
import ExportCsvButton from '../ExportCsvButton.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { CostCentreDrill } from './cost-centre-view-types'

const props = defineProps<{
  drill: CostCentreDrill
  driversAxis: string
  drillExportParams: Record<string, string | number | boolean | null | undefined>
  drillExportFilename: string
}>()

const emit = defineEmits<{
  clearDrill: []
  'update:driversAxis': [axis: string]
}>()

const DRILL_AXIS_OPTIONS: AxisOption[] = [
  { value: 'teammate', label: 'Teammate' },
  { value: 'model', label: 'Model' },
]

// Provider-split slices — named so colorForKey resolves the validated hues
// (Claude = brand-hunger magenta, GitHub Copilot = brand-vision blue, Other = carbon-3).
const vendorSlices = computed(() => {
  const v = props.drill.vendor
  return [
    { name: 'Claude', value: v.claudeUsd },
    { name: 'GitHub Copilot', value: v.copilotUsd },
    { name: 'Other', value: v.otherUsd },
  ].filter((s) => s.value > 0)
})

const driverBars = computed(() => props.drill.rows.map((r) => ({ label: r.label, value: r.usd })))

const hasAllocation = computed(() => props.drill.allocationUsd > 0)

// Allocation set but zero burn — the $0 is "nothing tagged here", not "no data".
const zeroBurnTagged = computed(() => hasAllocation.value && props.drill.burnUsd === 0)
</script>

<template>
  <div data-testid="cc-drill-data" class="space-y-6">
    <!-- Breadcrumb -->
    <nav class="text-[12px] text-carbon-3" aria-label="Breadcrumb" data-testid="cc-drill-crumb">
      <button type="button" class="font-semibold hover:text-brand-harmony hover:underline" @click="emit('clearDrill')">
        Cost centres
      </button>
      <span class="mx-1.5">›</span>
      <span class="text-carbon-1 font-semibold">{{ drill.cc.displayName }}</span>
      <span class="text-carbon-3"> · {{ drill.cc.regionCode.toUpperCase() }}</span>
    </nav>

    <p class="text-[11px] text-carbon-3 italic" data-testid="cc-drill-lane-note">
      Burn = usage on projects <span class="font-semibold not-italic">homed to this cost centre</span> —
      <span class="font-semibold not-italic">not</span> a person's total usage. A teammate below can spend far
      more elsewhere (their own view shows their full spend); here they count only what they tagged to
      <span class="font-semibold not-italic">this</span> cost centre's projects. What this unit gets
      cross-charged is a different number — see the Finance tab.
    </p>

    <!-- Burn headline (§A usage axis — matches the tracker row) -->
    <div
      class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0"
      data-testid="cc-burn-headline"
    >
      <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3">Burn</span>
      <span class="text-[26px] leading-none font-bold tracking-[-0.5px] tabular-nums text-carbon">
        {{ fmtUsd(drill.burnUsd) }}
      </span>
      <span v-if="hasAllocation" class="text-[12px] text-carbon-2">
        of <span class="font-semibold tabular-nums">{{ fmtUsd(drill.allocationUsd) }}</span> allocated
      </span>
      <span v-else class="text-[12px] text-carbon-3">no budget set for this cost centre</span>
      <span v-if="zeroBurnTagged" class="text-[11px] text-carbon-3 italic" data-testid="cc-drill-no-tagged">
        no tagged usage — burn counts only project-tagged usage
      </span>
    </div>

    <ProviderFreshnessBar :providers="drill.meta.providerStates" />

    <!-- Burn-by-vendor donut (Copilot pooled NULL-CoU is excluded — usually ~100% Claude) -->
    <section
      v-if="vendorSlices.length"
      class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] p-5"
      data-testid="cc-drill-donut"
    >
      <div class="text-sm font-semibold text-carbon-1 mb-1">Burn by vendor</div>
      <p class="text-[11px] text-carbon-3 mb-3">
        Copilot pooled usage carries no cost-owning unit, so it is out of scope for the per-cost-centre burn.
      </p>
      <ChartDonut
        :slices="vendorSlices"
        :center-value="fmtUsd(drill.burnUsd)"
        center-label="burn"
        :value-format="(v) => fmtUsd(v)"
      />
    </section>

    <!-- Drivers (magnitude bar + reused table) — who/what is burning the budget -->
    <section class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] p-5 space-y-4">
      <div class="text-sm font-semibold text-carbon-1">Drivers</div>
      <p class="text-[11px] text-carbon-3 -mt-2" data-testid="cc-drill-drivers-note">
        Each driver's spend <span class="font-semibold">on this cost centre's projects</span>, not their total usage.
      </p>
      <ChartRankedBar v-if="driverBars.length" :rows="driverBars" :top-n="10" :value-format="(v) => fmtUsd(v)" />
      <DriversTable
        :rows="drill.rows"
        :headline-usd="drill.headlineUsd"
        :axis="driversAxis"
        :axis-options="DRILL_AXIS_OPTIONS"
        :denominator-label="drill.denominatorLabel"
        @update:axis="emit('update:driversAxis', $event)"
      />
    </section>

    <div class="flex justify-end">
      <ExportCsvButton endpoint="/api/v1/reports/export" :params="drillExportParams" :filename="drillExportFilename" />
    </div>
  </div>
</template>
