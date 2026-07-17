<script setup lang="ts">
/*
 * My consumption (brief §4) — the developer's own usage patterns: month
 * header vs quota, daily trend, composition, cache economics, observed
 * insights (opt-in, evidence-first), aux overhead strip. The developer is
 * the CUSTOMER of this page, not its subject: no peer comparisons, no
 * manager visibility of insights.
 */
import { computed, ref } from 'vue'
import { modelDisplay } from '../../composables/useModelDisplay'
import type { HeroGroupWire } from '../../components/consumption/build-consumption-hero'
import type {
  AuxSplit,
  CacheStats,
  DaySpend,
  Finding,
  ModelDaySpend,
  ModelSpend,
  RunRate,
  TokenTypeSpend,
} from '../../../shared/schemas/usage'

interface ConsumptionResp {
  month: {
    spend_usd: string
    tokens: number
    quota_usd: string
    base_allowance_usd: string
    allocation_usd: string
    run_rate: RunRate
  }
  window_days: number
  series: DaySpend[]
  series_by_model: ModelDaySpend[]
  mix: {
    by_model: ModelSpend[]
    by_token_type: TokenTypeSpend[]
    buckets: { project_code: string; display_name: string; cost_usd: string }[]
    tagged_spend: { activity: string; cost_usd: string }[]
    unallocated: { total_cost_usd: string; untagged_cost_usd: string; needs_tagging_count: number }
  }
  cache: CacheStats
  aux: AuxSplit
  fidelity: { window_cost_usd: string; advisory_cost_usd: string }
  insights: Finding[]
  freshness_minutes_ago: number | null
  aggregate_refreshed_minutes_ago: number | null
  // ── visuals-iter2 §I3 ─────────────────────────────────────────────────
  /** `as_of` = the server's UTC today — the hero's partial-week anchor (never client `new Date()`). */
  hero: { window_days: number; as_of: string; groups: HeroGroupWire[] }
  /** The page's ONE MTD scalar — provider truth, never attribution math. */
  provider_truth: { month: string; mtd_usd: string; run_rate: RunRate }
  page_freshness: {
    telemetry_minutes_ago: number | null
    aggregate_minutes_ago: number | null
    provider_feed_minutes_ago: number | null
    worst_minutes_ago: number | null
  }
}

const { session, ensure } = useSession()
await ensure()

const windowDays = ref<30 | 90>(30)
const stackByModel = ref(false)

const { data, refresh, pending, error } = await useFetch<ConsumptionResp>(
  '/api/v1/me/consumption',
  { query: computed(() => ({ window: windowDays.value })), lazy: true },
)

// Quota tracking stays on the ATTRIBUTED month spend (quota bar unchanged, §I3
// — quota is a §A construct); the quota-basis spend itself is never rendered as
// a second MTD $ scalar.
const monthSpend = computed(() => Number(data.value?.month.spend_usd ?? 0))
const quota = computed(() => Number(data.value?.month.quota_usd ?? 0))
// The page's ONE MTD scalar + its run-rate: provider truth (§I3).
const providerMtd = computed(() => Number(data.value?.provider_truth.mtd_usd ?? 0))
const projected = computed(() =>
  Number(data.value?.provider_truth.run_rate.projected_month_end_usd ?? 0),
)
// Worst-of-sources page freshness line (§I3) — replaces per-card footnotes.
const freshnessLine = computed(() => {
  const f = data.value?.page_freshness
  if (!f || f.worst_minutes_ago == null) return null
  const leg = (label: string, m: number | null) => (m == null ? null : `${label} ${m}m`)
  const legs = [
    leg('telemetry', f.telemetry_minutes_ago),
    leg('usage rollup', f.aggregate_minutes_ago),
    leg('provider feeds', f.provider_feed_minutes_ago),
  ].filter((l): l is string => l != null)
  return `Data as fresh as its stalest source: ${f.worst_minutes_ago}m ago (${legs.join(' · ')})`
})

const modelKeyOrder = computed(() => data.value?.mix.by_model.map((m) => m.model) ?? [])
const stackedRows = computed(() =>
  (data.value?.series_by_model ?? []).map((r) => ({ day: r.day, key: r.model, value: Number(r.cost_usd) })),
)

