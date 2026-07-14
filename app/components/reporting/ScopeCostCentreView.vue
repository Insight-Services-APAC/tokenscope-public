<script setup lang="ts">
/*
 * ScopeCostCentreView — the Cost-Centre reporting scope, rebuilt as a ranked
 * BUDGET TRACKER (reporting-redesign wave B). Answers "which cost-centres are
 * burning fastest, and which are at budget risk?" — replacing the old card-wall
 * of near-identical "$X of no allocation / on track within budget" tiles.
 *
 * PURE + prop-driven (fetches + URL state live in the ScopeCostCentre container),
 * so every render state is unit-testable without a Nuxt runtime. Matches the
 * Across flagship's design language: a persistent header (title + ONE settling
 * chip + DateRangeControl), hairline KPI tiles, section cards, the branded chart
 * kit (never hand SVG), and the fixed provider palette (Claude = magenta, Copilot
 * = blue — never purple).
 *
 * The body renders exactly ONE of skeleton / error / empty / data — independently
 * for the GRID (no `cc`) and the DRILL (`cc` set). The header (with the date
 * control) persists across states so the range stays adjustable mid-fetch.
 *
 * ONE lane, end to end (§A completeness): the tracker's card burn AND the drill
 * both read the project-CoU USAGE axis (`v_complete_usage WHERE cost_owning_unit_id`),
 * so drilling a row shows WHO/WHAT is burning that budget and reconciles to the
 * tracker figure. The §B chargeback/billing for a cost centre lives in the Finance
 * tab — deliberately NOT duplicated here (CcDrill carries that note).
 */
import { computed } from 'vue'
import UiFetchErrorBanner from '../ui/FetchErrorBanner.vue'
import ReportSkeleton from './ReportSkeleton.vue'
import ReportEmpty from './ReportEmpty.vue'
import DateRangeControl from './DateRangeControl.vue'
import LaneToggle from './LaneToggle.vue'
import SettlingStateChip from './SettlingStateChip.vue'
import ExportCsvButton from './ExportCsvButton.vue'
import ChartRankedBar from './charts/ChartRankedBar.client.vue'
import CcKpiTile from './cost-centre/CcKpiTile.vue'
import CcBudgetTable from './cost-centre/CcBudgetTable.vue'
import CcDrill from './cost-centre/CcDrill.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import type { ReportLane } from '../../composables/useReportState'
import type { ProviderState } from '#shared/reports/types'
import type { CostCentreReport, CostCentreDrill } from './cost-centre/cost-centre-view-types'

const props = withDefaults(
  defineProps<{
    report: CostCentreReport | null
    drill: CostCentreDrill | null
    /** True while `?cc=` is set — the drill drives the four states, not the grid. */
    isDrill: boolean
    pending: boolean
    error?: unknown
    drillPending: boolean
    drillError?: unknown
    driversAxis: string
    /** The active lens — grid re-lenses burn (§A) ⇄ chargeback (§B); the burn drill stays §A. */
    lane?: ReportLane
    /** Grid export params (report=cards). */
    exportParams: Record<string, string | number | boolean | null | undefined>
    exportFilename: string
    /** Drill export params (report=drivers). */
    drillExportParams: Record<string, string | number | boolean | null | undefined>
    drillExportFilename: string
  }>(),
  { error: undefined, drillError: undefined, lane: 'usage' },
)

const isChargeback = computed(() => props.lane === 'chargeback')

const emit = defineEmits<{
  drill: [ccId: string]
  clearDrill: []
  'update:driversAxis': [axis: string]
}>()

// ── Grid: exactly one of skeleton / error / empty / data ─────────────────────
const gridSkeleton = computed(() => props.pending && !props.report)
const gridError = computed(() => Boolean(props.error))
const gridEmpty = computed(() => Boolean(props.report) && props.report!.cards.length === 0)
const gridData = computed(() => Boolean(props.report) && !gridError.value && !gridEmpty.value)

// ── Drill: exactly one of skeleton / error / empty / data ────────────────────
const drillSkeleton = computed(() => props.drillPending && !props.drill)
const drillErr = computed(() => Boolean(props.drillError))
const drillEmpty = computed(
  () => Boolean(props.drill) && props.drill!.burnUsd === 0 && props.drill!.rows.length === 0,
)
const drillData = computed(() => Boolean(props.drill) && !drillErr.value && !drillEmpty.value)

