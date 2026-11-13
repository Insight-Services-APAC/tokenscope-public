<script setup lang="ts">
/*
 * Admin → Users (Wave VI). Table of teammates with an inline role
 * editor.
 *
 * Inline edit flow (#543): picking a role or a region opens a confirm
 * dialog (ConfirmActionDialog); nothing is sent until Confirm.
 *   - role: PATCH /api/v1/admin/users/:id { role }; optimistic on the row,
 *     rolled back with a refusal message on error.
 *   - self-row's dropdown is disabled (self-protection is also enforced
 *     server-side via evaluateRoleChange).
 *
 * Pagination: limit=50 offset=N. Region filter is implicit (caller's
 * home region for admin; the same for platform-admin in Wave VI — a
 * region picker lands in a later slice).
 */

import AdminResultToast from '../../components/admin/AdminResultToast.vue'
import { useResultToast } from '../../composables/useResultToast'
import { computed, nextTick, ref } from 'vue'
import { consola } from 'consola'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
import AddTeammateDialog from '../../components/admin/AddTeammateDialog.vue'
import PlaceTeammateDialog from '../../components/admin/PlaceTeammateDialog.vue'
import ConfirmActionDialog from '../../components/admin/ConfirmActionDialog.vue'
import { focusIfLost } from '../../utils/focus-fallback'
// `#shared/*` is Nuxt 4's alias for the workspace `shared/` directory.
// Relative paths from app/pages/* don't resolve at server-bundle time
// (Rollup runs from `.nuxt/dist/server/_nuxt/`, not the source path).
import { ROLE_CAPABILITIES, SELECTABLE_ROLES, roleLabel, roleWithArticle, type Role } from '#shared/auth/roles'
import { BU_LABEL } from '#shared/reports/vocabulary'
import { fmtInstant } from '../../composables/useFormat'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface UserRow extends Record<string, unknown> {
  id: string
  email: string
  displayName: string | null
  role: Role
  regionId: string
  orgUnitPath: string
  /** The BU's display name — what a human reads. `orgUnitPath` stays for the ltree. */
  orgUnitName: string
  /** Identity. The selector keys on THIS, never on a display name. */
  orgUnitId: string
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

const { session } = useSession()

const regionId = computed(() => session.value?.regionId ?? '')
const callerTeammateId = computed(() => session.value?.teammateId ?? '')

// The org-wide role (platform-admin) can browse + reassign across
// regions; a region-scoped admin stays in their own region.
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})
// All three reads are declared lazily and never awaited: navigation is never
// gated on data (docs/design/admin-nav-responsiveness.md D1/D2).
// The auxiliary reads keep their `error` too: a picker that collapses a failed
// read into `[]` is the false empty D2 forbids — "this region has no regions to
// move to" and "we could not load them" must not look alike.
const {
  data: regionsData,
  error: regionsError,
  refresh: refreshRegions,
} = useLazyFetch<{ regions: { id: string; code: string; display_name: string }[] } | null>(
  '/api/v1/admin/regions',
  { server: false, default: () => null },
)
// A link can open the page on one person: ?region=<id>&q=<email> (Org setup's top person).
const route = useRoute()
const fromQuery = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '')
const viewRegionId = ref(fromQuery('region'))
watch(regionId, (r) => { if (!viewRegionId.value && r) viewRegionId.value = r }, { immediate: true })

const query = ref(fromQuery('q'))
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

// Explicit key because the getter can be '' (D1); the watch carries the refetch.
const { data, error, refresh } = useLazyFetch<UsersResp | null>(
  () => usersUrl.value,
  {
    key: 'admin-users-list',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [usersUrl],
  },
)
const skeleton = computed(() => !error.value && data.value == null)