const modelSlices = computed(() =>
  (data.value?.mix.by_model ?? []).map((m) => ({
    label: modelDisplay(m.model).label,
    value: Number(m.cost_usd),
    title: `${modelDisplay(m.model).label} — ${fmtUsd(m.cost_usd)} · ${fmtTokens(m.tokens)} tokens`,
  })),
)
const TOKEN_TYPE_LABEL: Record<string, string> = {
  input: 'Input',
  output: 'Output',
  'cache-read': 'Cache read',
  'cache-write': 'Cache write',
}
const tokenTypeSlices = computed(() =>
  (data.value?.mix.by_token_type ?? []).map((t) => ({
    label: TOKEN_TYPE_LABEL[t.token_type] ?? t.token_type,
    value: t.tokens,
    title: `${TOKEN_TYPE_LABEL[t.token_type] ?? t.token_type} — ${fmtTokens(t.tokens)} tokens · ${fmtUsd(t.cost_usd)}`,
  })),
)
const destinationSlices = computed(() => {
  const out = (data.value?.mix.buckets ?? []).map((b) => ({
    label: b.project_code,
    value: Number(b.cost_usd),
  }))
  const unalloc = Number(data.value?.mix.unallocated.total_cost_usd ?? 0)
  if (unalloc > 0) out.push({ label: 'unallocated', value: unalloc })
  return out
})

const cacheHitPct = computed(() => {
  const r = data.value?.cache.hit_ratio
  return r == null ? null : Math.round(r * 100)
})
const auxPct = computed(() => {
  const s = data.value?.aux.aux_share
  return s == null ? null : Math.round(s * 100)
})
const advisory = computed(() => Number(data.value?.fidelity.advisory_cost_usd ?? 0))

const GROUP_LABEL: Record<string, string> = {
  'tool-mastery': 'Tool mastery',
  'context-management': 'Context management',
  'session-hygiene': 'Session hygiene',
}
const dismissing = ref<string | null>(null)
async function dismiss(id: string) {
  dismissing.value = id
  try {
    await $fetch(`/api/v1/me/insights/${id}/ack`, { method: 'POST' })
    await refresh()
  } finally {
    dismissing.value = null
  }
}
</script>