// ── Header: ONE consolidated settling chip (the §A usage lane clock) ─────────
const activeMeta = computed(() => (props.isDrill ? props.drill?.meta : props.report?.meta) ?? null)
const usageState = computed<ProviderState | null>(
  () => activeMeta.value?.providerStates.find((p) => p.vendor === 'usage') ?? null,
)
const pointInTime = computed(() => activeMeta.value?.pointInTimeDims ?? false)

// ── Summary strip (whole-scope rollup, computed server-side from the cards) ──
const summary = computed(() => props.report?.summary ?? null)
const ccCount = computed(() => props.report?.cards.length ?? 0)
const overallUtil = computed(() => {
  const s = summary.value
  if (!s || s.totalAllocationUsd <= 0) return null
  return s.totalBurnUsd / s.totalAllocationUsd
})
// §B total chargeback for the visible cards (chargeback-mode primary figure) —
// summed client-side from the per-card §B `chargeUsd`, NEVER mixed with the §A burn.
const totalChargeUsd = computed(() =>
  (props.report?.cards ?? []).reduce((a, c) => a + c.chargeUsd, 0),
)
// §B — copilot chargeback ON over a partial-month range → the pooled (monthly) Copilot net
// is withheld from every card's chargeUsd (never a partial slice). Caveat the omission
// rather than let the total silently read as if Copilot were folded in.
const copilotPartialMonth = computed(() => props.report?.copilotChargebackPartialMonth === true)

