<script setup lang="ts">
/*
 * Project budgets (#632): one line per project, the budget in force today,
 * with earlier and later budget lines folded under it, and the projects with
 * nothing in force under one fold at the bottom.
 *
 * The route pages by WHOLE projects (server/api/v1/allocations/index.get.ts),
 * so "Load more" appends complete projects and a project is never split
 * across pages. Periods arrive parsed; the budget in force arrives from the
 * project page's own reader; this page arranges, it does not compute
 * (app/components/allocator/budget-groups.ts).
 */
import { computed, ref, watch } from 'vue'
import { isOrgWideRole } from '#shared/auth/roles'
import { apiErrorDetail, isConfirmedRejection } from '../../composables/useApiError'
import { groupBudgetLines, kindWord, periodOf, type BudgetLine } from '../../components/allocator/budget-groups'

interface ListResponse {
  allocations: BudgetLine[]
  total: number
  total_lines: number
  limit: number
  offset: number
}

const PAGE = 100

const { data, error, refresh } = useFetch<ListResponse>('/api/v1/allocations', {
  query: { limit: PAGE, offset: 0 },
  default: () => ({ allocations: [], total: 0, total_lines: 0, limit: PAGE, offset: 0 }),
})

/* Lines from "Load more" pages, appended after the first page. */
const more = ref<BudgetLine[]>([])
const loadedProjects = ref(0)
const loadingMore = ref(false)
const loadMoreFailed = ref(false)
watch(
  data,
  (d) => {
    more.value = []
    loadedProjects.value = d ? new Set(d.allocations.map((l) => `${l.scope_type}:${l.scope_id}`)).size : 0
  },
  { immediate: true },
)

const lines = computed(() => [...(data.value?.allocations ?? []), ...more.value])
const groups = computed(() => groupBudgetLines(lines.value))
const total = computed(() => data.value?.total ?? 0)
const hasMore = computed(() => loadedProjects.value < total.value)

async function loadMore() {
  if (loadingMore.value) return
  loadingMore.value = true
  loadMoreFailed.value = false
  try {
    const page = await $fetch<ListResponse>('/api/v1/allocations', {
      query: { limit: PAGE, offset: loadedProjects.value },
    })
    more.value = [...more.value, ...page.allocations]
    loadedProjects.value += new Set(page.allocations.map((l) => `${l.scope_type}:${l.scope_id}`)).size
  } catch {
    loadMoreFailed.value = true
  } finally {
    loadingMore.value = false
  }
}

const showingNote = computed(() =>
  hasMore.value
    ? `Showing ${loadedProjects.value} of ${total.value} projects.`
    : `Showing ${total.value} ${total.value === 1 ? 'project' : 'projects'}.`,
)