<template>
  <div v-if="session" class="max-w-[1400px] mx-auto px-10 py-8 pb-20" data-testid="my-consumption">
    <UiPageHead
      eyebrow="My usage"
      title="My consumption"
      sub="Your own usage patterns — what it cost, where it went, and what you could change if you want to."
      :crumbs="['My consumption']"
    >
      <template #actions>
        <NuxtLink to="/consumption/playbook">
          <UiButton kind="ghost" size="sm" data-testid="playbook-link">Optimisation playbook</UiButton>
        </NuxtLink>
      </template>
    </UiPageHead>

    <div v-if="data" class="space-y-5">
      <!-- ONE worst-of-sources freshness line for the whole page (§I3) -->
      <p v-if="freshnessLine" class="text-[11px] text-carbon-3 -mt-2" data-testid="page-freshness">
        {{ freshnessLine }}
      </p>

      <!-- Month header band — the page's ONE MTD scalar (provider truth) -->
      <UiCard accent="harmony" data-testid="month-band">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          <div>
            <UiEyebrow>Month to date</UiEyebrow>
            <div
              class="text-[32px] font-bold text-carbon mt-1"
              style="font-variant-numeric: tabular-nums"
              data-testid="mtd-scalar"
              data-mtd-scalar="provider-truth"
            >
              {{ fmtUsd(providerMtd) }}
            </div>
            <div class="text-xs text-carbon-3">
              provider-reported · all AI surfaces · month to date
            </div>
          </div>
          <div class="pt-1">
            <ChartsUtilBar :used="monthSpend" :total="quota > 0 ? quota : null" label="Quota used" />
            <p class="text-[11px] text-carbon-3 mt-2">
              {{ fmtUsd(data.month.base_allowance_usd) }} allowance +
              {{ fmtUsd(data.month.allocation_usd) }} project allocations (quota $, month) ·
              quota tracks attributed telemetry spend
            </p>
          </div>
          <div>
            <UiEyebrow>On pace for</UiEyebrow>
            <div class="text-xl font-bold text-carbon mt-1" style="font-variant-numeric: tabular-nums">
              ~{{ fmtUsd(projected) }} <span class="text-sm font-medium text-carbon-3">by month end</span>
            </div>
            <p
              class="text-[11px] text-carbon-3 mt-1"
              :title="`Linear run-rate: MTD × days-in-month / days-elapsed (${data.provider_truth.run_rate.days_elapsed}/${data.provider_truth.run_rate.days_in_month} days)`"
            >
              linear run-rate on the provider-reported MTD · day
              {{ data.provider_truth.run_rate.days_elapsed }} of
              {{ data.provider_truth.run_rate.days_in_month }}
            </p>
          </div>
        </div>
      </UiCard>

      <!-- Consumption-type hero (§I3) — above the daily line -->
      <ConsumptionHeroCard :groups="data.hero.groups" :window-days="windowDays" :as-of="data.hero.as_of" />

      <!-- Daily trend -->
      <UiCard data-testid="trend-card">
        <div class="flex items-center justify-between mb-2">
          <UiEyebrow>Daily spend · attributed telemetry · last {{ windowDays }}d</UiEyebrow>
          <UsageWindowToggle v-model="windowDays">
            <button
              class="text-[11px] px-2 py-0.5 rounded border"
              :class="stackByModel ? 'border-brand-harmony text-brand-harmony font-bold' : 'border-calm-2 text-carbon-3'"
              :aria-pressed="stackByModel"
              data-testid="stack-toggle"
              @click="stackByModel = !stackByModel"
            >by model</button>
          </UsageWindowToggle>
        </div>
        <ChartsStackedBars
          v-if="stackByModel"
          :rows="stackedRows"
          :key-order="modelKeyOrder"
          :label-for="(k) => modelDisplay(k).label"
          :window-days="windowDays"
        />
        <ChartsTrendArea v-else :series="data.series" :window-days="windowDays" />
        <p v-if="advisory > 0" class="text-[10px] text-carbon-3 mt-1 text-right">
          {{ fmtUsd(advisory) }} of the last {{ windowDays }}d is advisory (telemetry-only) spend
        </p>
      </UiCard>

      <!-- Composition row -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <UiCard data-testid="mix-models">
          <UiEyebrow>Model mix · attributed telemetry · last {{ windowDays }}d</UiEyebrow>
          <div class="mt-3"><ChartsDonutChart :slices="modelSlices" aria-label="Model mix by cost" :center-label="fmtUsd(data.fidelity.window_cost_usd)" :center-sub="`${windowDays}d attributed`" /></div>
        </UiCard>
        <UiCard data-testid="mix-token-types">
          <UiEyebrow>Token types · attributed telemetry · last {{ windowDays }}d</UiEyebrow>
          <div class="mt-3"><ChartsDonutChart :slices="tokenTypeSlices" aria-label="Token types by volume" :center-label="cacheHitPct != null ? cacheHitPct + '%' : '—'" center-sub="cache hit" /></div>
        </UiCard>
        <UiCard data-testid="mix-destination">
          <UiEyebrow>Where it went · attributed telemetry · MTD</UiEyebrow>
          <div class="mt-3"><ChartsDonutChart :slices="destinationSlices" aria-label="Spend by budget destination" :center-label="String(data.mix.buckets.length)" center-sub="budgets" /></div>
          <p v-if="data.mix.unallocated.needs_tagging_count > 0" class="text-[11px] text-carbon-3 mt-2">
            {{ data.mix.unallocated.needs_tagging_count }} session{{ data.mix.unallocated.needs_tagging_count === 1 ? '' : 's' }}
            still need tagging — <NuxtLink to="/" class="underline">tag them on the dashboard</NuxtLink>.
          </p>
        </UiCard>
      </div>

      <!-- Cache economics + aux strip -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <UiCard accent="zeal" data-testid="cache-card">
          <UiEyebrow>Cache economics · attributed telemetry · last {{ windowDays }}d</UiEyebrow>
          <div class="mt-2 text-xl font-bold text-carbon">
            <template v-if="data.cache.savings_usd != null">
              Caching saved you {{ fmtUsd(data.cache.savings_usd) }}
            </template>
            <template v-else>No cache savings measurable yet</template>
          </div>
          <p class="text-xs text-carbon-3 mt-1">
            {{ fmtTokens(data.cache.read_tokens) }} read from cache ·
            {{ fmtTokens(data.cache.write_tokens) }} written ·
            {{ fmtTokens(data.cache.input_tokens) }} fresh input
            <template v-if="cacheHitPct != null"> · {{ cacheHitPct }}% hit ratio</template>
          </p>
        </UiCard>
        <UiCard data-testid="aux-card">
          <UiEyebrow>Conversations vs harness overhead</UiEyebrow>
          <div class="mt-2 text-xl font-bold text-carbon">
            <template v-if="auxPct != null">{{ 100 - auxPct }}% your conversations</template>
            <template v-else>Lane split not captured yet</template>
          </div>
          <p class="text-xs text-carbon-3 mt-1">
            <template v-if="auxPct != null">
              {{ auxPct }}% auxiliary lanes ({{ fmtUsd(data.aux.aux_cost_usd) }}) — title generation and other harness calls.
            </template>
            <template v-else>
              Lane capture starts with new sessions; this fills in as fresh usage lands.
            </template>
            <template v-if="data.aux.unknown_tokens > 0">
              {{ fmtTokens(data.aux.unknown_tokens) }} tokens predate lane capture (unknown).
            </template>
          </p>
        </UiCard>
      </div>

      <!-- Insights -->
      <UiCard v-if="data.insights.length" accent="vision" data-testid="insights-card">
        <UiEyebrow>Observed in your usage</UiEyebrow>
        <p class="text-[11px] text-carbon-3 mt-1 mb-3">
          Patterns from your own last 28 days — entirely optional, dismiss anything that doesn't fit how you work.
        </p>
        <div class="space-y-3">
          <div
            v-for="f in data.insights"
            :key="f.id"
            class="rounded-lg border border-calm-2 bg-white/70 px-4 py-3"
            :data-testid="`insight-${f.id}`"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span
                    class="inline-block w-2 h-2 rounded-full shrink-0"
                    :class="f.severity === 'medium' ? 'bg-rag-amber' : 'bg-cloud'"
                    aria-hidden="true"
                  />
                  <span class="text-[10px] font-bold uppercase tracking-wide text-carbon-3">
                    {{ GROUP_LABEL[f.group] ?? f.group }}
                  </span>
                  <UiBadge v-if="f.estimated_monthly_savings_usd" kind="zeal">
                    ~{{ fmtUsd(f.estimated_monthly_savings_usd) }}/mo if changed
                  </UiBadge>
                </div>
                <p class="text-sm text-carbon mt-1.5">{{ f.headline }}</p>
                <p class="text-[11px] text-carbon-3 mt-1">
                  Levers:
                  <NuxtLink
                    v-for="lever in f.related_levers"
                    :key="lever"
                    :to="`/consumption/playbook#${lever}`"
                    class="underline mr-1.5"
                  >{{ lever }}</NuxtLink>
                </p>
              </div>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="dismissing === f.id"
                :data-testid="`dismiss-${f.id}`"
                @click="dismiss(f.id)"
              >
                Dismiss
              </UiButton>
            </div>
          </div>
        </div>
      </UiCard>
      <UiCard v-else data-testid="insights-empty">
        <UiEyebrow>Observed in your usage</UiEyebrow>
        <p class="text-sm text-carbon-2 mt-2">
          Nothing to flag in your last 28 days — your usage patterns look healthy. The
          <NuxtLink to="/consumption/playbook" class="underline">playbook</NuxtLink> is there if you're curious.
        </p>
      </UiCard>
    </div>
    <UiEmptyState
      v-else-if="error"
      headline="Couldn't load your consumption"
      sub="Something went wrong fetching this page. Refresh to try again."
      data-testid="my-consumption-error"
    />
    <div v-else-if="pending" class="text-center text-sm text-carbon-3 py-12">Loading…</div>
  </div>
</template>
