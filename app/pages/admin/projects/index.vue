<script setup lang="ts">
/*
 * Admin → Projects (top-level). Promotes the per-region Projects tab to a
 * first-class admin page with edit / retire / member management.
 *
 * Region scope mirrors Admin → Users: the org-wide role (
 * platform-admin) get a region-view picker (defaults to their own region);
 * region admins are pinned to their own region.
 *
 * Search, filters and paging run ON THE SERVER (#582): the list used to stop at
 * the first 50 projects by code with nothing to reach the rest. The pattern is
 * Admin → Teammates': limit=50 offset=N, and any filter change restarts at
 * page 1 (a page-2 offset against a smaller result set renders a false empty).
 */

import AdminResultToast from '../../../components/admin/AdminResultToast.vue'
import { useResultToast } from '../../../composables/useResultToast'
import { computed, ref } from 'vue'
import { ADMIN_LIST_SEARCH_MAX } from '#shared/schemas/admin-list-search'
import { consola } from 'consola'
import EntityTable from '../../../components/admin/EntityTable.vue'
import AdminPageSkeleton from '../../../components/admin/AdminPageSkeleton.vue'
import ProjectMembersModal from '../../../components/admin/ProjectMembersModal.vue'
import ProjectEditDialog, { type ProjectEditTarget } from '../../../components/admin/ProjectEditDialog.vue'
import SetBudgetDialog, { type SetBudgetTarget } from '../../../components/admin/SetBudgetDialog.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface ProjectRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  client_facing_name?: string | null
  wbs_code?: string | null
  type: string
  cou_display_name: string | null
  cost_owning_unit_id: string | null
  is_onboarded: boolean
  repo_count: number
  is_authorised: boolean
  end_date: string | null
  ended: boolean
  deletable: boolean
  has_spend: boolean
  member_count: number
  has_budget: boolean
  /** Current shared-pool baseline allocation id; null = no budget yet. Drives the Budget link. */
  allocation_id: string | null
}

interface OrgUnit {
  id: string
  display_name: string
  is_cost_owning_unit: boolean
}

const { session } = useSession()

const regionId = computed(() => session.value?.regionId ?? '')

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})

// All three reads are declared lazily and never awaited: navigation is never
// gated on data, and the skeleton keys on ABSENT data, not `pending`
// (docs/design/admin-nav-responsiveness.md D1/D2). The two auxiliary reads keep
// their `error` as well — a picker that collapses failure into `[]` is the false
// empty D2 forbids.
const {
  data: regionsData,
  error: regionsError,
  refresh: refreshRegions,
} = useLazyFetch<{ regions: { id: string; code: string; display_name: string }[] } | null>(
  '/api/v1/admin/regions',
  { server: false, default: () => null },
)
const viewRegionId = ref('')
watch(regionId, (r) => { if (!viewRegionId.value && r) viewRegionId.value = r }, { immediate: true })

const effectiveRegion = computed(() =>
  isOrgWide.value ? (viewRegionId.value || regionId.value) : regionId.value,
)

const query = ref('')
const statusFilter = ref<'' | 'active' | 'ended'>('')
const noBudgetOnly = ref(false)
const offset = ref(0)
const LIMIT = 50
watch([query, statusFilter, noBudgetOnly, effectiveRegion], () => {
  offset.value = 0
})
const filtering = computed(() => query.value.trim() !== '' || statusFilter.value !== '' || noBudgetOnly.value)

const projectsUrl = computed(() => {
  if (!effectiveRegion.value) return ''
  const parts = [`region=${effectiveRegion.value}`, `limit=${LIMIT}`, `offset=${offset.value}`]
  const q = query.value.trim()
  if (q) parts.push(`q=${encodeURIComponent(q)}`)
  if (statusFilter.value) parts.push(`status=${statusFilter.value}`)
  if (noBudgetOnly.value) parts.push('budget=none')
  return `/api/v1/admin/projects?${parts.join('&')}`
})

function nextPage() {
  if (offset.value + LIMIT < (data.value?.total ?? 0)) offset.value += LIMIT
}
function prevPage() {
  offset.value = Math.max(0, offset.value - LIMIT)
}

