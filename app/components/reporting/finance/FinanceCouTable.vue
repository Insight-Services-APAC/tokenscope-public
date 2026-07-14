<script setup lang="ts">
/*
 * FinanceCouTable — "Chargeback by cost-owning unit": a ranked bar (magnitude) over
 * the precise per-CoU table (Anthropic / Copilot / Chargeable).
 *
 * The bar is a RANKING, so it wears a single magnitude hue (ChartRankedBar) with the
 * $ at the tip — never a categorical cycle, never a black/solid bar. It ranks the
 * Chargeable total (what we actually charge back). The table underneath carries the
 * exact per-provider split; a row drills into that CoU. The explicit "Unallocated"
 * bucket (no CoU mapped) is retained for sum-back honesty and carries no drill.
 *
 * When Copilot chargeback is held back (pool-utilisation mode) the Copilot column
 * reads "(pending)" and never leaks into the Chargeable total — the header chip says
 * so. A month with no per-CoU chargeback shows a graceful empty state.
 */
import { computed } from 'vue'
import ChartRankedBar, { type RankedRow } from '../charts/ChartRankedBar.client.vue'
import UiCard from '../../ui/Card.vue'
import UiBadge from '../../ui/Badge.vue'
import { fmtUsd } from '../../../composables/useFormat'
import type { FinanceCouRow } from '../finance-report-types'

const props = defineProps<{
  cous: FinanceCouRow[]
  /** Copilot pooled chargeback not yet validated (pool-utilisation mode). */
  copilotPending: boolean
}>()

const emit = defineEmits<{ drill: [couId: string] }>()

const hasRows = computed(() => props.cous.length > 0)

// Ranked bar: magnitude over the Chargeable total, biggest first. The unallocated
// bucket keeps its label but carries a null meta so a click is a no-op.
const barRows = computed<RankedRow[]>(() =>
  [...props.cous]
    .sort((a, b) => b.chargeableUsd - a.chargeableUsd)
    .map((c) => ({ label: c.displayName, value: c.chargeableUsd, meta: c.couId })),
)

function onBarSelect(row: RankedRow) {
  if (typeof row.meta === 'string') emit('drill', row.meta)
}
</script>

<template>
  <UiCard data-testid="finance-cou-table">
    <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
      <div class="text-sm font-semibold text-carbon-1">Chargeback by cost-owning unit</div>
      <UiBadge
        v-if="copilotPending"
        kind="rag-amber"
        dot="amber"
        data-testid="finance-copilot-pending-chip"
        title="Copilot pooled chargeback is not yet validated on Dev (Σ=bill) — held back from the chargeable total."
      >Copilot chargeback pending</UiBadge>
      <UiBadge v-else kind="vision" dot="vision" data-testid="finance-copilot-chargeback-chip">Copilot pooled net included</UiBadge>
    </div>
    <div class="text-[11px] text-carbon-3 mb-4">Ranked by chargeable · select a unit to drill into its charges.</div>

    <template v-if="hasRows">
      <ChartRankedBar
        :rows="barRows"
        :value-format="(v) => fmtUsd(v)"
        clickable
        @select="onBarSelect"
      />

      <div class="mt-5 overflow-x-auto">
        <table class="w-full text-sm min-w-[520px]">
          <thead>
            <tr class="text-[11px] uppercase tracking-wide text-carbon-3 border-b border-calm-2">
              <th class="text-left font-semibold py-2">Cost-owning unit</th>
              <th class="text-right font-semibold py-2">Anthropic</th>
              <th class="text-right font-semibold py-2">Copilot</th>
              <th class="text-right font-semibold py-2">Chargeable</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in cous"
              :key="c.couId ?? 'unallocated'"
              class="border-b border-calm-1 last:border-0 hover:bg-calm-1/40"
              :data-testid="`finance-cou-row-${c.code ?? 'unallocated'}`"
            >
              <td class="py-2.5">
                <button
                  v-if="c.couId"
                  type="button"
                  class="font-medium text-left text-carbon-1 hover:text-brand-harmony hover:underline"
                  :data-testid="`finance-cou-drill-${c.code ?? 'x'}`"
                  @click="emit('drill', c.couId!)"
                >{{ c.displayName }}</button>
                <span
                  v-else
                  class="font-medium text-carbon-2 italic"
                  title="No cost-owning unit mapped — visible unallocated bucket, never dropped."
                >{{ c.displayName }}</span>
                <span v-if="c.regionCode" class="text-carbon-3 text-[11px]"> · {{ c.regionCode.toUpperCase() }}</span>
              </td>
              <td class="py-2.5 text-right tabular-nums text-carbon-1">{{ fmtUsd(c.anthropicUsd) }}</td>
              <td
                class="py-2.5 text-right tabular-nums"
                :class="c.copilotPending ? 'text-carbon-3 italic' : 'text-carbon-1'"
                :title="c.copilotPending ? 'pooled — pending correct writer' : undefined"
              >{{ c.copilotPending ? `${fmtUsd(c.copilotUsd)} (pending)` : fmtUsd(c.copilotUsd) }}</td>
              <td class="py-2.5 text-right tabular-nums font-semibold text-carbon-1">{{ fmtUsd(c.chargeableUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Graceful empty: a month with a bill/gap but no per-CoU chargeback rows -->
    <div
      v-else
      class="py-10 text-center"
      data-testid="finance-cou-empty"
    >
      <div class="text-sm font-semibold text-carbon-2">No chargeback for this month</div>
      <div class="mt-1 text-[12px] text-carbon-3">As the month's bills land and home to cost-owning units, they appear here.</div>
    </div>
  </UiCard>
</template>