// Org units for the in-scope region — drive the per-row Business Unit placement
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
const {
  data: orgUnitsData,
  error: orgUnitsError,
  refresh: refreshOrgUnits,
} = useLazyFetch<{ nodes: OrgUnitNode[] } | null>(
  () => (scopeRegion.value ? `/api/v1/admin/org-units?region=${scopeRegion.value}` : ''),
  {
    key: 'admin-users-org-units',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [scopeRegion],
  },
)

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

const { toast, flashToast, dismissToast } = useResultToast()

/** What to call a person in a sentence: their name, else their email. */
function who(row: UserRow): string {
  return row.displayName?.trim() || row.email
}

/*
 * Role and region pickers do not apply on `change` (#543). They open a
 * confirm dialog; Cancel puts the select back. Like the Business Unit picker
 * below, each select is re-created from the row (its `:key` carries a nonce),
 * because the browser keeps the user's own choice in a select Vue thinks is
 * unchanged.
 */
const pendingRole = ref<{ row: UserRow; toRole: Role } | null>(null)
/*
 * Confirm applies only what the dialog described. If the row changed while it
 * was open (a refresh after another action brought in someone else's change),
 * nothing is sent and the admin looks again, as the Business Unit move does.
 */
type SinceAsked = { kind: 'unchanged' } | { kind: 'missing' } | { kind: 'changed'; live: UserRow }
function sinceAsked(row: UserRow, field: 'role' | 'regionId'): SinceAsked {
  const live = rows.value.find((r) => r.id === row.id)
  // Gone from the list (moved to another region, or filtered out by a refresh):
  // the dialog described a state we can no longer see, so it is not applied.
  if (!live) return { kind: 'missing' }
  return live[field] !== row[field] ? { kind: 'changed', live } : { kind: 'unchanged' }
}

/*
 * After a confirm, the picker that opened it may have been re-created (a
 * refusal remounts it) or removed (the row left the list), and focus would
 * fall to the page body. Put it on the row's new picker, else the search box;
 * focusIfLost leaves it alone if the reader has already moved on.
 */
async function recoverFocus(pickerTestid: string) {
  await nextTick()
  focusIfLost(`[data-testid="${pickerTestid}"]`)
  focusIfLost('[data-testid="admin-users-search"]')
}
const roleNonce = ref(0)
const pendingRegion = ref<{ row: UserRow; regionId: string; regionName: string } | null>(null)
const regionNonce = ref(0)

function askRole(row: UserRow, newRole: Role) {
  if (!newRole || newRole === row.role) return
  pendingRole.value = { row, toRole: newRole }
}

async function restoreFocus(testid: string) {
  // The remount replaces the element useModalA11y would have restored focus to.
  await nextTick()
  document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.focus()
}

async function cancelRole() {
  const rowId = pendingRole.value?.row.id
  pendingRole.value = null
  roleNonce.value++
  await restoreFocus(`admin-users-role-select-${rowId}`)
}

async function confirmRole() {
  const pending = pendingRole.value
  if (!pending) return
  pendingRole.value = null
  try {
    const since = sinceAsked(pending.row, 'role')
    if (since.kind === 'changed') {
      roleNonce.value++
      flashToast('err', `${who(since.live)} is ${roleWithArticle(since.live.role)} now, changed while that was open. Nothing was applied; check again.`)
      return
    }
    if (since.kind === 'missing') {
      flashToast('err', `${who(pending.row)} is no longer in this list. Nothing was applied; check again.`)
      return
    }
    await patchRole(pending.row, pending.toRole)
  } finally {
    await recoverFocus(`admin-users-role-select-${pending.row.id}`)
  }
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
    flashToast('ok', `${who(row)} is now ${roleWithArticle(newRole)}.`)
  } catch (err) {
    // Rollback.
    if (idx >= 0) rows.value[idx] = { ...row, role: previousRole }
    roleNonce.value++
    flashToast('err', apiErrorDetail(err, `The role change for ${who(row)} was refused.`))
    consola.warn('role change failed', err)
    return
  }
  // Outside the try: a failed re-read after a committed change is not a refusal.
  await refresh().catch((err) => consola.warn('refresh after role change failed', err))
}

