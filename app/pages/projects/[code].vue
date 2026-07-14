<script setup lang="ts">
/*
 * Project dashboard (brief §5) — burn trend vs allocation, composition,
 * cache economics at project level, team contribution (project-health
 * framing: contribution + concentration, never behavioural findings),
 * untagged pressure. Same view for PM and member.
 */
import { computed, ref } from 'vue'
import { modelDisplay } from '../../composables/useModelDisplay'
import type {
  ActivitySlice,
  CacheStats,
  DaySpend,
  MemberContribution,
  ModelDaySpend,
  ModelSpend,
  RunRate,
  TokenTypeSpend,
  VelocityState,
} from '../../../shared/schemas/usage'

interface ProjectResp {
  project: {
    id: string
    code: string
    display_name: string
    type: string
    wbs_code: string | null
    end_date: string | null
    ended: boolean
  }
  // J5: the caller's own assignment role + how they were admitted + the
  // budget the editor focuses. access='cou-owner' viewers get aggregates
  // only (no named member rows — R2 F1).
  viewer: {
    role: 'manager' | 'member'
    access: 'member' | 'cou-owner'
    budget_allocation_id: string | null
  }
  budget: {
    mtd_cost_usd: string
    allocation_usd: string
    utilisation: number | null
    projected_exhaustion_date: string | null
    run_rate: RunRate
  }
  velocity: VelocityState
  window_days: number
  series: DaySpend[]
  series_by_model: ModelDaySpend[]
  mix: {
    by_model: ModelSpend[]
    by_token_type: TokenTypeSpend[]
    by_activity: ActivitySlice[]
  }
  cache: CacheStats
  fidelity: { window_cost_usd: string; advisory_cost_usd: string }
  team: { members: MemberContribution[]; member_count: number; concentration_top2_share: number | null }
  untagged_pressure: { conversations: number; cost_usd: string; tokens: number }
}

const route = useRoute()
const code = computed(() => String(route.params.code ?? ''))
const windowDays = ref<30 | 90>(30)

const { session, ensure } = useSession()
await ensure()

const { data, error, pending } = await useFetch<ProjectResp>(
  () => `/api/v1/me/projects/${encodeURIComponent(code.value)}`,
  { query: computed(() => ({ window: windowDays.value })), lazy: true },
)

const notFound = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 404)

const modelSlices = computed(() =>
  (data.value?.mix.by_model ?? []).map((m) => ({
    label: modelDisplay(m.model).label,
    value: Number(m.cost_usd),
  })),
)
const activitySlices = computed(() =>
  (data.value?.mix.by_activity ?? []).map((a) => ({
    label: a.activity ?? 'untagged',
    value: Number(a.cost_usd),
  })),
)
const modelKeyOrder = computed(() => data.value?.mix.by_model.map((m) => m.model) ?? [])
const stackedRows = computed(() =>
  (data.value?.series_by_model ?? []).map((r) => ({ day: r.day, key: r.model, value: Number(r.cost_usd) })),
)
const concentrationPct = computed(() => {
  const c = data.value?.team.concentration_top2_share
  return c == null ? null : Math.round(c * 100)
})
const cacheSavings = computed(() => data.value?.cache.savings_usd)
</script>