// ── Top magnitude bar — ranked by the ACTIVE lane's figure (burn §A ⇄ charge §B) ─
const burnerRows = computed(() =>
  (props.report?.cards ?? [])
    .map((c) => ({
      label: c.displayName,
      value: isChargeback.value ? c.chargeUsd : c.burnUsd,
      meta: c.id,
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value),
)
const showBurners = computed(() => burnerRows.value.length >= 2)

function onBurnerSelect(row: { meta?: unknown }) {
  if (typeof row.meta === 'string') emit('drill', row.meta)
}
</script>

<template>
  <div data-testid="scope-cost-centre">
    <!-- ── Header (persists across states) ─────────────────────────────────── -->
    <header class="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div class="min-w-0">
        <div class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">
          Reporting · Cost centres
        </div>
        <h2 class="text-2xl font-extrabold tracking-[-0.8px] text-carbon mt-0.5">Cost centres</h2>
        <div class="mt-2 flex items-center gap-3 flex-wrap">
          <SettlingStateChip
            v-if="usageState"
            :state="usageState.state"
            :horizon-date="usageState.settlesAt"
            data-testid="cc-settling"
          />
          <span v-if="pointInTime" class="text-[11px] text-carbon-3 italic">
            Usage dimensions as at emit (point-in-time)
          </span>
        </div>
      </div>

      <div class="flex items-start gap-4 flex-wrap shrink-0">
        <LaneToggle />
        <DateRangeControl />
      </div>
    </header>

    <!-- ═══════════════════ DRILL (`?cc=`) ═══════════════════ -->
    <template v-if="isDrill">
      <ReportSkeleton v-if="drillSkeleton" />
      <UiFetchErrorBanner v-else-if="drillErr" :error="drillError" />
      <ReportEmpty
        v-else-if="drillEmpty"
        headline="No burn for this cost centre and month yet."
        sub="As usage lands for the selected month, the burn and who is driving it appear here."
      />
      <CcDrill
        v-else-if="drillData && drill"
        :drill="drill"
        :drivers-axis="driversAxis"
        :drill-export-params="drillExportParams"
        :drill-export-filename="drillExportFilename"
        @clear-drill="emit('clearDrill')"
        @update:drivers-axis="emit('update:driversAxis', $event)"
      />
    </template>

    <!-- ═══════════════════ GRID (budget tracker) ═══════════════════ -->
    <template v-else>
      <ReportSkeleton v-if="gridSkeleton" :kpis="6" />
      <UiFetchErrorBanner v-else-if="gridError" :error="error" />
      <ReportEmpty
        v-else-if="gridEmpty"
        headline="No cost centres in your scope for this period."
        sub="When you own a cost centre — or one sits in your org — its burn and budget risk appear here."
      />
      <div v-else-if="gridData && report" data-testid="cc-grid-data" class="space-y-6">
        <p v-if="!isChargeback" class="text-[11px] text-carbon-3 italic" data-testid="cc-lane-note">{{ report.laneNote }}</p>

        <!-- Summary KPI strip (hairline tiles + RAG count rollup) -->
        <div v-if="summary" class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3" data-testid="cc-summary-strip">
          <CcKpiTile
            v-if="isChargeback"
            label="Total chargeback"
            :value="fmtUsd(totalChargeUsd)"
            :sub="`across ${ccCount} cost ${ccCount === 1 ? 'centre' : 'centres'}`"
            hint="§B cost-of-record cross-charged to these cost-centres"
            data-testid="cc-summary-primary"
          />
          <CcKpiTile
            v-else
            label="Total burn"
            :value="fmtUsd(summary.totalBurnUsd)"
            :sub="`across ${ccCount} cost ${ccCount === 1 ? 'centre' : 'centres'}`"
            hint="usage tagged to a cost-centre's budgets"
            data-testid="cc-summary-primary"
          />
          <CcKpiTile
            label="Total allocation"
            :value="fmtUsd(summary.totalAllocationUsd)"
            :sub="isChargeback ? 'current effective budget' : (overallUtil != null ? `${fmtPct(overallUtil)} utilised overall` : 'no budgets set yet')"
          />
          <!-- The RAG count rollup is BURN-vs-allocation (§A usage-based) — it does not
               describe the §B chargeback figures, so it is suppressed in chargeback mode
               (a note below explains). Usage mode shows the full over/near/on-track/no-budget split. -->
          <template v-if="!isChargeback">
            <CcKpiTile
              label="Over budget"
              :value="String(summary.countOverBudget)"
              rag="over"
              sub="at or over allocation"
            />
            <CcKpiTile
              label="Near budget"
              :value="String(summary.countNearBudget)"
              rag="warn"
              sub="≥ 80% of allocation"
            />
            <CcKpiTile
              label="On track"
              :value="String(summary.countOnTrack)"
              rag="ok"
              sub="under 80% of budget"
            />
            <CcKpiTile
              label="No budget set"
              :value="String(summary.countNoAllocation)"
              rag="none"
              muted
              sub="no allocation yet"
            />
          </template>
        </div>
        <p
          v-if="isChargeback"
          class="text-[11px] text-carbon-3 italic"
          data-testid="cc-summary-scope-note"
        >Over / near / on-track budget health is burn (usage) based — switch to Usage to see it.</p>
        <p
          v-if="isChargeback && copilotPartialMonth"
          class="text-[11px] text-carbon-3 italic"
          data-testid="cc-copilot-partial-month-note"
        >Copilot pooled chargeback is monthly — not shown for a partial-month range (Anthropic is day-accurate).</p>

        <!-- Top burners (magnitude read) -->
        <section
          v-if="showBurners"
          class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] p-5"
          data-testid="cc-top-burners"
        >
          <div class="flex items-baseline justify-between gap-3 flex-wrap mb-3">
            <div class="text-sm font-semibold text-carbon-1">
              {{ isChargeback ? 'Top by chargeback' : 'Top burners' }}
            </div>
            <div class="text-[11px] text-carbon-3">
              {{ isChargeback ? 'Ranked by chargeback · select to drill' : 'Ranked by burn · select to drill' }}
            </div>
          </div>
          <ChartRankedBar
            :rows="burnerRows"
            :top-n="8"
            :value-format="(v) => fmtUsd(v)"
            clickable
            @select="onBurnerSelect"
          />
        </section>

        <!-- Ranked budget risk list -->
        <CcBudgetTable :cards="report.cards" :lane="lane" @select="emit('drill', $event)" />

        <div class="flex justify-end pt-2">
          <ExportCsvButton
            endpoint="/api/v1/reports/export"
            :params="exportParams"
            :filename="exportFilename"
          />
        </div>
      </div>
    </template>
  </div>
</template>
