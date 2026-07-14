<script setup lang="ts">
/*
 * RegionalProviderSplit — "Claude Code vs GitHub Copilot" for one region, with an
 * active-developers-over-time trend (an AEUF-exceed: the tool adoption split is a
 * SERIES here, not just a point KPI).
 *
 * A ChartDonut carries the SPEND composition (centre = total genuine spend);
 * ChartDonut resolves Claude Code = brand-hunger MAGENTA, GitHub Copilot =
 * brand-vision blue from the slice names (colorForKey) — never hardcoded. Beside
 * it, one stat card per provider states spend AND distinct active users. Below,
 * a two-series ChartTrend plots distinct active developers per tool per day, so
 * "how many devs on each tool" reads as a trend. `other` (non-CLI usage) folds in
 * as a quiet footnote only when it carries spend, so the composition sums back.
 */
import { computed } from 'vue'
import UiCard from '../../ui/Card.vue'
import ChartDonut from '../charts/ChartDonut.client.vue'
import ChartTrend from '../charts/ChartTrend.client.vue'
import { fmtUsd, fmtPct } from '../../../composables/useFormat'
import type { ProviderSplit, ActiveTrend } from '#shared/reports/types'

const props = defineProps<{
  split: ProviderSplit
  /** Copilot pooled chargeback not yet validated — shown as a footnote. */
  copilotPending: boolean
  /** Distinct-active-teammates-per-tool-per-day series (may be null while loading). */
  activeTrend: ActiveTrend | null
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

// Active-developers trend — colours key off the tool codes (magenta / blue).
const activeSeries = computed(() => {
  const s = props.activeTrend?.series ?? []
  return [
    { name: 'Claude Code', key: 'claude-code', data: s.map((p) => ({ x: p.day, y: p.claudeCode })) },
    { name: 'GitHub Copilot', key: 'copilot-cli', data: s.map((p) => ({ x: p.day, y: p.copilot })) },
  ]
})
const hasActiveTrend = computed(() =>
  activeSeries.value.some((ser) => ser.data.some((p) => p.y > 0)),
)
const countFmt = (v: number) => String(Math.round(v))
</script>

<template>
  <UiCard data-testid="regional-provider-split">
    <div class="flex items-baseline justify-between gap-3 flex-wrap mb-1">
      <div class="text-sm font-semibold text-carbon-1">Claude Code vs GitHub Copilot</div>
      <div class="text-[11px] text-carbon-3">Spend and active users by provider · this period</div>
    </div>

    <div class="mt-4 flex flex-col lg:flex-row lg:items-center gap-6">
      <div class="lg:w-[300px] shrink-0">
        <ChartDonut
          :slices="slices"
          :center-value="fmtUsd(total)"
          center-label="total spend"
          :value-format="(v) => fmtUsd(v)"
          :height="180"
        />
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 min-w-0">
        <div
          v-for="p in providers"
          :key="p.name"
          class="rounded-lg border border-calm-2/80 px-4 py-3.5 flex flex-col gap-1"
          data-testid="regional-provider-stat"
        >
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-sm shrink-0" :class="p.dot" aria-hidden="true" />
            <span class="text-[12px] font-semibold text-carbon-1 truncate">{{ p.name }}</span>
            <span class="ml-auto text-[11px] text-carbon-3 tabular-nums">{{ fmtPct(share(p.spend)) }}</span>
          </div>
          <div class="text-[22px] leading-none font-bold tabular-nums text-carbon">
            {{ fmtUsd(p.spend) }}
          </div>
          <div class="text-[12px] text-carbon-2 tabular-nums">
            {{ p.users }} active {{ p.users === 1 ? 'user' : 'users' }}
          </div>
        </div>
      </div>
    </div>

    <!-- Active developers over time (per tool) — the trend, not just a snapshot. -->
    <div v-if="hasActiveTrend" class="mt-5 pt-4 border-t border-calm-1" data-testid="regional-active-trend">
      <div class="flex items-baseline justify-between gap-3 flex-wrap mb-2">
        <div class="text-[12px] font-semibold text-carbon-1">Active developers over time</div>
        <div class="text-[11px] text-carbon-3">Distinct teammates on each tool per day · not additive</div>
      </div>
      <ChartTrend :series="activeSeries" :value-format="countFmt" :height="200" />
    </div>

    <p class="mt-3 text-[11px] text-carbon-3 leading-snug">
      <span v-if="hasOther">Other providers account for {{ fmtUsd(split.other.spendUsd) }}. </span>
      <span v-if="copilotPending" data-testid="regional-split-pending-note">
        Copilot spend is usage-lane; pooled chargeback is pending validation.
      </span>
      <span v-else>
        A teammate active in both providers is counted in each — the two user counts are not additive.
      </span>
    </p>
  </UiCard>
</template>