// Explicit keys below because these getters can be '' (D1); the watch carries the refetch.
const { data, error, refresh } = useLazyFetch<{ projects: ProjectRow[]; total: number; offset: number } | null>(
  () => projectsUrl.value,
  {
    key: 'admin-projects-list',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [projectsUrl],
  },
)
const skeleton = computed(() => !error.value && data.value == null)

// A page can empty under the reader: ending, deleting or revoking the last row on
// the final page shrinks the total behind them. Step back to the last page that
// exists rather than strand them on an empty one with no pager to leave by.
watch(
  () => data.value?.total,
  (total) => {
    if (total == null || offset.value === 0 || offset.value < total) return
    offset.value = total === 0 ? 0 : Math.floor((total - 1) / LIMIT) * LIMIT
  },
)

const {
  data: orgUnitsData,
  error: orgUnitsError,
  refresh: refreshOrgUnits,
} = useLazyFetch<{ nodes: OrgUnit[] } | null>(
  () => (effectiveRegion.value ? `/api/v1/admin/org-units?region=${effectiveRegion.value}` : ''),
  {
    key: 'admin-projects-org-units',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [effectiveRegion],
  },
)

// Prefer cost-owning units for the project COU select; fall back to all nodes
// if none are flagged (older regions may pre-date the attribute).
const couOptions = computed<{ id: string; display_name: string }[]>(() => {
  const nodes = orgUnitsData.value?.nodes ?? []
  const owning = nodes.filter((n) => n.is_cost_owning_unit)
  return (owning.length > 0 ? owning : nodes).map((n) => ({ id: n.id, display_name: n.display_name }))
})

const { toast, flashToast, dismissToast } = useResultToast()

const columns = [
  { key: 'code', label: 'Code' },
  { key: 'display_name', label: 'Display name' },
  { key: 'wbs_code', label: 'WBS' },
  { key: 'cou_display_name', label: 'Business Unit' },
  { key: 'type', label: 'Type' },
  {
    key: 'is_onboarded',
    label: 'Onboarded',
    render: (r: Record<string, unknown>) => (r.is_onboarded ? 'Yes' : 'Catalogue'),
  },
  { key: 'repo_count', label: 'Repos' },
]

function asProjectRow(row: Record<string, unknown>): ProjectRow {
  return row as unknown as ProjectRow
}

// Edit dialog.
const editTarget = ref<ProjectEditTarget | null>(null)
function openEdit(row: ProjectRow) {
  editTarget.value = {
    id: row.id,
    code: row.code,
    display_name: row.display_name,
    client_facing_name: row.client_facing_name ?? null,
    wbs_code: row.wbs_code ?? null,
    type: row.type,
    cost_owning_unit_id: row.cost_owning_unit_id,
    is_authorised: row.is_authorised,
  }
}
async function onEdited() {
  editTarget.value = null
  flashToast('ok', 'Project updated.')
  await refresh()
}

// Set-first-baseline-budget dialog (recovery for budget-less projects).
const budgetProject = ref<SetBudgetTarget | null>(null)
async function onBudgetSet() {
  budgetProject.value = null
  flashToast('ok', 'Baseline budget created.')
  await refresh()
}

// Members modal (reused as-is).
const membersProject = ref<{ id: string; code: string; display_name: string } | null>(null)

