<script setup lang="ts">
/*
 * AcrossHero — the whole-company headline + KPI tile row, RE-LENSED by the active
 * lane (§A usage ⇄ §B chargeback — provider-billing-attribution-model.md).
 *
 * USAGE lane (§A): the confident headline answers "what is the company on track to
 * spend this period" — the in-progress-month run-rate ("On track for $X · through
 * day N of M"); in custom-range mode the forecast/MoM come back null, so it falls
 * back to the range's attributed-usage total. The primary KPI is Attributed usage.
 *
 * CHARGEBACK lane (§B): the headline is the CHARGEABLE cost-of-record for the
 * period, with the attributed usage it derives from as the secondary. The Copilot
 * pooled-pending chip stays. Both money figures remain visible in BOTH lanes (the
 * "both matter equally" rule) — the active lane's tile is emphasised.
 *
 * In CHARGEBACK mode the three formerly-§A tiles RE-LENS to their §B bill-lane
 * analogue (never greyed — the bill lane HAS the grain): Active users → "Billed
 * teammates", Tokens → "Billed tokens" (Anthropic), Avg usage/user → "Avg charge /
 * billed user". These are the ANTHROPIC per-teammate chargeback lane (Copilot is
 * pooled per cost-centre); a hero caveat says so. In USAGE mode they stay exactly the
 * §A usage figures. The Chargeable tile now carries a §B daily sparkline from
 * `chargeDaily` (the per-teammate DAILY bill lane, Anthropic). Every figure is
 * PROVISIONAL — the settling indicator lives once in the page header.
 */
import { computed } from 'vue'
import AcrossKpiTile from './AcrossKpiTile.vue'
import UiBadge from '../../ui/Badge.vue'
import { fmtUsd, fmtTokens, fmtPct } from '../../../composables/useFormat'
import type { ReportLane } from '../../../composables/useReportState'
import type { AcrossReport } from './across-view-types'

const props = defineProps<{
  report: AcrossReport
  /** The active lens — drives the full re-lens. */
  lane: ReportLane
}>()

const k = computed(() => props.report.kpis)
const forecast = computed(() => props.report.forecast)
const copilot = computed(() => props.report.copilot)
const range = computed(() => props.report.meta.range ?? null)
const isChargeback = computed(() => props.lane === 'chargeback')

// ── §A per-day sparkline series (Attributed usage / Tokens / Active users / Avg) ─
const daily = computed(() => props.report.dailyMetrics ?? [])
const genuineSpark = computed(() => daily.value.map((d) => d.genuineUsd))
const tokensSpark = computed(() => daily.value.map((d) => d.tokens))
const activeSpark = computed(() => daily.value.map((d) => d.activeUsers))
const avgSpark = computed(() =>
  daily.value.map((d) => (d.activeUsers > 0 ? d.genuineUsd / d.activeUsers : 0)),
)

// §B per-day Anthropic chargeback sparkline for the Chargeable tile (bill lane).
const chargeDailySpark = computed(() => (props.report.chargeDaily ?? []).map((d) => d.chargeUsd))