/* Which project folds are open; all closed by default. */
const open = ref(new Set<string>())
function toggle(key: string) {
  const next = new Set(open.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  open.value = next
}
const notInForceOpen = ref(false)

/*
 * Empty, refused and failed are three answers. `default` fills `data` with an
 * empty list even when the read failed, so the error is checked first: a 403
 * must never read as "No allocations yet". Refused = the server answered with a
 * 4xx and a reason (isConfirmedRejection); anything else is a failure, and then
 * we cannot know what the list holds.
 */
const loadState = computed<'refused' | 'failed' | null>(() => {
  if (!error.value) return null
  return isConfirmedRejection(error.value) ? 'refused' : 'failed'
})
const refusedForbidden = computed(
  () => (error.value as { statusCode?: number } | null)?.statusCode === 403,
)
const refusedDetail = computed(() => apiErrorDetail(error.value, 'none').replace(/\.$/, ''))

// Label the scope so this list and the region-scoped /admin tabs don't look
// contradictory. Per the live allocation-scope predicate
// (server/auth/allocation-scope.ts): only platform-admin is unbounded; a Region
// admin sees every project in THEIR OWN region; a manager sees their part of
// the org.
const { session } = useSession()
const scopeNote = computed(() => {
  const r = session.value?.role
  if (isOrgWideRole(r)) return 'Projects across all regions.'
  if (r === 'admin') return 'Every project in your region.'
  return 'The projects in your part of the org.'
})

// Money cells use the shared guarded formatter from ~/composables/useFormat
// (auto-imported, SYS-5).
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Budgets"
      title="Project budgets"
      :sub="`One line per project: the budget in force today. Earlier budgets are folded under each project. ${scopeNote}`"
    >
      <template #actions>
        <NuxtLink to="/projects/new" data-testid="new-project-link">
          <UiButton kind="primary" size="sm">
            + New project
          </UiButton>
        </NuxtLink>
      </template>
    </UiPageHead>

    <UiCard flush data-testid="allocation-list">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-brand-harmony-sheer border-b border-calm-2">
            <th scope="col" class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Project</th>
            <th scope="col" class="text-right text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Budget now</th>
            <th scope="col" class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 px-5 py-3">Period</th>
            <th scope="col" class="px-5 py-3"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loadState === 'refused'" data-testid="allocations-refused">
            <td colspan="4" class="p-10 text-center text-sm">
              <div class="font-bold text-carbon">
                {{ refusedForbidden ? "You don't have access to project budgets." : 'The server refused to list project budgets.' }}
              </div>
              <div class="text-carbon-3 mt-1">
                <template v-if="refusedForbidden">
                  Project budgets are for managers and admins. This is not an empty list: budgets may exist that you can't see.
                </template>
                <template v-else>Reason given: {{ refusedDetail }}.</template>
              </div>
            </td>
          </tr>
          <tr v-else-if="loadState === 'failed'" data-testid="allocations-failed">
            <td colspan="4" class="p-10 text-center text-sm">
              <div class="font-bold text-carbon">Project budgets didn't load.</div>
              <div class="text-carbon-3 mt-1">
                We couldn't get an answer from the server, so we can't tell which budgets exist.
              </div>
              <UiButton class="mt-3" kind="secondary" size="sm" data-testid="allocations-retry" @click="refresh()">
                Try again
              </UiButton>
            </td>
          </tr>
          <tr v-else-if="lines.length === 0" data-testid="allocations-empty">
            <td colspan="4" class="p-10 text-center text-carbon-3 text-sm">
              No project budgets in your scope yet.
            </td>
          </tr>
          <template v-for="g in loadState ? [] : groups.inForce" :key="g.key">
            <tr class="border-b border-calm-2 hover:bg-brand-harmony-sheer/40" data-testid="budget-project-row">
              <td class="px-5 py-4">
                <div class="font-bold text-carbon">{{ g.name }}</div>
                <div v-if="g.code" class="text-[11px] text-carbon-3 font-mono mt-0.5">{{ g.code }}</div>
              </td>
              <td class="text-right px-5 py-4" style="font-variant-numeric: tabular-nums">
                <div class="font-bold text-carbon" data-testid="budget-now">{{ fmtUsd(g.budgetNow ?? g.headline.budget_usd, { whole: true }) }}</div>
                <div v-if="g.breakdown" class="text-[11px] text-carbon-3 mt-0.5" data-testid="budget-breakdown">
                  {{ fmtUsd(g.breakdown.baselineUsd, { whole: true }) }} baseline + {{ fmtUsd(g.breakdown.topupUsd, { whole: true }) }} top-up
                </div>
              </td>
              <td class="px-5 py-4 text-carbon-2" data-testid="budget-period">{{ periodOf(g.headline) }}</td>
              <td class="px-5 py-4 text-right">
                <NuxtLink
                  :to="`/allocations/${g.headline.id}`"
                  class="inline-flex items-center gap-2 rounded-lg font-bold tracking-tight whitespace-nowrap px-3 py-1.5 text-xs bg-transparent text-carbon-2 hover:bg-brand-harmony-sheer hover:text-brand-harmony transition-colors cursor-pointer"
                  data-testid="allocations-edit-link"
                >
                  Edit →
                </NuxtLink>
              </td>
            </tr>
            <tr v-if="g.others.length > 0" class="border-b border-calm-2">
              <td colspan="4" class="px-5 py-2">
                <button
                  type="button"
                  class="text-xs text-carbon-3 hover:text-brand-harmony cursor-pointer inline-flex items-center gap-1"
                  :aria-expanded="open.has(g.key)"
                  data-testid="budget-others-toggle"
                  @click="toggle(g.key)"
                >
                  <span aria-hidden="true">{{ open.has(g.key) ? '▾' : '▸' }}</span>
                  {{ g.othersLabel }}
                </button>
              </td>
            </tr>
            <template v-if="open.has(g.key)">
              <tr
                v-for="l in g.others"
                :key="l.id"
                class="border-b border-calm-2 bg-calm-1/40"
                data-testid="budget-other-row"
              >
                <td class="pl-10 pr-5 py-2 text-xs text-carbon-2">
                  {{ kindWord(l) }}<span v-if="l.is_current" class="text-carbon-3"> · in force</span>
                </td>
                <td class="text-right px-5 py-2 text-xs" style="font-variant-numeric: tabular-nums">{{ fmtUsd(l.budget_usd, { whole: true }) }}</td>
                <td class="px-5 py-2 text-xs text-carbon-2">{{ periodOf(l) }}</td>
                <td class="px-5 py-2 text-right">
                  <NuxtLink :to="`/allocations/${l.id}`" class="text-xs font-bold text-carbon-2 hover:text-brand-harmony px-3">Edit →</NuxtLink>
                </td>
              </tr>
            </template>
          </template>
          <template v-if="!loadState && groups.notInForce.length > 0">
            <tr class="border-b border-calm-2">
              <td colspan="4" class="px-5 py-3">
                <button
                  type="button"
                  class="text-xs font-bold text-carbon-2 hover:text-brand-harmony cursor-pointer inline-flex items-center gap-1"
                  :aria-expanded="notInForceOpen"
                  data-testid="budget-not-in-force-toggle"
                  @click="notInForceOpen = !notInForceOpen"
                >
                  <span aria-hidden="true">{{ notInForceOpen ? '▾' : '▸' }}</span>
                  No budget in force ({{ groups.notInForce.length }})
                </button>
              </td>
            </tr>
            <template v-if="notInForceOpen">
              <template v-for="g in groups.notInForce" :key="g.key">
                <tr class="border-b border-calm-2 last:border-b-0" data-testid="budget-not-in-force-row">
                  <td class="pl-10 pr-5 py-3">
                    <div class="font-bold text-carbon-2">{{ g.name }}</div>
                    <div v-if="g.code" class="text-[11px] text-carbon-3 font-mono mt-0.5">{{ g.code }}</div>
                    <!-- Its other lines stay reachable (PO, PR 639). -->
                    <button
                      v-if="g.others.length > 0"
                      type="button"
                      class="mt-1 text-xs text-carbon-3 hover:text-brand-harmony cursor-pointer inline-flex items-center gap-1"
                      :aria-expanded="open.has(g.key)"
                      data-testid="budget-others-toggle"
                      @click="toggle(g.key)"
                    >
                      <span aria-hidden="true">{{ open.has(g.key) ? '▾' : '▸' }}</span>
                      {{ g.othersLabel }}
                    </button>
                  </td>
                  <td class="text-right px-5 py-3 text-xs" style="font-variant-numeric: tabular-nums">{{ fmtUsd(g.headline.budget_usd, { whole: true }) }}</td>
                  <td class="px-5 py-3 text-xs text-carbon-2">{{ kindWord(g.headline) }}, {{ periodOf(g.headline) }}</td>
                  <td class="px-5 py-3 text-right">
                    <NuxtLink :to="`/allocations/${g.headline.id}`" class="text-xs font-bold text-carbon-2 hover:text-brand-harmony px-3">Edit →</NuxtLink>
                  </td>
                </tr>
                <template v-if="open.has(g.key)">
                  <tr
                    v-for="l in g.others"
                    :key="l.id"
                    class="border-b border-calm-2 bg-calm-1/40"
                    data-testid="budget-other-row"
                  >
                    <td class="pl-14 pr-5 py-2 text-xs text-carbon-2">{{ kindWord(l) }}</td>
                    <td class="text-right px-5 py-2 text-xs" style="font-variant-numeric: tabular-nums">{{ fmtUsd(l.budget_usd, { whole: true }) }}</td>
                    <td class="px-5 py-2 text-xs text-carbon-2">{{ periodOf(l) }}</td>
                    <td class="px-5 py-2 text-right">
                      <NuxtLink :to="`/allocations/${l.id}`" class="text-xs font-bold text-carbon-2 hover:text-brand-harmony px-3">Edit →</NuxtLink>
                    </td>
                  </tr>
                </template>
              </template>
            </template>
          </template>
        </tbody>
      </table>
      <div
        v-if="!loadState && lines.length > 0"
        class="px-5 py-3 text-xs text-carbon-3 border-t border-calm-2 flex items-center justify-between gap-3 flex-wrap"
      >
        <span data-testid="allocations-showing">{{ showingNote }}<template v-if="loadMoreFailed"> The next page didn't load; try again.</template></span>
        <UiButton
          v-if="hasMore"
          kind="secondary"
          size="sm"
          :disabled="loadingMore"
          data-testid="allocations-load-more"
          @click="loadMore"
        >
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </UiButton>
      </div>
    </UiCard>
  </div>
</template>
