<script setup lang="ts">
/*
 * Admin → Users (Wave VI). Table of teammates with an inline role
 * editor.
 *
 * Inline edit flow:
 *   - select-on-blur → PATCH /api/v1/admin/users/:id { role }
 *   - optimistic UI: row's role updates locally; on error roll back +
 *     toast.
 *   - self-row's dropdown is disabled (self-protection is also enforced
 *     server-side via evaluateRoleChange).
 *   - last-admin badge surfaces when the row is the sole admin in the
 *     region — the server enforces the demotion block; the UI surfaces
 *     why a future drop will refuse.
 *
 * Pagination: limit=50 offset=N. Region filter is implicit (caller's
 * home region for admin; the same for global-finops in Wave VI — a
 * region picker lands in a later slice).
 */

import { computed, ref } from 'vue'
import { consola } from 'consola'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
import AddTeammateDialog from '../../components/admin/AddTeammateDialog.vue'
// `#shared/*` is Nuxt 4's alias for the workspace `shared/` directory.
// Relative paths from app/pages/* don't resolve at server-bundle time
// (Rollup runs from `.nuxt/dist/server/_nuxt/`, not the source path).
import { SELECTABLE_ROLES, roleLabel, type Role } from '#shared/auth/roles'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface UserRow extends Record<string, unknown> {
  id: string
  email: string
  displayName: string | null
  role: Role
  regionId: string
  orgUnitPath: string
  isActive: boolean
  joinedAt: string
  lastSyncAt: string | null
}

interface UsersResp {
  users: UserRow[]
  total: number
  adminCount: number
  limit: number
  offset: number
}

const { session, ensure } = useSession()
await ensure()

const regionId = computed(() => session.value?.regionId ?? '')
const callerTeammateId = computed(() => session.value?.teammateId ?? '')

// Org-wide roles (global-finops / platform-admin) can browse + reassign across
// regions; a region-scoped admin stays in their own region.
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'global-finops' || r === 'platform-admin'
})
// Regions list — independent of the users + org-units fetches below; all three
// are launched without an immediate await and awaited together (parallel) so
// the page blocks on the slowest, not the sum. See the Promise.all after the
// org-units fetch.
const regionsAsync = useFetch<{ regions: { id: string; code: string; display_name: string }[] }>(
  '/api/v1/admin/regions',
  { default: () => ({ regions: [] }) },
)
const regionsData = regionsAsync.data
const viewRegionId = ref('')
watch(regionId, (r) => { if (!viewRegionId.value && r) viewRegionId.value = r }, { immediate: true })

const query = ref('')
const roleFilter = ref<Role | ''>('')
const offset = ref(0)
const LIMIT = 50

// FE-4: any filter change restarts pagination at page 1 — otherwise a page-2
// offset against a now-smaller result set renders a falsely empty list.
watch([query, roleFilter, viewRegionId], () => {
  offset.value = 0
})

const usersUrl = computed(() => {
  const rid = isOrgWide.value ? (viewRegionId.value || regionId.value) : regionId.value
  if (!rid) return ''
  const parts = [`region=${rid}`, `limit=${LIMIT}`, `offset=${offset.value}`]
  if (query.value) parts.push(`q=${encodeURIComponent(query.value)}`)
  if (roleFilter.value) parts.push(`role=${roleFilter.value}`)
  return `/api/v1/admin/users?${parts.join('&')}`
})

const usersAsync = useFetch<UsersResp>(
  () => usersUrl.value,
  {
    default: () => ({ users: [], total: 0, adminCount: 0, limit: LIMIT, offset: 0 }),
    immediate: !!regionId.value,
    watch: [usersUrl],
  },
)
const { data, refresh, pending } = usersAsync

// Org units for the in-scope region — drive the per-row cost-centre placement
// select + the Add-teammate dialog. Region admins see their own region; org-wide
// roles see the selected view region.
interface OrgUnitNode {
  id: string
  display_name: string
  is_active?: boolean
}
const scopeRegion = computed(() =>
  isOrgWide.value ? (viewRegionId.value || regionId.value) : regionId.value,
)
const orgUnitsAsync = useFetch<{ nodes: OrgUnitNode[] }>(
  () => (scopeRegion.value ? `/api/v1/admin/org-units?region=${scopeRegion.value}` : ''),
  {
    default: () => ({ nodes: [] }),
    immediate: !!regionId.value,
    watch: [scopeRegion],
  },
)
const orgUnitsData = orgUnitsAsync.data