// ── MoM (lane-scoped — the two lanes NEVER mix operands) ─────────────────────
// Usage → the §A usage delta; chargeback → the §B charge delta. Month-anchored:
// null (⇒ hidden tile) in range mode.
const activeMomPct = computed(() =>
  isChargeback.value ? k.value.chargeMomDeltaPct : k.value.momDeltaPct,
)
const showMom = computed(() => activeMomPct.value != null)
const momTrend = computed<'up' | 'down' | 'flat'>(() => {
  const d = activeMomPct.value
  if (d == null || d === 0) return 'flat'
  return d > 0 ? 'up' : 'down'
})
const momMagnitude = computed(() =>
  activeMomPct.value == null ? '' : fmtPct(Math.abs(activeMomPct.value)),
)
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
  <section data-testid="across-hero" class="space-y-5">
    <!-- Confident headline (re-lensed) -->
    <div>
      <!-- CHARGEBACK lane: the cost-of-record is the hero; attributed usage is the source. -->
      <template v-if="isChargeback">
        <div class="flex items-baseline gap-3 flex-wrap">
          <span
            class="text-4xl sm:text-[44px] leading-none font-extrabold tracking-[-1.5px] text-carbon tabular-nums"
            data-testid="across-chargeback-total"
          >{{ fmtUsd(k.chargeableUsd) }}</span>
          <span class="text-sm text-carbon-3">chargeable this period</span>
        </div>
        <p class="mt-1.5 text-[12px] text-carbon-3">
          from {{ fmtUsd(k.genuineUsd) }} attributed usage · {{ chargeableSub }}
        </p>
        <p
          v-if="copilot.pending"
          class="mt-1 text-[11px] text-carbon-3 italic"
          data-testid="across-chargeback-pending-note"
        >
          Copilot pooled chargeback is pending validation — chargeable is Anthropic only until then.
        </p>
        <p
          v-else-if="copilotUnavailable"
          class="mt-1 text-[11px] text-carbon-3 italic"
          data-testid="across-chargeback-partial-month-note"
        >
          Copilot pooled chargeback is monthly — not shown for a partial-month range (Anthropic is day-accurate).
        </p>
      </template>

      <!-- USAGE lane: the in-progress-month run-rate (or the range's usage total). -->
      <template v-else-if="forecast">
        <div class="flex items-baseline gap-3 flex-wrap">
          <span class="text-[15px] font-semibold text-carbon-2">On track for</span>
          <span
            class="text-4xl sm:text-[44px] leading-none font-extrabold tracking-[-1.5px] text-carbon tabular-nums"
            data-testid="across-forecast"
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
            data-testid="across-range-total"
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
      data-testid="across-kpi-row"
    >
      <AcrossKpiTile
        label="Attributed usage"
        :value="fmtUsd(k.genuineUsd)"
        :sub="genuineChargeSub"
        note="not an invoice · incl. NFR/exempt"
        :spark="genuineSpark"
        :emphasis="!isChargeback"
        data-testid="across-kpi-genuine"
      />

      <AcrossKpiTile
        label="Chargeable"
        :value="fmtUsd(k.chargeableUsd)"
        :sub="chargeableSub"
        :spark="chargeDailySpark"
        :emphasis="isChargeback"
        data-testid="across-kpi-chargeable"
      >
        <template v-if="copilot.pending" #footer>
          <UiBadge
            kind="rag-amber"
            dot="amber"
            data-testid="across-copilot-pending"
            :title="'Copilot pooled chargeback is not yet validated on Dev (Σ=bill) — the chargeable total is Anthropic only until then.'"
          >Copilot pending</UiBadge>
        </template>
      </AcrossKpiTile>

      <AcrossKpiTile
        v-if="showMom"
        label="MoM change"
        :value="momMagnitude"
        :trend="momTrend"
        :sub="momSub"
        data-testid="across-kpi-mom"
      />

      <!-- CHARGEBACK re-lenses the three §A tiles to their §B bill-lane analogue (never
           greyed — the per-teammate bill lane HAS the grain). USAGE keeps the §A figures. -->
      <AcrossKpiTile
        :label="isChargeback ? 'Billed teammates' : 'Active users'"
        :value="isChargeback ? String(k.billedTeammates) : String(k.activeUsers)"
        :sub="isChargeback ? 'on the Anthropic chargeback bill' : 'distinct teammates'"
        :spark="isChargeback ? undefined : activeSpark"
        data-testid="across-kpi-active"
      />

      <AcrossKpiTile
        :label="isChargeback ? 'Billed tokens' : 'Tokens'"
        :value="isChargeback ? fmtTokens(k.billedTokens) : fmtTokens(k.tokens)"
        :sub="isChargeback ? 'Anthropic bill' : 'across all providers'"
        :spark="isChargeback ? undefined : tokensSpark"
        data-testid="across-kpi-tokens"
      />

      <AcrossKpiTile
        :label="isChargeback ? 'Avg charge / billed user' : 'Avg usage / user'"
        :value="isChargeback ? fmtUsd(k.avgChargePerBilledUser) : fmtUsd(k.avgPerUserUsd)"
        :sub="isChargeback ? 'Anthropic charge ÷ billed teammates' : 'attributed usage ÷ active users'"
        :spark="isChargeback ? undefined : avgSpark"
        data-testid="across-kpi-avg"
      />
    </div>

    <p
      v-if="isChargeback"
      class="text-[11px] leading-snug text-carbon-3 max-w-[48rem]"
      data-testid="across-chargeback-caveat"
    >
      Billed figures are the Anthropic per-teammate chargeback lane. Copilot is pooled per
      cost-centre — see the chargeback-by-region / cost-centre rankings below.
    </p>
  </section>
</template>