// Region reassignment (org-wide roles only). New users JIT into the first
// region on first sign-in; this re-homes them. On success the row leaves the
// current view (it now belongs to another region), so refresh.
function askRegion(row: UserRow, newRegionId: string) {
  if (!newRegionId || newRegionId === row.regionId) return
  const regionName = regionsData.value?.regions.find((r) => r.id === newRegionId)?.display_name
  if (!regionName) return
  pendingRegion.value = { row, regionId: newRegionId, regionName }
}

async function cancelRegion() {
  const rowId = pendingRegion.value?.row.id
  pendingRegion.value = null
  regionNonce.value++
  await restoreFocus(`admin-users-region-${rowId}`)
}

async function confirmRegion() {
  const pending = pendingRegion.value
  if (!pending) return
  pendingRegion.value = null
  const { row, regionId: newRegionId, regionName } = pending
  try {
    const since = sinceAsked(row, 'regionId')
    if (since.kind !== 'unchanged') {
      regionNonce.value++
      flashToast(
        'err',
        since.kind === 'missing'
          ? `${who(row)} is no longer in this list. Nothing was applied; check again.`
          : `${who(row)} was moved to another region while that was open. Nothing was applied; check again.`,
      )
      return
    }
    try {
      await $fetch(`/api/v1/admin/users/${row.id}/region`, { method: 'PATCH', body: { region_id: newRegionId } })
      flashToast('ok', `${who(row)} moved to ${regionName}.`)
    } catch (err) {
      regionNonce.value++
      flashToast('err', apiErrorDetail(err, `The region move for ${who(row)} was refused.`))
      consola.warn('region reassign failed', err)
      return
    }
    // The row now belongs to another region and leaves this list, with its picker.
    await refresh().catch((err) => consola.warn('refresh after region move failed', err))
  } finally {
    await recoverFocus(`admin-users-region-${row.id}`)
  }
}

/*
 * Business Unit placement — PATCH /api/v1/admin/users/:id/org-unit.
 *
 * The picker does not apply on `change`. It opens a confirmation
 * (PlaceTeammateDialog explains why). Cancelling must put the select back:
 * the options carry `:selected` bindings rather than a v-model, so the element
 * is uncontrolled and Vue will not reconcile the user's own choice away. The
 * nonce below is in the select's `:key`, so bumping it re-creates the element
 * from the row's real placement.
 */
const pendingMove = ref<{
  row: UserRow
  unitId: string
  unitName: string
  openedAtUnitId: string
} | null>(null)
const pickerNonce = ref(0)

function askOrgUnit(row: UserRow, newUnitId: string) {
  if (!newUnitId) return
  const unit = orgUnitOptions.value.find((u) => u.id === newUnitId)
  if (!unit || unit.id === row.orgUnitId) return
  pendingMove.value = {
    row,
    unitId: unit.id,
    unitName: unit.display_name,
    /*
     * Where they were when the dialog opened. Confirmed against the row at
     * apply time: another admin can move somebody while this dialog is open.
     */
    openedAtUnitId: row.orgUnitId,
  }
}

async function cancelMove() {
  const rowId = pendingMove.value?.row.id
  pendingMove.value = null
  pickerNonce.value++
  // The remount replaces the element mid-restore, so put focus back by hand.
  await nextTick()
  document.querySelector<HTMLElement>(`[data-testid="user-orgunit-${rowId}"]`)?.focus()
}

