<script setup lang="ts">
/*
 * FinanceDrill — the per-CoU (`?cc=`) drill data view.
 *
 * Renders ONLY the data state (the skeleton / error / empty gating stays in
 * ScopeFinanceView). Restyled to the locked design language — hairline tiles for the
 * chargeable headline, UiCard section cards — while keeping the §B semantics intact:
 *   - Anthropic per-teammate charges (the bill names the person).
 *   - Copilot per-org pooled lines (chargeback mode) OR a pool-utilisation card
 *     (pool-utilisation mode; chargeback held back, "pending correct writer").
 *   - project overlay (chargeable split, Anthropic) via the shared DriversTable.
 *   - Overage Drivers — INFORMATIONAL proportional shares, NEVER a charge (D-Q6).
 *
 * An UNSETTLED CoU-month (a pooled line with usage but no read license SKU) drops the
 * unread license from Chargeable — the headline caveats it and shows amber, never a
 * silent green pass (M2).
 */
import UiCard from '../../ui/Card.vue'
import UiBadge from '../../ui/Badge.vue'
import DriversTable, { type AxisOption } from '../DriversTable.vue'
import FinanceKpiTile from './FinanceKpiTile.vue'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import type { FinanceDrill } from '../finance-report-types'

defineProps<{ drill: FinanceDrill }>()

const emit = defineEmits<{ clearDrill: [] }>()

const PROJECT_AXIS: AxisOption[] = [{ value: 'project', label: 'Project' }]
const OVERAGE_AXIS: AxisOption[] = [{ value: 'teammate', label: 'Teammate' }]
</script>

