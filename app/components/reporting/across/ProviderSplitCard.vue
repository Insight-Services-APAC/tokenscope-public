<script setup lang="ts">
/*
 * ProviderSplitCard — "Claude Code vs GitHub Copilot" (build-design: the
 * explicitly-requested per-provider split).
 *
 * A ChartDonut carries the SPEND composition (centre = total genuine spend); the
 * DATAVIZ-validated split paints Claude Code = hunger magenta, GitHub Copilot =
 * vision blue (ChartDonut resolves these from the slice names via colorForKey).
 * Beside it, one stat card per provider states the two numbers the donut can't —
 * spend AND distinct active users. `other` (non-CLI usage) is folded in only when
 * it carries spend, as a quiet footnote, so the composition still sums back.
 *
 * Provider spend here is USAGE-lane (always present); the Copilot pooled
 * chargeback pending state is a chargeable-lane concern, surfaced as a footnote.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartDonut from '../charts/ChartDonut.client.vue'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import type { ProviderSplit } from '#shared/reports/types'

const props = defineProps<{
  split: ProviderSplit
  /** Copilot pooled chargeback not yet validated — shown as a footnote. */
  copilotPending: boolean
}>()

const total = computed(
  () =>
    props.split.claudeCode.spendUsd + props.split.copilot.spendUsd + props.split.other.spendUsd,
)

const slices = computed(() =>
  [
    { name: 'Claude Code', value: props.split.claudeCode.spendUsd },
    { name: 'GitHub Copilot', value: props.split.copilot.spendUsd },
    { name: 'Other', value: props.split.other.spendUsd },
  ].filter((s) => s.value > 0),
)

const share = (v: number) => (total.value > 0 ? v / total.value : 0)

const providers = computed(() => [
  {
    name: 'Claude Code',
    dot: 'bg-brand-hunger',
    spend: props.split.claudeCode.spendUsd,
    users: props.split.claudeCode.activeUsers,
  },
  {
    name: 'GitHub Copilot',
    dot: 'bg-brand-vision',
    spend: props.split.copilot.spendUsd,
    users: props.split.copilot.activeUsers,
  },
])

const hasOther = computed(() => props.split.other.spendUsd > 0)
</script>

<template>
  <UiCard data-testid="across-provider-split">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Claude Code vs GitHub Copilot</div>
      <div class="text-[11px] text-carbon-3">Spend and active users by provider · this period</div>
    </div>

    <div class="mt-4 flex flex-col lg:flex-row lg:items-center gap-6">
      <!-- No fixed width: the donut + legend size to content so the legend labels
           render in full ("Claude Code", "GitHub Copilot") rather than truncating. -->
      <div class="shrink-0">
        <ChartDonut
          :slices="slices"
          :center-value="fmtUsd(total)"
          center-label="total spend"
          :value-format="(v) => fmtUsd(v)"
          :height="176"
        />
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 min-w-0">
        <div
          v-for="p in providers"
          :key="p.name"
          class="rounded-xl border border-calm-2/80 bg-calm-1/30 px-4 py-3 flex flex-col gap-1.5 min-w-0"
          data-testid="across-provider-stat"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" :class="p.dot" aria-hidden="true" />
            <span class="text-[12px] font-semibold text-carbon-1 truncate">{{ p.name }}</span>
            <span class="ml-auto text-[11px] text-carbon-3 tabular-nums shrink-0">{{ fmtPct(share(p.spend)) }}</span>
          </div>
          <div class="text-[22px] leading-none font-bold tabular-nums text-carbon">
            {{ fmtUsd(p.spend) }}
          </div>
          <div class="text-[12px] text-carbon-2 tabular-nums">
            {{ p.users }} active {{ p.users === 1 ? 'developer' : 'developers' }}
          </div>
        </div>
      </div>
    </div>

    <p class="mt-3 text-[11px] text-carbon-3 leading-snug">
      <span v-if="hasOther">
        Other providers account for {{ fmtUsd(split.other.spendUsd) }}.
      </span>
      <span v-if="copilotPending" data-testid="across-split-pending-note">
        Copilot spend is usage-lane; pooled chargeback is pending validation.
      </span>
      <span v-else>
        A teammate active in both providers is counted in each — the two user counts are not additive.
      </span>
    </p>
  </UiCard>
</template>
