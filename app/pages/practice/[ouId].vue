<script setup lang="ts">
/*
 * Practice detail (AEUF "Practice · MPO"). The dual-lane single-practice view: the reconciled
 * bill alongside the usage signal, vendor split, 14-week trend, users + triggers, top models, and
 * a sibling comparison. Reached by drilling a practice card on /org-rollup. Authz + data:
 * server/api/v1/rollups/practice/[ouId].get.ts, docs/design/aeuf-region-practice-views.md.
 */
interface Resp {
  period: string
  practice: { id: string; code: string; displayName: string; regionId: string }
  header: { usageUsd: number; tokens: number; users: number; avgPerUser: number; pctOfRegion: number | null; vsRegionAvgPct: number | null }
  lanes: { usageSignalUsd: number; billUsd: number; billTokens: number }
  vendorSplit: { claude: { usageUsd: number; billUsd: number }; copilot: { usageUsd: number; billUsd: number }; other: { usageUsd: number; billUsd: number } }
  topModels: { model: string; usageUsd: number }[]
  users: { teammateId: string; name: string; spendUsd: number; vendors: string[]; flagged: boolean }[]
  trend: { weekStart: string; claudeUsd: number; copilotUsd: number }[]
  comparison: { id: string; code: string; displayName: string; usageUsd: number; claudeUsd: number; copilotUsd: number; isSelf: boolean }[]
  planMix: null
}

const route = useRoute()
const ouId = computed(() => String(route.params.ouId))
const { data, pending, error } = await useFetch<Resp>(() => `/api/v1/rollups/practice/${ouId.value}`)

const crumbs = computed(() => [{ label: 'Home', to: '/' }, { label: 'Reporting', to: '/reporting?scope=regional' }, { label: data.value?.practice.displayName ?? 'Practice' }])