// All three reads (regions list, users page, org-units) are independent — block
// on the slowest, not their sum.
await Promise.all([regionsAsync, usersAsync, orgUnitsAsync])
// Active units only for placement (a retired unit shouldn't be a target).
const orgUnitOptions = computed<{ id: string; display_name: string }[]>(() =>
  (orgUnitsData.value?.nodes ?? [])
    .filter((n) => n.is_active !== false)
    .map((n) => ({ id: n.id, display_name: n.display_name })),
)

// Local mutable copy so optimistic role updates surface immediately.
const rows = ref<UserRow[]>([])
watch(
  () => data.value?.users,
  (next) => { rows.value = next ? [...next] : [] },
  { immediate: true },
)

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

async function patchRole(row: UserRow, newRole: Role) {
  const previousRole = row.role
  if (previousRole === newRole) return
  // Optimistic.
  const idx = rows.value.findIndex((r) => r.id === row.id)
  if (idx >= 0) rows.value[idx] = { ...row, role: newRole }
  try {
    await $fetch(`/api/v1/admin/users/${row.id}`, {
      method: 'PATCH',
      body: { role: newRole },
    })
    flashToast('ok', `Role updated: ${row.email} → ${newRole}`)
    await refresh()
  } catch (err) {
    // Rollback.
    if (idx >= 0) rows.value[idx] = { ...row, role: previousRole }
    flashToast('err', apiErrorDetail(err, 'Role change refused.'))
    consola.warn('role change failed', err)
  }
}

// Region reassignment (org-wide roles only). New users JIT into APAC on first
// sign-in; this re-homes them. On success the row leaves the current view
// (it now belongs to another region), so refresh.
async function reassignRegion(row: UserRow, newRegionId: string) {
  if (!newRegionId || newRegionId === row.regionId) return
  try {
    await $fetch(`/api/v1/admin/users/${row.id}/region`, { method: 'PATCH', body: { region_id: newRegionId } })
    const rname = regionsData.value?.regions.find((r) => r.id === newRegionId)?.display_name ?? 'new region'
    flashToast('ok', `${row.email} moved to ${rname}`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Region change refused.'))
    consola.warn('region reassign failed', err)
  }
}

/*
 * Cost-centre placement — PATCH /api/v1/admin/users/:id/org-unit { org_unit_id }.
 * Optimistic: the row's orgUnitPath is replaced with the chosen unit's
 * display_name immediately; on error roll back + toast. The server enforces the
 * unit being active in the region (422).
 */
async function patchOrgUnit(row: UserRow, newUnitId: string) {
  if (!newUnitId) return
  const previousPath = row.orgUnitPath
  const unit = orgUnitOptions.value.find((u) => u.id === newUnitId)
  const idx = rows.value.findIndex((r) => r.id === row.id)
  if (idx >= 0 && unit) rows.value[idx] = { ...row, orgUnitPath: unit.display_name }
  try {
    await $fetch(`/api/v1/admin/users/${row.id}/org-unit`, {
      method: 'PATCH',
      body: { org_unit_id: newUnitId },
    })
    flashToast('ok', `Moved ${row.email} to ${unit?.display_name ?? 'new unit'}`)
    await refresh()
  } catch (err) {
    if (idx >= 0) rows.value[idx] = { ...row, orgUnitPath: previousPath }
    flashToast('err', apiErrorDetail(err, 'Cost-centre move refused.'))
    consola.warn('org-unit move failed', err)
  }
}

// Add-teammate dialog (directory provisioning).
const addOpen = ref(false)
async function onTeammateAdded() {
  addOpen.value = false
  flashToast('ok', 'Teammate added.')
  offset.value = 0
  await refresh()
}

/*
 * Force-sign-out — Wave VII. POSTs to
 * /api/v1/admin/users/:id/revoke-sessions, which bumps
 * teammate.revoked_at = NOW() and writes a teammate-sessions-revoked
 * audit row. The target's existing browser cookie is invalidated by
 * validate-session middleware on the next /api/v1/** request.
 *
 * Optimistic UX: flash toast immediately on the POST resolving. Self-
 * row prompts a `confirm()` to avoid accidental lock-out (the action
 * IS allowed server-side — self-revoke from another device is a
 * legitimate use). Server-side audit makes the action permanent in
 * the audit trail.
 */
const revoking = ref<Set<string>>(new Set())

async function revokeSessions(row: UserRow) {
  const isSelf = row.id === callerTeammateId.value
  if (isSelf) {
    if (!confirm(
      `Force sign-out yourself? You will be signed out on your next request from any device using your current session.`,
    )) return
  }
  revoking.value = new Set([...revoking.value, row.id])
  try {
    await $fetch(`/api/v1/admin/users/${row.id}/revoke-sessions`, {
      method: 'POST',
      body: {},
    })
    flashToast(
      'ok',
      isSelf
        ? `Sign-out requested for yourself.`
        : `Sign-out requested: ${row.email}`,
    )
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Force sign-out failed.'))
    consola.warn('revoke sessions failed', err)
  } finally {
    const next = new Set(revoking.value)
    next.delete(row.id)
    revoking.value = next
  }
}

const adminCount = computed(() => data.value?.adminCount ?? 0)

function isLastAdmin(row: UserRow): boolean {
  return row.role === 'admin' && adminCount.value <= 1
}

const columns = [
  { key: 'email', label: 'Email', cellClass: 'font-medium' },
  { key: 'displayName', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'orgUnitPath', label: 'Org unit' },
  { key: 'lastSyncAt', label: 'Last sync' },
  { key: 'actions', label: 'Actions' },
]

function fmtTs(v: string | null): string {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}

// Typed cast for the slot binding — AdminDataTable's row slot is
// Record<string, unknown> by design; the page narrows back so cells
// type-check against the UserRow shape.
function asUserRow(row: Record<string, unknown>): UserRow {
  return row as unknown as UserRow
}

function nextPage() {
  if (offset.value + LIMIT < (data.value?.total ?? 0)) offset.value += LIMIT
}
function prevPage() {
  offset.value = Math.max(0, offset.value - LIMIT)
}

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})

