<script setup lang="ts">
/*
 * ChargebackSplitCard — the §B "Chargeback by provider" card that REPLACES the §A
 * provider-split (usage) card in chargeback mode. The bill-lane analogue of
 * ProviderSplitCard: two buckets — Anthropic per-teammate chargeback
 * (`v_finance_bill_chargeback`) vs the Copilot per-org POOLED net
 * (`v_finance_copilot_pool_chargeback`). NEVER the §A usage spend — the two lanes are
 * never summed.
 *
 * Brand palette (reused, not re-picked): Anthropic = hunger MAGENTA (#d40e8c),
 * GitHub Copilot = vision BLUE (#5990f0). The Copilot bucket is `null` while its
 * pooled chargeback is pending validation, so it renders a "pending" state rather
 * than a false $0. Shared by the Across + Regional chargeback lanes.
 */
import { computed } from 'vue'
import UiCard from '../ui/Card.vue'
import { fmtUsd, fmtPct } from '../../composables/useFormat'
import type { ChargebackProviderSplit } from '#shared/reports/types'

const props = defineProps<{ split: ChargebackProviderSplit }>()

// The Copilot bucket is absent for one of TWO distinct reasons, both leaving `copilotUsd`
// null: it is pending validation (flag off), OR the active window is a partial-month range
// (the pooled MONTHLY net has no daily grain, so it is withheld rather than sliced/faked).
const copilotPartial = computed(() => props.split.partialMonthUnavailable === true)
const copilotPending = computed(() => props.split.copilotUsd == null && !copilotPartial.value)
// Shares render only when the Copilot value is present (both reasons suppress it), so the
// two shown shares always sum to 1 and Anthropic never reads a misleading "100%".
const showShares = computed(() => !copilotPending.value && !copilotPartial.value)
// Denominator for shares — only the present buckets, so the two shown shares sum to 1.
const total = computed(() => props.split.anthropicUsd + (props.split.copilotUsd ?? 0))
const share = (v: number) => (total.value > 0 ? v / total.value : 0)
</script>

<template>
  <UiCard data-testid="chargeback-split-card">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Chargeback by provider</div>
      <div class="text-[11px] text-carbon-3">Cost-of-record split · this period</div>
    </div>

    <div class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <!-- Anthropic (per-teammate chargeback) -->
      <div
        class="rounded-xl border border-calm-2/80 bg-calm-1/30 px-4 py-3 flex flex-col gap-1.5 min-w-0"
        data-testid="chargeback-split-anthropic"
      >
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-2.5 h-2.5 rounded-sm shrink-0 bg-brand-hunger" aria-hidden="true" />
          <span class="text-[12px] font-semibold text-carbon-1 truncate">Anthropic</span>
          <!-- Suppress the share while Copilot is pending: with only Anthropic present it
               would read "100%", implying Anthropic is all of chargeback when Copilot is
               merely withheld. Mirror the Copilot bucket, which hides its % while pending. -->
          <span
            v-if="showShares"
            class="ml-auto text-[11px] text-carbon-3 tabular-nums shrink-0"
          >{{ fmtPct(share(split.anthropicUsd)) }}</span>
        </div>
        <div class="text-[22px] leading-none font-bold tabular-nums text-carbon">
          {{ fmtUsd(split.anthropicUsd) }}
        </div>
        <div class="text-[12px] text-carbon-2">per-teammate chargeback</div>
      </div>

      <!-- GitHub Copilot (pooled net; pending while unvalidated) -->
      <div
        class="rounded-xl border border-calm-2/80 bg-calm-1/30 px-4 py-3 flex flex-col gap-1.5 min-w-0"
        data-testid="chargeback-split-copilot"
      >
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-2.5 h-2.5 rounded-sm shrink-0 bg-brand-vision" aria-hidden="true" />
          <span class="text-[12px] font-semibold text-carbon-1 truncate">GitHub Copilot</span>
          <span
            v-if="showShares"
            class="ml-auto text-[11px] text-carbon-3 tabular-nums shrink-0"
          >{{ fmtPct(share(split.copilotUsd ?? 0)) }}</span>
        </div>
        <div
          v-if="copilotPartial"
          class="text-[15px] leading-tight font-semibold text-carbon-3 italic"
          data-testid="chargeback-split-copilot-partial"
        >
          Not shown — partial-month range
        </div>
        <div v-else-if="copilotPending" class="text-[15px] leading-tight font-semibold text-carbon-3 italic">
          Pending validation
        </div>
        <div v-else class="text-[22px] leading-none font-bold tabular-nums text-carbon">
          {{ fmtUsd(split.copilotUsd ?? 0) }}
        </div>
        <div class="text-[12px] text-carbon-2">pooled per cost-centre</div>
      </div>
    </div>

    <p class="mt-3 text-[11px] text-carbon-3 leading-snug" data-testid="chargeback-split-caveat">
      <template v-if="copilotPartial">
        Anthropic per-teammate chargeback (day-accurate). Copilot pooled chargeback is monthly —
        not shown for a partial-month range.
      </template>
      <template v-else>
        Anthropic per-teammate chargeback · Copilot is pooled per cost-centre (see the cost-centre ranking).
      </template>
    </p>
  </UiCard>
</template>
