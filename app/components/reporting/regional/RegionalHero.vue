<script setup lang="ts">
/*
 * RegionalHero — the region headline + KPI tile row (mirrors the Across flagship,
 * region-scoped), RE-LENSED by the active lane (§A usage ⇄ §B chargeback).
 *
 * USAGE lane (§A): the headline is the in-progress-month run-rate ("On track for
 * $X"), falling back to the range's attributed-usage total in custom-range mode.
 * The primary KPI is Attributed usage.
 *
 * CHARGEBACK lane (§B): the headline is the CHARGEABLE cost-of-record, with the
 * attributed usage it derives from as the secondary; the Copilot pooled chip stays.
 * Both money figures stay visible in both lanes; the active one is emphasised.
 *
 * In CHARGEBACK mode the three formerly-§A tiles RE-LENS to their §B bill-lane
 * analogue (never greyed — the per-teammate bill lane HAS the grain): Active users →
 * "Billed teammates", Tokens → "Billed tokens" (Anthropic), Avg usage/user → "Avg
 * charge / billed user" — the ANTHROPIC per-teammate chargeback lane (Copilot pooled),
 * flagged by a hero caveat. In USAGE mode they stay the §A usage figures. The Chargeable
 * tile carries a §B daily sparkline from `chargeDaily`. The usage MoM is client-computed
 * (the `momDeltaPct` prop); the chargeback MoM is the server-side `kpis.chargeMomDeltaPct`
 * — the two NEVER mix. Every figure is PROVISIONAL — the settling indicator lives once.
 */
import { computed } from 'vue'
import RegionalKpiTile from './RegionalKpiTile.vue'
import UiBadge from '../../ui/Badge.vue'
import { fmtUsd, fmtTokens, fmtPct } from '../../../composables/useFormat'
import type { ReportLane } from '../../../composables/useReportState'
import type { RegionalReport } from './regional-view-types'

const props = defineProps<{
  report: RegionalReport
  /** The active lens — drives the full re-lens. */
  lane: ReportLane
  /** (genuine − prev)/prev fraction (month mode), or null (range mode / unavailable). */
  momDeltaPct: number | null
}>()

const k = computed(() => props.report.kpis)
const forecast = computed(() => props.report.forecast)
const copilot = computed(() => props.report.copilot)
const range = computed(() => props.report.meta.range ?? null)
const isChargeback = computed(() => props.lane === 'chargeback')

const avgPerUserUsd = computed(() =>
  k.value.activeUsers > 0 ? k.value.genuineUsd / k.value.activeUsers : 0,
)

// ── §A per-day sparkline series ──────────────────────────────────────────────
const daily = computed(() => props.report.dailyMetrics ?? [])
const genuineSpark = computed(() => daily.value.map((d) => d.genuineUsd))
const tokensSpark = computed(() => daily.value.map((d) => d.tokens))
const activeSpark = computed(() => daily.value.map((d) => d.activeUsers))
const avgSpark = computed(() =>
  daily.value.map((d) => (d.activeUsers > 0 ? d.genuineUsd / d.activeUsers : 0)),
)

// §B per-day Anthropic chargeback sparkline for the Chargeable tile (bill lane).
const chargeDailySpark = computed(() => (props.report.chargeDaily ?? []).map((d) => d.chargeUsd))

// ── MoM (lane-scoped) — usage: the client-computed delta; chargeback: server §B ─
const activeMomPct = computed(() =>
  isChargeback.value ? k.value.chargeMomDeltaPct : props.momDeltaPct,
)
const showMom = computed(() => activeMomPct.value != null)
const momArrow = computed<'up' | 'down' | undefined>(() => {
  const d = activeMomPct.value
  if (d == null || d === 0) return undefined
  return d > 0 ? 'up' : 'down'
})
const momSub = computed(() =>
  isChargeback.value ? 'chargeback vs last month' : 'attributed usage vs same days last month',
)