// Options for a row's role <select>: the assignable roles PLUS the row's own
// current value if it sits OUTSIDE the assignable set (a legacy `finance`
// zombie). Without this the native select silently drops the value, hiding
// which teammates still carry a retired role. roleLabel renders it as
// "Finance (retired)" so it reads as an unassignable, migration-worthy state.
function roleOptionsFor(current: string): Role[] {
  return current && !SELECTABLE_ROLES.includes(current as Role)
    ? [...SELECTABLE_ROLES, current as Role]
    : [...SELECTABLE_ROLES]
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-users">
    <UiPageHead
      eyebrow="Administration"
      title="Teammates"
      sub="Teammates in this region. Change role via the dropdown; the audit trail records every change."
    />

    <div
      v-if="toast"
      :data-testid="`admin-users-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <AdminDataTable
      :rows="rows"
      :columns="columns"
      :total="data?.total"
      :loading="pending"
      empty-headline="No teammates"
      empty-sub="No teammates match the current filters in this region."
    >
      <template #toolbar>
        <form class="flex items-center gap-2 flex-1 min-w-[200px]" @submit.prevent="refresh()">
          <input
            v-model="query"
            type="search"
            placeholder="Search by name or email…"
            class="flex-1 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
            data-testid="admin-users-search"
            @search="refresh()"
          >
        </form>
        <select
          v-model="roleFilter"
          class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-users-role-filter"
        >
          <option value="">All roles</option>
          <option v-for="r in SELECTABLE_ROLES" :key="r" :value="r">{{ roleLabel(r) }}</option>
        </select>
        <select
          v-if="isOrgWide"
          v-model="viewRegionId"
          class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-users-region-view"
          title="Browse users in another region"
        >
          <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
        </select>
        <UiButton
          kind="primary"
          size="sm"
          data-testid="user-add-open"
          title="Provision a teammate from the directory into this region"
          @click="addOpen = true"
        >
          + Add teammate
        </UiButton>
      </template>
      <template #row="{ row }">
        <tr
          :data-testid="`admin-users-row-${asUserRow(row).id}`"
          class="hover:bg-brand-harmony-sheer/30"
        >
          <td class="px-5 py-3 text-sm text-carbon font-medium">{{ asUserRow(row).email }}</td>
          <td class="px-5 py-3 text-sm text-carbon">{{ asUserRow(row).displayName ?? '—' }}</td>
          <td class="px-5 py-3 text-sm">
            <div class="flex items-center gap-2">
              <select
                :value="asUserRow(row).role"
                :disabled="asUserRow(row).id === callerTeammateId"
                :data-testid="`admin-users-role-select-${asUserRow(row).id}`"
                class="px-2 py-1 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
                :title="asUserRow(row).id === callerTeammateId ? 'You cannot change your own role.' : ''"
                @change="(e) => patchRole(asUserRow(row), (e.target as HTMLSelectElement).value as Role)"
              >
                <option v-for="r in roleOptionsFor(asUserRow(row).role)" :key="r" :value="r">{{ roleLabel(r) }}</option>
              </select>
              <UiBadge
                v-if="isLastAdmin(asUserRow(row))"
                kind="hunger"
                :data-testid="`admin-users-last-admin-${asUserRow(row).id}`"
                title="Sole admin in this region — demoting this row is blocked server-side."
              >Last admin</UiBadge>
            </div>
          </td>
          <td class="px-5 py-3 text-sm text-carbon-2">{{ asUserRow(row).orgUnitPath }}</td>
          <td class="px-5 py-3 text-sm text-carbon-3">{{ fmtTs(asUserRow(row).lastSyncAt) }}</td>
          <td class="px-5 py-3 text-sm">
            <div class="flex items-center gap-2">
            <select
              v-if="orgUnitOptions.length"
              :data-testid="`user-orgunit-${asUserRow(row).id}`"
              class="px-2 py-1 text-sm border border-calm-2 rounded-md bg-white max-w-[180px]"
              title="Move this teammate to another cost centre (org unit)"
              @change="(e) => patchOrgUnit(asUserRow(row), (e.target as HTMLSelectElement).value)"
            >
              <option value="" :selected="!orgUnitOptions.some((u) => u.display_name === asUserRow(row).orgUnitPath)">
                {{ asUserRow(row).orgUnitPath || 'Unplaced' }}
              </option>
              <option
                v-for="u in orgUnitOptions"
                :key="u.id"
                :value="u.id"
                :selected="u.display_name === asUserRow(row).orgUnitPath"
              >{{ u.display_name }}</option>
            </select>
            <select
              v-if="isOrgWide"
              :data-testid="`admin-users-region-${asUserRow(row).id}`"
              class="px-2 py-1 text-sm border border-calm-2 rounded-md bg-white"
              title="Move this teammate to another region"
              @change="(e) => reassignRegion(asUserRow(row), (e.target as HTMLSelectElement).value)"
            >
              <option
                v-for="r in regionsData?.regions"
                :key="r.id"
                :value="r.id"
                :selected="r.id === asUserRow(row).regionId"
              >{{ r.display_name }}</option>
            </select>
            <UiButton
              kind="ghost"
              size="sm"
              :data-testid="`admin-users-revoke-${asUserRow(row).id}`"
              :disabled="revoking.has(asUserRow(row).id)"
              :title="asUserRow(row).id === callerTeammateId
                ? 'Force sign-out yourself — confirms before applying.'
                : 'Force sign-out: invalidates this teammate\'s existing sessions.'"
              @click="revokeSessions(asUserRow(row))"
            >
              <span v-if="revoking.has(asUserRow(row).id)">…</span>
              <span v-else>Force sign-out</span>
            </UiButton>
            </div>
          </td>
        </tr>
      </template>
    </AdminDataTable>

    <div v-if="(data?.total ?? 0) > LIMIT" class="mt-4 flex items-center justify-end gap-3">
      <UiButton kind="ghost" size="sm" :disabled="offset === 0" @click="prevPage">← Prev</UiButton>
      <span class="text-xs text-carbon-3">
        {{ offset + 1 }}–{{ Math.min(offset + LIMIT, data?.total ?? 0) }} of {{ data?.total }}
      </span>
      <UiButton kind="ghost" size="sm" :disabled="offset + LIMIT >= (data?.total ?? 0)" @click="nextPage">Next →</UiButton>
    </div>

    <AddTeammateDialog
      :open="addOpen"
      :region-id="scopeRegion"
      :org-units="orgUnitOptions"
      :caller-role="session?.role ?? ''"
      @close="addOpen = false"
      @added="onTeammateAdded"
    />
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