<template>
  <div data-testid="finance-drill-data" class="space-y-6">
    <!-- Breadcrumb + back -->
    <nav class="text-[12px] text-carbon-3" aria-label="Breadcrumb" data-testid="finance-drill-crumb">
      <button
        type="button"
        class="hover:text-brand-harmony hover:underline"
        @click="emit('clearDrill')"
      >Finance</button>
      <span class="mx-1.5">›</span>
      <span class="text-carbon-1 font-semibold">{{ drill.cou.displayName }}</span>
      <span v-if="drill.cou.regionCode" class="text-carbon-3"> · {{ drill.cou.regionCode.toUpperCase() }}</span>
    </nav>

    <span class="block text-[11px] text-carbon-3 italic" data-testid="finance-drill-homing">
      {{ drill.homingNote }}
    </span>

    <!-- Chargeable headline — hairline tiles -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div
        class="bg-white rounded-xl border border-calm-2/80 shadow-[0_1px_2px_rgba(62,51,45,0.03)] px-5 py-4 flex flex-col gap-1.5 min-w-0"
        data-testid="finance-drill-chargeable"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10.5px] font-bold uppercase tracking-[1.1px] text-carbon-3">Chargeable</span>
          <UiBadge
            v-if="drill.copilot.pending"
            kind="rag-amber"
            dot="amber"
            data-testid="finance-copilot-pending-chip"
            title="Copilot pooled chargeback is not yet validated on Dev (Σ=bill) — Anthropic chargeable only until then."
          >Copilot chargeback pending</UiBadge>
          <UiBadge
            v-else-if="drill.copilot.unsettled"
            kind="rag-amber"
            dot="amber"
            data-testid="finance-copilot-unsettled-chip"
            title="A pooled line has usage but no read license SKU — the Chargeable figure excludes the unread license until the month settles."
          >Copilot unsettled — excludes license</UiBadge>
          <UiBadge v-else kind="vision" dot="vision" data-testid="finance-copilot-chargeback-chip">Copilot pooled net included</UiBadge>
        </div>
        <div class="text-[30px] leading-none font-extrabold tracking-[-1px] text-carbon tabular-nums">
          {{ fmtUsd(drill.chargeableUsd) }}
        </div>
        <div class="text-[12px] text-carbon-2">Anthropic per-teammate + Copilot pooled net</div>
        <!-- M2: unsettled CoU-month drops the unread license — caveat, never a silent pass -->
        <div
          v-if="drill.copilot.unsettled"
          class="mt-0.5 text-[11px] text-rag-amber font-semibold leading-snug"
          data-testid="finance-drill-chargeable-caveat"
        >
          Excludes unread license — unsettled (a pooled line has usage but no read license SKU).
        </div>
      </div>

      <FinanceKpiTile
        label="Anthropic chargeable"
        :value="fmtUsd(drill.anthropicChargeableUsd)"
        sub="per-teammate (exempt-excluded)"
      />
      <FinanceKpiTile
        label="Copilot pooled"
        :value="drill.copilot.chargeableUsd != null ? fmtUsd(drill.copilot.chargeableUsd) : 'pending'"
        sub="pooled net (org → CoU)"
      />
    </div>

    <!-- Anthropic per-teammate charges -->
    <UiCard data-testid="finance-anthropic-charges">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Anthropic — per-teammate charges</div>
      <div class="text-[11px] text-carbon-3 mb-3">The bill names the person (settling-provisional). Homed to the current cost-owning structure.</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
              <th class="text-left font-semibold py-2">Teammate</th>
              <th class="text-right font-semibold py-2">Charge</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in drill.anthropicCharges" :key="c.teammateId" class="border-b border-calm-1 last:border-0">
              <td class="py-2.5 text-carbon-1">{{ c.label }}</td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(c.chargeUsd) }}</td>
            </tr>
            <tr v-if="!drill.anthropicCharges.length">
              <td colspan="2" class="py-6 text-center text-carbon-3 text-sm">No Anthropic charges for this month.</td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="border-t-2 border-calm-2 text-carbon-2">
              <td class="py-2.5 font-semibold">Σ Anthropic chargeable</td>
              <td class="py-2.5 text-right tabular-nums font-semibold">{{ fmtUsd(drill.anthropicChargeableUsd) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </UiCard>

    <!-- Copilot: per-org pooled lines (chargeback mode) OR pool-utilisation card -->
    <UiCard v-if="drill.copilot.pooledLines" data-testid="finance-copilot-pooled-lines">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Copilot — per-org pooled lines</div>
      <div class="text-[11px] text-carbon-3 mb-3">Read from the bill (license net + overage net), homed org → CoU. Pooled — never a per-user charge.</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm min-w-[480px]">
          <thead>
            <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
              <th class="text-left font-semibold py-2">Org</th>
              <th class="text-right font-semibold py-2">License net</th>
              <th class="text-right font-semibold py-2">Overage net</th>
              <th class="text-right font-semibold py-2">Net</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in drill.copilot.pooledLines" :key="l.orgId ?? 'residual'" class="border-b border-calm-1 last:border-0">
              <td class="py-2.5 text-carbon-1">
                {{ l.label }}
                <UiBadge v-if="l.unsettled" kind="rag-red" dot="red" class="ml-1.5">unsettled</UiBadge>
              </td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(l.licenseUsd) }}</td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(l.overageUsd) }}</td>
              <td class="py-2.5 text-right tabular-nums font-semibold text-carbon-1">{{ fmtUsd(l.netUsd) }}</td>
            </tr>
            <tr v-if="!drill.copilot.pooledLines.length">
              <td colspan="4" class="py-6 text-center text-carbon-3 text-sm">No Copilot pooled bill homed to this unit this month.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard v-else-if="drill.copilot.poolUtilisation" data-testid="finance-copilot-pool-card">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Copilot — pool utilisation</div>
      <div class="text-[11px] text-carbon-3 mb-3" data-testid="finance-copilot-pending-note">
        pooled — pending correct writer. Chargeback is held back until validated on Dev (Σ=bill); usage vs the pool allowance is shown as an estimate.
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FinanceKpiTile label="Gross usage" :value="fmtUsd(drill.copilot.poolUtilisation.usageGrossUsd)" sub="ai-credit gross (estimate)" />
        <FinanceKpiTile label="Pool allowance" :value="fmtUsd(drill.copilot.poolUtilisation.poolUsd)" sub="included discount line" />
        <FinanceKpiTile
          label="Utilisation"
          :value="drill.copilot.poolUtilisation.utilisation != null ? fmtPct(drill.copilot.poolUtilisation.utilisation) : 'n/a'"
          sub="gross ÷ pool"
        />
      </div>
    </UiCard>

    <!-- Project overlay (chargeable split, Anthropic) -->
    <UiCard data-testid="finance-project-overlay">
      <div class="text-sm font-semibold text-carbon-1 mb-3">Project overlay (Anthropic chargeable split)</div>
      <DriversTable
        :rows="drill.projectOverlay"
        :headline-usd="drill.projectHeadlineUsd"
        axis="project"
        :axis-options="PROJECT_AXIS"
        denominator-label="Anthropic chargeable"
      />
    </UiCard>

    <!-- Overage Drivers (INFORMATIONAL — never a charge; D-Q6) -->
    <UiCard v-if="drill.overageDrivers" data-testid="finance-overage-drivers">
      <div class="text-sm font-semibold text-carbon-1 mb-1">Overage drivers</div>
      <div class="text-[11px] text-carbon-3 mb-3" data-testid="finance-overage-note">
        Informational — a proportional INDICATIVE share of the paid pooled overage
        ({{ fmtUsd(drill.overageDrivers.overageNetUsd) }}), by excess above the
        per-seat share ({{ fmtUsd(drill.overageDrivers.perSeatShareUsd) }}). NEVER a
        charge — per-user charging is out of scope. Export lets finance distribute manually.
      </div>
      <DriversTable
        :rows="drill.overageDrivers.rows"
        :headline-usd="drill.overageDrivers.overageNetUsd"
        axis="teammate"
        :axis-options="OVERAGE_AXIS"
        denominator-label="paid overage (informational)"
      />
    </UiCard>
  </div>
</template>