// Copilot chargeback is ON but the active window is NOT month-aligned, so the pooled
// (monthly) Copilot net is withheld for this partial-month range (never a partial slice,
// never a silent $0 under a "+ Copilot pooled net" label). Distinct from `pending`.
const copilotUnavailable = computed(() => copilot.value.partialMonthUnavailable === true)

const chargeableSub = computed(() =>
  copilot.value.pending
    ? 'Anthropic chargeable only'
    : copilotUnavailable.value
      ? 'Anthropic chargeable · Copilot pooled (monthly) not shown for partial-month ranges'
      : 'Anthropic + Copilot pooled net',
)

// The Attributed-usage tile's "≈ $X will be charged" caption reads the SAME chargeable
// figure the Chargeable tile shows — Anthropic-only while Copilot is pending OR withheld
// for a partial-month range. Flag that caveat so the estimate doesn't silently under-read.
const genuineChargeSub = computed(() =>
  copilot.value.pending
    ? `≈ ${fmtUsd(k.value.chargeableUsd)} will be charged (Anthropic; Copilot pending)`
    : copilotUnavailable.value
      ? `≈ ${fmtUsd(k.value.chargeableUsd)} will be charged (Anthropic; Copilot pooled monthly, omitted for partial-month range)`
      : `≈ ${fmtUsd(k.value.chargeableUsd)} will be charged`,
)
</script>