// Lifecycle actions. "End now" sets end_date = now (the old "retire"); spend
// after the grace window spills to unallocated until re-tagged (D2). "Delete"
// is a hard removal, offered only for provably-empty projects (D4 `deletable`).
const mutating = ref<Set<string>>(new Set())
function markBusy(id: string, busy: boolean) {
  const next = new Set(mutating.value)
  if (busy) next.add(id)
  else next.delete(id)
  mutating.value = next
}
async function endNow(row: ProjectRow) {
  if (
    !confirm(
      `End ${row.display_name} (${row.code}) now? It stops accepting new spend; in-flight work past the grace window spills to unallocated until re-tagged.`,
    )
  )
    return
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/projects/${row.id}`, {
      method: 'PATCH',
      body: { end_date: new Date().toISOString() },
    })
    flashToast('ok', `Ended ${row.code}.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'End refused.'))
    consola.warn('project end failed', err)
  } finally {
    markBusy(row.id, false)
  }
}
async function reopen(row: ProjectRow) {
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/projects/${row.id}`, { method: 'PATCH', body: { end_date: null } })
    flashToast('ok', `Re-opened ${row.code}.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Re-open refused.'))
    consola.warn('project reopen failed', err)
  } finally {
    markBusy(row.id, false)
  }
}
// Why a $0-spend project can't be deleted (spend / tagged repos are the only
// hard blockers; budget + members cascade). Shown on the disabled control.
function deleteBlockedReason(row: ProjectRow): string {
  const parts: string[] = []
  if (row.has_spend) parts.push('attributed spend')
  if (row.repo_count > 0) parts.push(`${row.repo_count} tagged repo${row.repo_count === 1 ? '' : 's'}`)
  return `Can't delete — has ${parts.join(' and ')}. End it instead.`
}
async function remove(row: ProjectRow) {
  const extras: string[] = []
  if (row.has_budget) extras.push('its budget')
  if (row.member_count > 0) extras.push(`${row.member_count} member${row.member_count === 1 ? '' : 's'}`)
  const tail = extras.length ? ` This also removes ${extras.join(' and ')}.` : ''
  if (!confirm(`Permanently DELETE ${row.display_name} (${row.code})?${tail} This cannot be undone.`)) return
  markBusy(row.id, true)
  try {
    await $fetch(`/api/v1/admin/projects/${row.id}`, { method: 'DELETE' })
    flashToast('ok', `Deleted ${row.code}.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Delete refused.'))
    consola.warn('project delete failed', err)
  } finally {
    markBusy(row.id, false)
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-projects" data-admin-page="/admin/projects">
    <UiPageHead
      eyebrow="Administration"
      title="Projects"
      sub="Projects in this region. Create projects, edit budgets and owners, manage members."
    >
      <template #actions>
        <!-- #632: the way in to the project budgets list. -->
        <NuxtLink
          to="/allocations"
          class="text-sm font-bold text-brand-harmony hover:underline whitespace-nowrap self-center"
          data-testid="admin-projects-budgets-link"
        >
          Project budgets →
        </NuxtLink>
        <div v-if="isOrgWide">
          <select
            v-model="viewRegionId"
            :disabled="!regionsData"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="admin-projects-region-view"
            :title="regionsError ? 'The region list could not be loaded.' : 'Browse projects in another region'"
          >
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="admin-projects-regions-error"
            @retry="refreshRegions"
          />
        </div>
      </template>
    </UiPageHead>

    <AdminResultToast :toast="toast" testid="admin-projects-toast" @dismiss="dismissToast" />

    <UiFetchErrorBanner v-if="error" :error="error" label="projects" @retry="refresh" />
    <AdminPageSkeleton v-else-if="skeleton" :rows="6" />
    <EntityTable
      v-else
      entity-label="Projects"
      :rows="data?.projects ?? []"
      :columns="columns"
      :total="data?.total"
      :server-offset="data?.offset ?? offset"
      wrap-actions
      add-to="/projects/new"
      :empty-headline="filtering ? 'No matching projects' : undefined"
      :empty-sub="filtering ? 'No projects in this region match the search and filters.' : undefined"
    >
      <template #toolbar>
        <form class="flex items-center gap-2 flex-1 min-w-[200px]" role="search" @submit.prevent="refresh()">
          <input
            v-model="query"
            type="search"
            :maxlength="ADMIN_LIST_SEARCH_MAX"
            placeholder="Search by code or name…"
            aria-label="Search projects by code or name"
            class="flex-1 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="admin-projects-search"
          >
        </form>
        <select
          v-model="statusFilter"
          aria-label="Show projects by status"
          class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-projects-status-filter"
        >
          <option value="">Active and ended</option>
          <option value="active">Active</option>
          <option value="ended">Ended</option>
        </select>
        <label class="inline-flex items-center gap-2 text-sm text-carbon-2">
          <input
            v-model="noBudgetOnly"
            type="checkbox"
            class="w-4 h-4 accent-brand-harmony"
            data-testid="admin-projects-no-budget-filter"
          >
          No budget
        </label>
      </template>
      <template #rowActions="{ row }">
        <div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <UiButton
            kind="ghost"
            size="sm"
            :data-testid="`project-edit-${asProjectRow(row).id}`"
            @click="openEdit(asProjectRow(row))"
          >
            Edit
          </UiButton>
          <UiButton
            v-if="asProjectRow(row).allocation_id"
            kind="ghost"
            size="sm"
            :to="`/allocations/${asProjectRow(row).allocation_id}?focus=topup`"
            :data-testid="`project-budget-${asProjectRow(row).id}`"
            title="Edit this project's budget — add a top-up"
          >
            Budget
          </UiButton>
          <UiButton
            v-else
            kind="ghost"
            size="sm"
            :data-testid="`project-budget-${asProjectRow(row).id}`"
            title="No budget yet — set the baseline budget"
            @click="budgetProject = { id: asProjectRow(row).id, code: asProjectRow(row).code, display_name: asProjectRow(row).display_name }"
          >
            Set budget
          </UiButton>
          <UiButton
            kind="ghost"
            size="sm"
            :data-testid="`project-members-${asProjectRow(row).id}`"
            @click="membersProject = { id: asProjectRow(row).id, code: asProjectRow(row).code, display_name: asProjectRow(row).display_name }"
          >
            Members
          </UiButton>
          <UiBadge
            v-if="asProjectRow(row).ended"
            kind="neutral"
            :data-testid="`project-ended-${asProjectRow(row).id}`"
            title="This project has ended. New spend spills to unallocated."
          >
            Ended
          </UiBadge>
          <UiButton
            v-if="!asProjectRow(row).ended"
            kind="ghost"
            size="sm"
            :disabled="mutating.has(asProjectRow(row).id)"
            :data-testid="`project-end-${asProjectRow(row).id}`"
            @click="endNow(asProjectRow(row))"
          >
            {{ mutating.has(asProjectRow(row).id) ? '…' : 'End' }}
          </UiButton>
          <UiButton
            v-else
            kind="ghost"
            size="sm"
            :disabled="mutating.has(asProjectRow(row).id)"
            :data-testid="`project-reopen-${asProjectRow(row).id}`"
            @click="reopen(asProjectRow(row))"
          >
            {{ mutating.has(asProjectRow(row).id) ? '…' : 'Re-open' }}
          </UiButton>
          <UiButton
            v-if="asProjectRow(row).deletable"
            kind="ghost"
            size="sm"
            :disabled="mutating.has(asProjectRow(row).id)"
            :data-testid="`project-delete-${asProjectRow(row).id}`"
            title="Permanently delete. Its budget and members are removed too (no spend)."
            @click="remove(asProjectRow(row))"
          >
            Delete
          </UiButton>
          <span
            v-else
            class="text-[11px] text-carbon-3 italic cursor-help"
            :title="deleteBlockedReason(asProjectRow(row))"
            :data-testid="`project-delete-blocked-${asProjectRow(row).id}`"
          >
            can't delete
          </span>
        </div>
      </template>
    </EntityTable>

    <div v-if="!error && !skeleton && ((data?.total ?? 0) > LIMIT || offset > 0)" class="mt-4 flex items-center justify-end gap-3" data-testid="admin-projects-pager">
      <UiButton kind="ghost" size="sm" :disabled="offset === 0" data-testid="admin-projects-prev" @click="prevPage">← Previous</UiButton>
      <UiButton kind="ghost" size="sm" :disabled="offset + LIMIT >= (data?.total ?? 0)" data-testid="admin-projects-next" @click="nextPage">Next →</UiButton>
    </div>

    <ProjectEditDialog
      :project="editTarget"
      :cou-options="couOptions"
      :cou-options-error="orgUnitsError"
      @close="editTarget = null"
      @saved="onEdited"
      @retry-cou-options="refreshOrgUnits"
    />

    <ProjectMembersModal
      :project="membersProject"
      @close="membersProject = null"
      @changed="refresh()"
    />

    <SetBudgetDialog
      :project="budgetProject"
      @close="budgetProject = null"
      @saved="onBudgetSet"
    />
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/projects">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