<template>
  <div v-if="session" class="max-w-[1400px] mx-auto px-10 py-8 pb-20" data-testid="project-dashboard">
    <template v-if="data">
      <UiPageHead
        eyebrow="My projects"
        :title="data.project.display_name"
        :sub="`${data.project.code} · ${data.project.type}${data.project.wbs_code ? ` · WBS ${data.project.wbs_code}` : ''}${data.project.ended ? ' · ended' : data.project.end_date ? ` · ends ${data.project.end_date.slice(0, 10)}` : ''}`"
        :crumbs="['My projects', data.project.code]"
      >
        <template #actions>
          <UiBadge v-if="data.velocity.is_flagged" kind="rag-amber" data-testid="velocity-flag">
            velocity {{ Math.round((data.velocity.delta_pct ?? 0) * 100) }}% above 4-week mean
          </UiBadge>
        </template>
      </UiPageHead>

      <div class="space-y-5">
        <!-- Budget band -->
        <UiCard accent="harmony" data-testid="budget-band">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
            <div>
              <UiEyebrow>Month to date</UiEyebrow>
              <div class="text-[32px] font-bold text-carbon mt-1" style="font-variant-numeric: tabular-nums">
                {{ fmtUsd(data.budget.mtd_cost_usd) }}
              </div>
              <div class="text-xs text-carbon-3">
                of {{ Number(data.budget.allocation_usd) > 0 ? fmtUsd(data.budget.allocation_usd) + ' allocated' : 'no allocation set' }}
              </div>
              <!-- PM budget entry point (J2/J5): role on the assignment, not the org role. -->
              <NuxtLink
                v-if="data.viewer.role === 'manager' && data.viewer.budget_allocation_id"
                :to="`/allocations/${data.viewer.budget_allocation_id}`"
                class="inline-block mt-2 text-[12px] font-semibold text-brand-harmony hover:underline"
                data-testid="pm-manage-budget"
              >
                Manage budget →
              </NuxtLink>
              <!-- R1 F12: PM with no current baseline still gets a signposted
                   (not silent) path — baselines are an org-role action. -->
              <p
                v-else-if="data.viewer.role === 'manager'"
                class="mt-2 text-[11px] text-carbon-3 italic"
                data-testid="pm-no-budget-hint"
                title="Project managers manage top-ups on an existing budget; creating the baseline is a manager/admin action."
              >
                No active budget period — ask your manager or admin to set one.
              </p>
            </div>
            <div class="pt-1">
              <ChartsUtilBar
                :used="Number(data.budget.mtd_cost_usd)"
                :total="Number(data.budget.allocation_usd) > 0 ? Number(data.budget.allocation_usd) : null"
                label="Allocation used"
              />
              <p v-if="data.budget.projected_exhaustion_date" class="text-[11px] text-carbon-3 mt-2">
                On pace to reach allocation ~{{ data.budget.projected_exhaustion_date }}
                <span :title="`Linear run-rate, day ${data.budget.run_rate.days_elapsed} of ${data.budget.run_rate.days_in_month}`">ⓘ</span>
              </p>
            </div>
            <div>
              <UiEyebrow>On pace for</UiEyebrow>
              <div class="text-xl font-bold text-carbon mt-1" style="font-variant-numeric: tabular-nums">
                ~{{ fmtUsd(data.budget.run_rate.projected_month_end_usd) }}
                <span class="text-sm font-medium text-carbon-3">by month end</span>
              </div>
              <p v-if="Number(data.fidelity.advisory_cost_usd) > 0" class="text-[11px] text-carbon-3 mt-1">
                incl. {{ fmtUsd(data.fidelity.advisory_cost_usd) }} advisory spend in this window
              </p>
            </div>
          </div>
        </UiCard>

        <!-- Burn trend -->
        <UiCard data-testid="burn-card">
          <div class="flex items-center justify-between mb-2">
            <UiEyebrow>Daily burn</UiEyebrow>
            <UsageWindowToggle v-model="windowDays" />
          </div>
          <ChartsStackedBars
            :rows="stackedRows"
            :key-order="modelKeyOrder"
            :label-for="(k) => modelDisplay(k).label"
            :window-days="windowDays"
          />
        </UiCard>

        <!-- Composition -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <UiCard data-testid="proj-mix-models">
            <UiEyebrow>Model mix ({{ windowDays }}d)</UiEyebrow>
            <div class="mt-3"><ChartsDonutChart :slices="modelSlices" aria-label="Project model mix by cost" :center-label="fmtUsd(data.fidelity.window_cost_usd)" center-sub="window spend" /></div>
          </UiCard>
          <UiCard data-testid="proj-mix-activity">
            <UiEyebrow>Activity mix (MTD)</UiEyebrow>
            <div class="mt-3"><ChartsDonutChart :slices="activitySlices" aria-label="Project activity mix" :center-label="String(data.mix.by_activity.length)" center-sub="activities" /></div>
          </UiCard>
          <UiCard accent="zeal" data-testid="proj-cache">
            <UiEyebrow>Cache economics ({{ windowDays }}d)</UiEyebrow>
            <div class="mt-2 text-lg font-bold text-carbon">
              <template v-if="cacheSavings != null">Caching saved this project {{ fmtUsd(cacheSavings) }}</template>
              <template v-else>No cache savings measurable yet</template>
            </div>
            <p class="text-xs text-carbon-3 mt-1">
              {{ fmtTokens(data.cache.read_tokens) }} cache reads ·
              {{ data.cache.hit_ratio != null ? Math.round(data.cache.hit_ratio * 100) + '% hit ratio' : 'no ratio yet' }}
            </p>
          </UiCard>
        </div>

        <!-- Team contribution -->
        <UiCard data-testid="team-card">
          <div class="flex items-center justify-between mb-1">
            <UiEyebrow>Team contribution (MTD)</UiEyebrow>
            <span v-if="concentrationPct != null && data.team.members.length > 2" class="text-[11px] text-carbon-3">
              top 2 contributors = {{ concentrationPct }}% of spend
            </span>
          </div>
          <p class="text-[11px] text-carbon-3 mb-3">
            Contribution only — usage-pattern insights stay on each developer's own consumption page.
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-[11px] text-carbon-3 uppercase tracking-[1.2px]">
                <tr>
                  <th class="text-left font-bold py-2 pr-4">Member</th>
                  <th class="text-right font-bold py-2 px-4">Cost</th>
                  <th class="text-right font-bold py-2 px-4">Tokens</th>
                  <th class="text-right font-bold py-2 px-4">Active days</th>
                  <th class="text-right font-bold py-2 px-4">$/active day</th>
                  <th class="text-right font-bold py-2 pl-4">Last activity</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-calm-2">
                <tr v-for="m in data.team.members" :key="m.teammate_id" :data-testid="`member-${m.email}`">
                  <td class="py-2 pr-4 text-carbon">{{ m.display_name ?? m.email }}</td>
                  <td class="py-2 px-4 text-right font-bold text-carbon" style="font-variant-numeric: tabular-nums">{{ fmtUsd(m.cost_usd) }}</td>
                  <td class="py-2 px-4 text-right text-carbon-2" style="font-variant-numeric: tabular-nums">{{ fmtTokens(m.tokens) }}</td>
                  <td class="py-2 px-4 text-right text-carbon-2">{{ m.active_days }}</td>
                  <td class="py-2 px-4 text-right text-carbon-2" style="font-variant-numeric: tabular-nums">{{ fmtUsd(m.cost_per_active_day) }}</td>
                  <td class="py-2 pl-4 text-right text-carbon-3 text-[12px]">{{ fmtTimeAgo(m.last_event) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p
            v-if="!data.team.members.length && data.viewer.access === 'cou-owner'"
            class="text-sm text-carbon-3 italic py-4"
            data-testid="team-owner-aggregate-note"
          >
            {{ data.team.member_count }} member{{ data.team.member_count === 1 ? '' : 's' }} —
            the per-person breakdown is visible to the project team, not observers.
          </p>
          <p v-else-if="!data.team.members.length" class="text-sm text-carbon-3 italic py-4">No spend this month yet.</p>
        </UiCard>

        <!-- Untagged pressure -->
        <UiCard v-if="data.untagged_pressure.conversations > 0" accent="zeal" data-testid="untagged-pressure">
          <UiEyebrow>Untagged pressure</UiEyebrow>
          <p class="text-sm text-carbon mt-2">
            Team members have <strong>{{ data.untagged_pressure.conversations }}</strong> unallocated
            conversation{{ data.untagged_pressure.conversations === 1 ? '' : 's' }}
            ({{ fmtUsd(data.untagged_pressure.cost_usd) }}) this month that may belong here.
          </p>
          <p class="text-[11px] text-carbon-3 mt-1">
            A nudge in standup beats a chase: everyone can re-tag their own sessions from the dashboard.
          </p>
        </UiCard>
      </div>
    </template>

    <UiEmptyState
      v-else-if="notFound"
      headline="Project not found"
      sub="No project with this code among your current memberships."
    />
    <UiEmptyState
      v-else-if="error"
      headline="Couldn't load this project"
      sub="Something went wrong fetching the dashboard. Refresh to try again."
      data-testid="project-dashboard-error"
    />
    <div v-else-if="pending" class="text-center text-sm text-carbon-3 py-12">Loading…</div>
  </div>
</template>