<template>
  <section data-testid="regional-hero" class="space-y-5">
    <!-- Confident headline (re-lensed) -->
    <div>
      <!-- CHARGEBACK lane: cost-of-record is the hero; attributed usage is the source. -->
      <template v-if="isChargeback">
        <div class="flex items-baseline gap-3 flex-wrap">
          <span
            class="text-4xl sm:text-[44px] leading-none font-extrabold tracking-[-1.5px] text-carbon tabular-nums"
            data-testid="regional-chargeback-total"
          >{{ fmtUsd(k.chargeableUsd) }}</span>
          <span class="text-sm text-carbon-3">chargeable this period</span>
        </div>
        <p class="mt-1.5 text-[12px] text-carbon-3">
          from {{ fmtUsd(k.genuineUsd) }} attributed usage · {{ chargeableSub }}
        </p>
        <p
          v-if="copilot.pending"
          class="mt-1 text-[11px] text-carbon-3 italic"
          data-testid="regional-chargeback-pending-note"
        >
          Copilot pooled chargeback is pending validation — chargeable is Anthropic only until then.
        </p>
        <p
          v-else-if="copilotUnavailable"
          class="mt-1 text-[11px] text-carbon-3 italic"
          data-testid="regional-chargeback-partial-month-note"
        >
          Copilot pooled chargeback is monthly — not shown for a partial-month range (Anthropic is day-accurate).
        </p>
      </template>

      <template v-else-if="forecast">
        <div class="flex items-baseline gap-3 flex-wrap">
          <span class="text-[15px] font-semibold text-carbon-2">On track for</span>
          <span
            class="text-4xl sm:text-[44px] leading-none font-extrabold tracking-[-1.5px] text-carbon tabular-nums"
            data-testid="regional-forecast"
          >{{ fmtUsd(forecast.projectedUsd) }}</span>
          <span class="text-sm text-carbon-3">
            this month · through day {{ forecast.daysElapsed }} of {{ forecast.daysInMonth }}
          </span>
        </div>
        <p class="mt-1.5 text-[12px] text-carbon-3">
          Run-rate projection from {{ fmtUsd(forecast.meteredMtdUsd) }} attributed usage so far —
          provisional, month in progress.
        </p>
      </template>

      <template v-else>
        <div class="flex items-baseline gap-3 flex-wrap">
          <span
            class="text-4xl sm:text-[44px] leading-none font-extrabold tracking-[-1.5px] text-carbon tabular-nums"
            data-testid="regional-range-total"
          >{{ fmtUsd(k.genuineUsd) }}</span>
          <span class="text-sm text-carbon-3">attributed usage</span>
        </div>
        <p v-if="range" class="mt-1.5 text-[12px] text-carbon-3">
          {{ range.from }} → {{ range.to }} · a custom range has no month-end forecast.
        </p>
      </template>
    </div>

    <!-- KPI tiles -->
    <div
      class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3"
      data-testid="regional-kpi-row"
    >
      <RegionalKpiTile
        label="Attributed usage"
        :value="fmtUsd(k.genuineUsd)"
        :sub="genuineChargeSub"
        note="not an invoice · incl. NFR/exempt"
        :spark="genuineSpark"
        :emphasis="!isChargeback"
        data-testid="regional-kpi-genuine"
      />

      <RegionalKpiTile
        label="Chargeable"
        :value="fmtUsd(k.chargeableUsd)"
        :sub="chargeableSub"
        :spark="chargeDailySpark"
        :emphasis="isChargeback"
        data-testid="regional-kpi-chargeable"
      >
        <!-- Only pass the footer slot when there is a chip to show — else RegionalKpiTile
             renders an empty `mt-auto pt-2.5` band and the Chargeable tile reads taller
             than its siblings (finding #5; mirrors AcrossHero). When NOT pending, the
             tile's `sub` already says "Anthropic + Copilot pooled net", so no chip is lost. -->
        <template v-if="copilot.pending" #footer>
          <UiBadge
            kind="rag-amber"
            dot="amber"
            data-testid="copilot-pending-chip"
            :title="'Copilot pooled chargeback is not yet validated on Dev (Σ=bill) — the chargeable total is Anthropic only until then.'"
          >Copilot pending</UiBadge>
        </template>
      </RegionalKpiTile>

      <RegionalKpiTile
        v-if="showMom"
        label="MoM change"
        :value="fmtPct(Math.abs(activeMomPct ?? 0))"
        :arrow="momArrow"
        :sub="momSub"
        data-testid="regional-kpi-mom"
      />

      <!-- CHARGEBACK re-lenses the three §A tiles to their §B bill-lane analogue (never
           greyed — the per-teammate bill lane HAS the grain). USAGE keeps the §A figures. -->
      <RegionalKpiTile
        :label="isChargeback ? 'Billed teammates' : 'Active users'"
        :value="isChargeback ? String(k.billedTeammates) : String(k.activeUsers)"
        :sub="isChargeback ? 'on the Anthropic chargeback bill' : 'distinct teammates'"
        :spark="isChargeback ? undefined : activeSpark"
        data-testid="regional-kpi-active"
      />

      <RegionalKpiTile
        :label="isChargeback ? 'Billed tokens' : 'Tokens'"
        :value="isChargeback ? fmtTokens(k.billedTokens) : fmtTokens(k.tokens)"
        :sub="isChargeback ? 'Anthropic bill' : 'across all providers'"
        :spark="isChargeback ? undefined : tokensSpark"
        data-testid="regional-kpi-tokens"
      />

      <RegionalKpiTile
        :label="isChargeback ? 'Avg charge / billed user' : 'Avg usage / user'"
        :value="isChargeback ? fmtUsd(k.avgChargePerBilledUser) : fmtUsd(avgPerUserUsd)"
        :sub="isChargeback ? 'Anthropic charge ÷ billed teammates' : 'attributed usage ÷ active users'"
        :spark="isChargeback ? undefined : avgSpark"
        data-testid="regional-kpi-avg"
      />
    </div>

    <p
      v-if="isChargeback"
      class="text-[11px] leading-snug text-carbon-3 max-w-[48rem]"
      data-testid="regional-chargeback-caveat"
    >
      Billed figures are the Anthropic per-teammate chargeback lane. Copilot is pooled per
      cost-centre — see the chargeback-by-cost-centre ranking below.
    </p>
  </section>
</template>
