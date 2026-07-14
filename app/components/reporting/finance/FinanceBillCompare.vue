<script setup lang="ts">
/*
 * FinanceBillCompare — the bill-vs-chargeback comparison, one paired bar per
 * provider (Anthropic magenta, GitHub Copilot blue).
 *
 * For each provider we draw two rounded bars on a shared scale: what the vendor
 * INVOICES (bill) and what we CHARGE BACK. In a reconciled month the two are equal
 * — the bars line up, which is the reassurance finance wants. When they diverge (an
 * unsettled month drops an unread license, or a genuine reconciliation break) the
 * gap is immediately legible and the delta chip goes RAG.
 *
 * Colour rules (locked): the provider IDENTITY carries the categorical hue
 * (Claude/Anthropic = brand-hunger, Copilot = brand-vision) — never purple, never a
 * ranking cycle. The bill vs chargeback within a provider are the SAME hue at two
 * weights (solid chargeback, light bill track) so the comparison reads as one
 * provider, not two categories. The delta is a status, so it (and only it) uses RAG.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { FinanceBillCheck } from '../finance-report-types'

const props = defineProps<{
  check: FinanceBillCheck
  /** Copilot pooled chargeback held back (pool-utilisation mode) — a per-row note. */
  copilotPending: boolean
}>()

interface CompareRow {
  key: string
  label: string
  hue: 'hunger' | 'vision'
  billUsd: number
  chargebackUsd: number
  unsettled: boolean
  pending: boolean
}

const rows = computed<CompareRow[]>(() => {
  const c = props.check
  const billFor = (provider: string) =>
    c.providers.find((p) => p.provider === provider)?.billUsd ?? 0
  const unsettledFor = (provider: string) =>
    c.providers.find((p) => p.provider === provider)?.unsettled ?? false
  // Anthropic chargeback = whole chargeback − the Copilot (copilot-cli) portion.
  const anthropicChargeback = c.chargebackUsd - c.copilotChargebackUsd
  return [
    {
      key: 'anthropic',
      label: 'Anthropic',
      hue: 'hunger' as const,
      billUsd: billFor('anthropic'),
      chargebackUsd: anthropicChargeback,
      unsettled: unsettledFor('anthropic'),
      pending: false,
    },
    {
      key: 'copilot',
      label: 'GitHub Copilot',
      hue: 'vision' as const,
      billUsd: billFor('github'),
      chargebackUsd: c.copilotChargebackUsd,
      unsettled: unsettledFor('github'),
      pending: props.copilotPending,
    },
  ].filter((r) => r.billUsd > 0.005 || r.chargebackUsd > 0.005)
})

const max = computed(() =>
  rows.value.reduce((m, r) => Math.max(m, r.billUsd, r.chargebackUsd), 0),
)
const hasData = computed(() => rows.value.length > 0 && max.value > 0)

function pct(v: number): string {
  const p = max.value > 0 ? Math.min(100, (v / max.value) * 100) : 0
  return `${p.toFixed(2)}%`
}
function delta(r: CompareRow): number {
  return r.chargebackUsd - r.billUsd
}
function matched(r: CompareRow): boolean {
  return Math.abs(delta(r)) < 0.005 && !r.unsettled
}

const SOLID: Record<'hunger' | 'vision', string> = {
  hunger: 'bg-brand-hunger',
  vision: 'bg-brand-vision',
}
const DOT = SOLID
const TRACK: Record<'hunger' | 'vision', string> = {
  hunger: 'bg-brand-hunger/20',
  vision: 'bg-brand-vision/20',
}
</script>

<template>
  <UiCard
    v-if="hasData"
    data-testid="finance-bill-compare"
  >
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Bill vs chargeback by provider</div>
      <div class="text-[11px] text-carbon-3">What the vendor invoices vs what we charge back · this period</div>
    </div>

    <div class="mt-5 space-y-6">
      <div v-for="r in rows" :key="r.key" data-testid="finance-compare-row" :data-provider="r.key">
        <!-- Provider header + reconciliation status -->
        <div class="flex items-center justify-between gap-3 mb-2.5">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" :class="DOT[r.hue]" aria-hidden="true" />
            <span class="text-[13px] font-semibold text-carbon-1 truncate">{{ r.label }}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span
              v-if="r.pending"
              class="px-1.5 py-px rounded bg-rag-amber/12 text-[#92400E] text-[10px] font-bold uppercase tracking-wide"
              title="Copilot pooled chargeback is held back from the per-CoU column until validated on Dev (Σ=bill)."
            >pending cutover</span>
            <span
              v-if="matched(r)"
              class="inline-flex items-center gap-1 text-[11px] text-carbon-3 font-semibold tabular-nums"
            >
              <svg viewBox="0 0 20 20" fill="none" class="w-3 h-3" aria-hidden="true">
                <path d="M4 10.5l4 4 8-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              matched
            </span>
            <span
              v-else-if="r.unsettled"
              class="text-[11px] text-rag-amber font-bold"
            >unsettled</span>
            <span
              v-else
              class="text-[11px] text-rag-red font-bold tabular-nums"
            >Δ {{ fmtUsd(delta(r)) }}</span>
          </div>
        </div>

        <!-- Paired bars: chargeback (solid) over bill (light), shared scale -->
        <div class="space-y-2">
          <div class="flex items-center gap-3">
            <span class="w-[86px] shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-carbon-3">Chargeback</span>
            <div class="flex-1 h-2.5 rounded-full bg-calm-2/60 overflow-hidden">
              <div class="h-full rounded-full" :class="SOLID[r.hue]" :style="{ width: pct(r.chargebackUsd) }" />
            </div>
            <span class="w-[68px] shrink-0 text-right text-[12px] font-semibold text-carbon tabular-nums">{{ fmtUsd(r.chargebackUsd) }}</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-[86px] shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.6px] text-carbon-3">Bill</span>
            <div class="flex-1 h-2.5 rounded-full bg-calm-2/60 overflow-hidden">
              <div class="h-full rounded-full" :class="TRACK[r.hue]" :style="{ width: pct(r.billUsd) }" />
            </div>
            <span class="w-[68px] shrink-0 text-right text-[12px] text-carbon-2 tabular-nums">{{ fmtUsd(r.billUsd) }}</span>
          </div>
        </div>
      </div>
    </div>
  </UiCard>
</template>