const vendorSlices = computed(() => {
  const v = data.value?.vendorSplit
  if (!v) return []
  return [
    { label: 'Claude', value: v.claude.usageUsd },
    { label: 'Copilot', value: v.copilot.usageUsd },
    { label: 'Other', value: v.other.usageUsd },
  ].filter((s) => s.value > 0)
})
const trendMax = computed(() => Math.max(1, ...(data.value?.trend ?? []).map((w) => w.claudeUsd + w.copilotUsd)))
const modelMax = computed(() => Math.max(1, ...(data.value?.topModels ?? []).map((m) => m.usageUsd)))
const compMax = computed(() => Math.max(1, ...(data.value?.comparison ?? []).map((c) => c.usageUsd)))
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)
const signedPct = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`)
const fmtWeek = (d: string) => d.slice(5) // MM-DD
</script>

<template>
  <div class="max-w-[1400px] mx-auto px-10 py-8 pb-20">
    <UiBreadcrumb :crumbs="crumbs" class="mb-2" />
    <UiFetchErrorBanner v-if="error" :error="error" class="mb-4" />
    <div v-if="pending" class="p-10 text-center text-carbon-3 text-sm">Loading…</div>

    <template v-else-if="data">
      <UiPageHead
:eyebrow="`Practice · ${data.practice.code}`" :title="data.practice.displayName"
        sub="Reconciled bill alongside the usage signal — estimated/emitted usage, MTD." />

      <!-- Header stat strip -->
      <div class="flex flex-wrap gap-x-10 gap-y-3 mt-4 mb-6">
        <div><div class="text-xl font-bold tabular-nums">{{ fmtUsd(data.header.usageUsd) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Inference cost</div></div>
        <div><div class="text-xl font-bold tabular-nums">{{ pct(data.header.pctOfRegion) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Of region usage</div></div>
        <div><div class="text-xl font-bold tabular-nums">{{ data.header.users }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Users</div></div>
        <div><div class="text-xl font-bold tabular-nums">{{ fmtUsd(data.header.avgPerUser) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Avg / user</div></div>
        <div><div class="text-xl font-bold tabular-nums" :class="(data.header.vsRegionAvgPct ?? 0) < 0 ? 'text-rag-green' : 'text-carbon-1'">{{ signedPct(data.header.vsRegionAvgPct) }}</div><div class="text-[11px] uppercase tracking-wide text-carbon-3">Vs region avg</div></div>
      </div>

      <!-- Dual-lane KPI cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <UiKpi label="Users" :value="String(data.header.users)" accent="vision" sub="Copilot + Claude Code" />
        <UiKpi label="Share of current bill" :value="fmtUsd(data.lanes.billUsd)" accent="hunger" sub="reconciled — homed to this practice" />
        <UiKpi
label="Inference cost (usage signal)" :value="fmtUsd(data.lanes.usageSignalUsd)" accent="harmony"
          :sub="`Copilot ${fmtUsd(data.vendorSplit.copilot.usageUsd)} · Claude ${fmtUsd(data.vendorSplit.claude.usageUsd)}`" />
        <UiKpi label="Tokens (usage)" :value="data.header.tokens >= 1000 ? `${(data.header.tokens / 1000).toFixed(0)}k` : String(data.header.tokens)" accent="zeal" sub="all token types" />
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <!-- Vendor donut -->
        <UiCard>
          <div class="text-sm font-semibold mb-1">Spend by vendor</div>
          <div class="text-[11px] text-carbon-3 mb-3">Usage signal, native cost</div>
          <ChartsDonutChart
v-if="vendorSlices.length" :slices="vendorSlices" aria-label="Spend by vendor"
            :center-label="fmtUsd(data.lanes.usageSignalUsd)" center-sub="usage" />
          <div v-else class="p-8 text-center text-carbon-3 text-sm">No usage yet.</div>
        </UiCard>

        <!-- 14-week trend (vendor-coloured stacked bars) -->
        <UiCard>
          <div class="text-sm font-semibold mb-1">Spend trend</div>
          <div class="text-[11px] text-carbon-3 mb-3">14-week rolling · Copilot + Claude</div>
          <div v-if="data.trend.length" class="flex items-end gap-1 h-[140px]">
            <div
v-for="w in data.trend" :key="w.weekStart" class="flex-1 flex flex-col justify-end items-center gap-0.5"
              :title="`${w.weekStart}: Copilot ${fmtUsd(w.copilotUsd)} · Claude ${fmtUsd(w.claudeUsd)}`">
              <div class="w-full flex flex-col justify-end" :style="{ height: `${((w.claudeUsd + w.copilotUsd) / trendMax) * 110}px` }">
                <div class="w-full bg-brand-vision rounded-t" :style="{ height: `${((w.claudeUsd) / Math.max(w.claudeUsd + w.copilotUsd, 0.0001)) * 100}%` }" />
                <div class="w-full bg-brand-harmony" :style="{ height: `${((w.copilotUsd) / Math.max(w.claudeUsd + w.copilotUsd, 0.0001)) * 100}%` }" />
              </div>
              <div class="text-[8px] text-carbon-3">{{ fmtWeek(w.weekStart) }}</div>
            </div>
          </div>
          <div v-else class="p-8 text-center text-carbon-3 text-sm">No trend data.</div>
        </UiCard>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <!-- Users -->
        <UiCard flush>
          <div class="px-5 py-3 border-b border-calm-2 text-sm font-semibold">Users in this practice <span class="text-[11px] text-carbon-3 font-normal">· top 25 by spend</span></div>
          <table class="w-full text-sm">
            <tbody>
              <tr v-for="u in data.users" :key="u.teammateId" class="border-b border-calm-1 last:border-0">
                <td class="px-5 py-2.5 font-medium">{{ u.name }}</td>
                <td class="py-2.5 text-[11px] text-carbon-3">{{ u.vendors.join(' · ') || '—' }}</td>
                <td class="py-2.5 text-right tabular-nums">{{ fmtUsd(u.spendUsd) }}</td>
                <td class="px-5 py-2.5 text-right">
                  <span v-if="u.flagged" class="text-[10px] px-1.5 py-0.5 rounded bg-rag-amber/15 text-rag-amber font-semibold">↗ spike</span>
                  <span v-else class="text-[10px] px-1.5 py-0.5 rounded bg-rag-green/15 text-rag-green font-semibold">clean</span>
                </td>
              </tr>
              <tr v-if="!data.users.length"><td colspan="4" class="p-8 text-center text-carbon-3 text-sm">No users yet.</td></tr>
            </tbody>
          </table>
        </UiCard>

        <!-- Top models -->
        <UiCard>
          <div class="text-sm font-semibold mb-3">Top models <span class="text-[11px] text-carbon-3 font-normal">· scaled to this practice</span></div>
          <div v-if="data.topModels.length" class="space-y-2">
            <div v-for="m in data.topModels" :key="m.model" class="flex items-center gap-3">
              <div class="w-[140px] text-[12px] truncate text-carbon-2">{{ m.model }}</div>
              <div class="flex-1 h-3 rounded bg-calm-1 overflow-hidden"><div class="h-full bg-brand-harmony" :style="{ width: `${(m.usageUsd / modelMax) * 100}%` }" /></div>
              <div class="w-[64px] text-right text-[12px] tabular-nums">{{ fmtUsd(m.usageUsd) }}</div>
            </div>
          </div>
          <div v-else class="p-8 text-center text-carbon-3 text-sm">No model data.</div>
        </UiCard>
      </div>

      <!-- Comparison -->
      <UiCard>
        <div class="text-sm font-semibold mb-1">How does this compare?</div>
        <div class="text-[11px] text-carbon-3 mb-3">Sibling practices in your scope · Copilot + Claude</div>
        <div class="space-y-2">
          <component
:is="c.isSelf ? 'div' : 'NuxtLink'" v-for="c in data.comparison" :key="c.id" :to="c.isSelf ? undefined : `/practice/${c.id}`"
            class="flex items-center gap-3" :class="c.isSelf ? '' : 'hover:opacity-80'">
            <div class="w-[180px] text-[12px] truncate" :class="c.isSelf ? 'font-semibold text-brand-harmony' : 'text-carbon-2'">{{ c.displayName }}<span v-if="c.isSelf" class="text-[10px] text-carbon-3 ml-1">selected</span></div>
            <div class="flex-1 h-3.5 rounded bg-calm-1 overflow-hidden flex">
              <div class="h-full bg-brand-harmony" :style="{ width: `${(c.copilotUsd / compMax) * 100}%` }" title="Copilot" />
              <div class="h-full bg-brand-vision" :style="{ width: `${(c.claudeUsd / compMax) * 100}%` }" title="Claude" />
            </div>
            <div class="w-[72px] text-right text-[12px] tabular-nums">{{ fmtUsd(c.usageUsd) }}</div>
          </component>
        </div>
      </UiCard>
    </template>
  </div>
</template>