/* Optimistic on the NAME; the refresh below makes the rest of the page agree. */
async function confirmMove() {
  const move = pendingMove.value
  if (!move) return
  const { row, unitId, unitName } = move
  pendingMove.value = null

  /*
   * The dialog described the placement as it was when it OPENED. Another admin
   * can move somebody while it is open, so this would be a move the operator
   * never saw. Refuse and make them look again, rather than applying a decision
   * made about a different state.
   */
  const liveRow = rows.value.find((r) => r.id === row.id)
  if (liveRow && liveRow.orgUnitId !== move.openedAtUnitId) {
    pickerNonce.value++
    flashToast(
      'err',
      `${row.email} was moved to ${liveRow.orgUnitName} by someone else while that was open. Nothing was applied — check again.`,
    )
    return
  }
  const previousName = row.orgUnitName
  const previousId = row.orgUnitId
  const idx = rows.value.findIndex((r) => r.id === row.id)
  if (idx >= 0) rows.value[idx] = { ...row, orgUnitName: unitName, orgUnitId: unitId }
  try {
    await $fetch(`/api/v1/admin/users/${row.id}/org-unit`, {
      method: 'PATCH',
      body: { org_unit_id: unitId },
    })
    flashToast('ok', `Moved ${row.email} to ${unitName}`)
  } catch (err) {
    if (idx >= 0) rows.value[idx] = { ...row, orgUnitName: previousName, orgUnitId: previousId }
    pickerNonce.value++
    flashToast('err', apiErrorDetail(err, `${BU_LABEL} move refused.`))
    consola.warn('org-unit move failed', err)
    return
  }
  /*
   * OUTSIDE the try, and after the toast. The refresh used to sit beside the
   * PATCH, so a transient GET failure AFTER a committed move rolled the row back
   * on screen and told the admin their move was refused — the server moved, the
   * product said it did not, and the correction most likely to be retried is one
   * that already succeeded.
   */
  await refresh().catch((err) => consola.warn('refresh after placement failed', err))
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

// #637: one Teammate column (name over email) frees the width that kept
// Actions off screen at 1200 px.
const columns = [
  { key: 'teammate', label: 'Teammate', cellClass: 'font-medium' },
  { key: 'role', label: 'Role' },
  { key: 'orgUnitName', label: BU_LABEL },
  { key: 'lastSyncAt', label: 'Last sync' },
  { key: 'actions', label: 'Actions' },
]

// An instant, so the viewer's zone; minutes are enough for a sync time (#633).
function fmtTs(v: string | null): string {
  return fmtInstant(v)
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
  return r === 'admin' || r === 'platform-admin'
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
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-users" data-admin-page="/admin/users">
    <UiPageHead
      eyebrow="Administration"
      title="Teammates"
      sub="Teammates in this region. Role, region and Business Unit changes ask first; the audit trail records every change."
    />

    <AdminResultToast :toast="toast" testid="admin-users-toast" @dismiss="dismissToast" />

    <UiFetchErrorBanner v-if="error" :error="error" label="teammates" @retry="refresh" />
    <AdminDataTable
      v-else
      :rows="rows"
      :columns="columns"
      :total="data?.total"
      :loading="skeleton"
      empty-headline="No teammates"
      empty-sub="No teammates match the current filters in this region."
    >
      <template #toolbar>
        <form class="flex items-center gap-2 flex-1 min-w-[200px]" @submit.prevent="refresh()">
          <input
            v-model="query"
            type="search"
            placeholder="Search by name or email…"
            aria-label="Search teammates by name or email"
            class="flex-1 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="admin-users-search"
            @search="refresh()"
          >
        </form>
        <select
          v-model="roleFilter"
          aria-label="Show teammates with this role"
          class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-users-role-filter"
        >
          <option value="">All roles</option>
          <option v-for="r in SELECTABLE_ROLES" :key="r" :value="r">{{ roleLabel(r) }}</option>
        </select>
        <div v-if="isOrgWide">
          <select
            v-model="viewRegionId"
            aria-label="Region to browse"
            :disabled="!regionsData"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="admin-users-region-view"
            :title="regionsError ? 'The region list could not be loaded.' : 'Browse users in another region'"
          >
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="admin-users-regions-error"
            @retry="refreshRegions"
          />
        </div>
        <UiAuxFetchError
          :error="orgUnitsError"
          :label="`${BU_LABEL}s`"
          testid="admin-users-org-units-error"
          @retry="refreshOrgUnits"
        />
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
          <!-- #637: one Teammate cell, the name in bold over the email in small
               grey (the email alone when there is no name). Both truncate,
               with the full text on hover, so the five columns fit at 1200 px. -->
          <td class="px-5 py-3 text-sm max-w-[260px]" :data-testid="`admin-users-teammate-${asUserRow(row).id}`">
            <template v-if="asUserRow(row).displayName?.trim()">
              <div class="font-bold text-carbon truncate" :title="asUserRow(row).displayName ?? undefined">{{ asUserRow(row).displayName }}</div>
              <div class="text-[11px] text-carbon-3 truncate" :title="asUserRow(row).email">{{ asUserRow(row).email }}</div>
            </template>
            <div v-else class="font-medium text-carbon truncate" :title="asUserRow(row).email">{{ asUserRow(row).email }}</div>
          </td>
          <td class="px-5 py-3 text-sm">
            <div class="flex items-center gap-2">
              <select
                :key="`${asUserRow(row).id}-role-${roleNonce}`"
                :value="asUserRow(row).role"
                :disabled="asUserRow(row).id === callerTeammateId"
                :data-testid="`admin-users-role-select-${asUserRow(row).id}`"
                :aria-label="`Role for ${asUserRow(row).displayName?.trim() || asUserRow(row).email}`"
                class="px-2 py-1 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
                :title="asUserRow(row).id === callerTeammateId ? 'You cannot change your own role.' : ''"
                @change="(e) => askRole(asUserRow(row), (e.target as HTMLSelectElement).value as Role)"
              >
                <option v-for="r in roleOptionsFor(asUserRow(row).role)" :key="r" :value="r">{{ roleLabel(r) }}</option>
              </select>
            </div>
          </td>
          <td class="px-5 py-3 text-sm">
            <select
              v-if="orgUnitOptions.length"
              :key="`${asUserRow(row).id}-${pickerNonce}`"
              :data-testid="`user-orgunit-${asUserRow(row).id}`"
              :aria-label="`${BU_LABEL} for ${asUserRow(row).displayName?.trim() || asUserRow(row).email}`"
              class="px-2 py-1 text-sm border border-calm-2 rounded-md bg-white max-w-[180px]"
              :title="`Move this teammate to another ${BU_LABEL}`"
              @change="(e) => askOrgUnit(asUserRow(row), (e.target as HTMLSelectElement).value)"
            >
              <!-- Keyed on ID. Matching on display_name left the real option
                   unselected (it was compared against the ltree PATH) and could
                   not tell two BUs apart that share a name — several regions
                   have a "CTO Office". -->
              <option value="" :selected="!orgUnitOptions.some((u) => u.id === asUserRow(row).orgUnitId)">
                {{ asUserRow(row).orgUnitName || 'Unplaced' }}
              </option>
              <option
                v-for="u in orgUnitOptions"
                :key="u.id"
                :value="u.id"
                :selected="u.id === asUserRow(row).orgUnitId"
              >{{ u.display_name }}</option>
            </select>
            <span v-else class="text-carbon-2">
              {{ asUserRow(row).orgUnitName }}
              <!-- A failed org-units read must not read as "nowhere to move
                   them to" — the toolbar notice carries the retry. -->
              <span
                v-if="orgUnitsError"
                class="text-[11px] font-semibold text-brand-hunger"
                :title="`The ${BU_LABEL} list could not be loaded, so this teammate cannot be moved. Retry above the table.`"
              >(can't move)</span>
            </span>
          </td>
          <td class="px-5 py-3 text-sm text-carbon-3 whitespace-nowrap">{{ fmtTs(asUserRow(row).lastSyncAt) }}</td>
          <td class="px-5 py-3 text-sm">
            <div class="flex flex-wrap items-center gap-2">
            <select
              v-if="isOrgWide && !regionsError"
              :key="`${asUserRow(row).id}-region-${regionNonce}`"
              :data-testid="`admin-users-region-${asUserRow(row).id}`"
              :aria-label="`Region for ${asUserRow(row).displayName?.trim() || asUserRow(row).email}`"
              :disabled="!regionsData"
              class="px-2 py-1 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
              title="Move this teammate to another region"
              @change="(e) => askRegion(asUserRow(row), (e.target as HTMLSelectElement).value)"
            >
              <option
                v-for="r in regionsData?.regions"
                :key="r.id"
                :value="r.id"
                :selected="r.id === asUserRow(row).regionId"
              >{{ r.display_name }}</option>
            </select>
            <!-- Never an empty region picker over a failed read: the toolbar
                 notice above carries the reason and the retry. -->
            <span
              v-else-if="isOrgWide"
              class="text-[11px] font-semibold text-brand-hunger"
              title="The region list could not be loaded, so this teammate cannot be re-homed. Retry above the table."
            >regions unavailable</span>
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
        {{ offset + 1 }} to {{ Math.min(offset + LIMIT, data?.total ?? 0) }} of {{ data?.total }}
      </span>
      <UiButton kind="ghost" size="sm" :disabled="offset + LIMIT >= (data?.total ?? 0)" @click="nextPage">Next →</UiButton>
    </div>

    <ConfirmActionDialog
      :open="!!pendingRole"
      eyebrow="Confirm role change"
      :title="pendingRole ? `Make ${who(pendingRole.row)} ${roleWithArticle(pendingRole.toRole)}?` : ''"
      :confirm-label="pendingRole ? `Make ${roleLabel(pendingRole.toRole)}` : ''"
      testid="role-change"
      @cancel="cancelRole"
      @confirm="confirmRole"
    >
      <template v-if="pendingRole">
        <p>{{ who(pendingRole.row) }} is {{ roleWithArticle(pendingRole.row.role) }} today.</p>
        <p v-if="ROLE_CAPABILITIES[pendingRole.toRole]">{{ ROLE_CAPABILITIES[pendingRole.toRole] }}</p>
        <p class="text-carbon-2">
          They are signed out and sign in again with the new role. The audit trail records this
          change under your name.
        </p>
      </template>
    </ConfirmActionDialog>

    <ConfirmActionDialog
      :open="!!pendingRegion"
      eyebrow="Confirm region move"
      :title="pendingRegion ? `Move ${who(pendingRegion.row)} to ${pendingRegion.regionName}?` : ''"
      confirm-label="Move region"
      testid="region-move"
      @cancel="cancelRegion"
      @confirm="confirmRegion"
    >
      <template v-if="pendingRegion">
        <p>
          {{ who(pendingRegion.row) }} is signed out and signs in again into
          {{ pendingRegion.regionName }}, unplaced there until you place them in a {{ BU_LABEL }}.
          Their devices move with them.
        </p>
        <p class="text-carbon-2">The audit trail records this change under your name.</p>
      </template>
    </ConfirmActionDialog>

    <PlaceTeammateDialog
      :open="!!pendingMove"
      :teammate-label="pendingMove?.row.email ?? ''"
      :to-unit-name="pendingMove?.unitName ?? ''"
      @cancel="cancelMove"
      @confirm="confirmMove"
    />

    <AddTeammateDialog
      :open="addOpen"
      :region-id="scopeRegion"
      :org-units="orgUnitOptions"
      :org-units-error="orgUnitsError"
      :caller-role="session?.role ?? ''"
      @close="addOpen = false"
      @added="onTeammateAdded"
      @retry-org-units="refreshOrgUnits"
    />
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/users">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
