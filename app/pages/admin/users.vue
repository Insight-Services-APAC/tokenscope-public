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

import { computed, nextTick, ref } from 'vue'
import { consola } from 'consola'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
import AddTeammateDialog from '../../components/admin/AddTeammateDialog.vue'
import PlaceTeammateDialog from '../../components/admin/PlaceTeammateDialog.vue'
// `#shared/*` is Nuxt 4's alias for the workspace `shared/` directory.
// Relative paths from app/pages/* don't resolve at server-bundle time
// (Rollup runs from `.nuxt/dist/server/_nuxt/`, not the source path).
import { SELECTABLE_ROLES, roleLabel, type Role } from '#shared/auth/roles'
import { BU_LABEL } from '#shared/reports/vocabulary'
import { formatUsd } from '../../utils/money'
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

// Org-wide roles (global-finops / platform-admin) can browse + reassign across
// regions; a region-scoped admin stays in their own region.
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'global-finops' || r === 'platform-admin'
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

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  /*
   * ANY later message clears the receipt. It renders in the toast's slot and
   * takes precedence, so leaving Alice's success on screen would swallow Bob's
   * refusal entirely — the operator would see a green panel about somebody else
   * and believe their own action worked.
   */
  moveResult.value = null
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
 * Business Unit placement — PATCH /api/v1/admin/users/:id/org-unit.
 *
 * The picker no longer applies on `change`. It opens a confirmation, because
 * the same control can now also restate months of reported usage
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
  sameUnit: boolean
  /** Opened by changing the picker (needs a reset on cancel) vs the repair button. */
  viaPicker: boolean
  openedAtUnitId: string
} | null>(null)
const pickerNonce = ref(0)

/**
 * The RECEIPT for a correction that moved money, held until dismissed.
 *
 * A toast is right for "role updated" and wrong for "eleven thousand dollars now
 * reports somewhere else": that one is read, checked, and sometimes screenshotted
 * for whoever in finance asked for it.
 */
const moveResult = ref<{
  email: string
  unitName: string
  placementChanged: boolean
  /** Everything that moved, INCLUDING the derived rollups — "did anything happen". */
  total: number
  /** The ledger rows alone — what the headline counts, so it matches its own list. */
  ledgerRows: number
  /** What the operator was shown and agreed to. Null when they never checked. */
  approvedUsd: number | null
  /** Everything recorded in the range. Distinguishes "none" from "already here". */
  rangeUsd: number | null
  rows: {
    attributionRows: number
    unaccountedRows: number
    overEmissionRows: number
    actualSpendRows: number
    reconciliationRows: number
    rollupRows: number
  }
} | null>(null)

function askOrgUnit(row: UserRow, newUnitId: string) {
  if (!newUnitId) return
  const unit = orgUnitOptions.value.find((u) => u.id === newUnitId)
  if (!unit) return
  pendingMove.value = {
    row,
    unitId: unit.id,
    unitName: unit.display_name,
    sameUnit: unit.id === row.orgUnitId,
    viaPicker: true,
    /*
     * Where they were when the dialog opened. Confirmed against the row at
     * apply time: another admin can move somebody while this dialog is open,
     * and "their placement will not change" would then be a promise the write
     * breaks.
     */
    openedAtUnitId: row.orgUnitId,
  }
}

/*
 * ── THE REPAIR NEEDS ITS OWN CONTROL ─────────────────────────────────────────
 * A `<select>` fires no `change` event when you pick the option that is already
 * selected, so "choose the unit they are already in" is not something a person
 * can do — even though the server supports exactly that as a history-only
 * repair. Playwright's `selectOption()` dispatches the event regardless, which
 * is how two browser harnesses both passed over a feature no human could reach.
 *
 * So it is an explicit affordance. That is better anyway: nobody discovers a
 * repair by re-selecting a dropdown value.
 */
function askRepairHistory(row: UserRow) {
  const unit = orgUnitOptions.value.find((u) => u.id === row.orgUnitId)
  if (!unit) return
  pendingMove.value = {
    row,
    unitId: unit.id,
    unitName: unit.display_name,
    sameUnit: true,
    viaPicker: false,
    openedAtUnitId: row.orgUnitId,
  }
}

async function cancelMove() {
  const viaPicker = pendingMove.value?.viaPicker ?? false
  const rowId = pendingMove.value?.row.id
  pendingMove.value = null

  /*
   * Only remount when the PICKER is the thing that needs resetting. Cancelling
   * a repair (opened from its own button) left the select untouched, so bumping
   * the nonce destroyed the element `useModalA11y` restores focus to and dropped
   * a keyboard user on the document body.
   */
  if (!viaPicker) {
    await nextTick()
    document.querySelector<HTMLElement>(`[data-testid="user-repair-history-${rowId}"]`)?.focus()
    return
  }
  pickerNonce.value++
  // The remount replaces the element mid-restore, so put focus back by hand.
  await nextTick()
  document.querySelector<HTMLElement>(`[data-testid="user-orgunit-${rowId}"]`)?.focus()
}

/*
 * Optimistic on the NAME only. `rehome` restates recorded usage, which this
 * page does not show, so there is nothing to optimistically restate — the
 * refresh below is what makes the rest of the page agree.
 */
async function confirmMove(payload: {
  rehome?: { from: string }
  previewedUsd?: number
  previewedRangeUsd?: number
}) {
  const move = pendingMove.value
  if (!move) return
  const { row, unitId, unitName } = move
  pendingMove.value = null

  /*
   * The dialog described the placement as it was when it OPENED. Another admin
   * can move somebody while it is open, and "their placement will not change"
   * would then be a promise this write breaks — or a move the operator never
   * saw. Refuse and make them look again, rather than applying a decision made
   * about a different state.
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
    const res = await $fetch<{
      outcome: string
      rehomed?: {
        attributionRows: number
        unaccountedRows: number
        overEmissionRows: number
        actualSpendRows: number
        reconciliationRows: number
        rollupRows: number
      }
    }>(`/api/v1/admin/users/${row.id}/org-unit`, {
      method: 'PATCH',
      // `previewedUsd` is for the receipt only — the server neither needs nor
      // accepts it, and sending it would be a field the schema rejects.
      body: { org_unit_id: unitId, ...(payload.rehome ? { rehome: payload.rehome } : {}) },
    })
    const r = res.rehomed
    if (r) {
      /*
       * COUNTS, NAMED. The operator just approved restating reported usage and
       * the only confirmation was a 3.5-second sentence containing no figures —
       * so the honest question "did that work?" had no answer short of the audit
       * log. `moveResult` persists until dismissed; the toast is the glance.
       */
      /*
       * LEDGER rows only. `spend_rollup_daily` is a derived summary of these, so
       * adding it would count the same money twice in one sentence — but it is
       * still reported, and it still counts as "something happened": a teammate
       * whose raw rows aged out can have ONLY rollups move, and calling that
       * "nothing needed moving" would be false.
       */
      const ledgerRows =
        r.attributionRows + r.unaccountedRows + r.overEmissionRows + r.actualSpendRows + r.reconciliationRows
      const total = ledgerRows + r.rollupRows
      moveResult.value = {
        email: row.email,
        unitName,
        placementChanged: res.outcome !== 'history-repaired',
        rows: r,
        total,
        ledgerRows,
        approvedUsd: payload.previewedUsd ?? null,
        rangeUsd: payload.previewedRangeUsd ?? null,
      }
      // Deliberately NO toast: the receipt above is the message, and two panels
      // saying the same sentence teach a reader to skim past both.
      toast.value = null
    } else {
      flashToast('ok', `Moved ${row.email} to ${unitName}`)
    }
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

const adminCount = computed(() => data.value?.adminCount ?? 0)

function isLastAdmin(row: UserRow): boolean {
  return row.role === 'admin' && adminCount.value <= 1
}

const columns = [
  { key: 'email', label: 'Email', cellClass: 'font-medium' },
  { key: 'displayName', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'orgUnitName', label: BU_LABEL },
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
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-users" data-admin-page="/admin/users">
    <UiPageHead
      eyebrow="Administration"
      title="Teammates"
      sub="Teammates in this region. Change role via the dropdown; the audit trail records every change."
    />

    <!--
      THE RECEIPT — one surface, where the eye already goes.

      It sits in the toast's slot rather than beside it: two panels saying almost
      the same sentence is how a reader learns to ignore both. A placement change
      is a toast (3.5s, glanceable). A correction that RESTATED REPORTED USAGE is
      this, and it stays until dismissed — somebody moved other people's money
      and will be asked, by finance, exactly what moved.
    -->
    <div
      v-if="moveResult"
      class="mb-4 rounded-lg border border-brand-harmony/30 bg-brand-harmony-sheer px-4 py-3"
      role="status"
      data-testid="move-receipt"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">
            {{ moveResult.placementChanged ? 'Moved, and usage restated' : 'History repaired' }}
          </p>
          <p class="text-sm text-carbon mt-1">
            {{ moveResult.email }} → <strong>{{ moveResult.unitName }}</strong>
            <span v-if="!moveResult.placementChanged" class="text-carbon-3">
              · they were already here, so only their recorded usage moved
            </span>
          </p>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="move-receipt-close" @click="moveResult = null">
          Dismiss
        </UiButton>
      </div>

      <p v-if="moveResult.total === 0" class="text-[12px] text-carbon-2 mt-2" data-testid="move-receipt-rows">
        Nothing needed moving — their recorded usage was already on this {{ BU_LABEL }}.
      </p>
      <div v-else class="mt-2" data-testid="move-receipt-rows">
        <p class="text-[13px] font-semibold text-carbon">
          {{ moveResult.ledgerRows.toLocaleString() }} record(s) now report to {{ moveResult.unitName }}
        </p>
        <!-- The figure they APPROVED, named as such. The response carries counts;
             the operator's question is about the money they were shown. Saying
             "moved $X" would overstate it — a few dollars of newer usage can land
             between the preview and the write. -->
        <!-- `v-if` on the number itself hid a legitimate $0.00, and formatting it
             here rather than through `formatUsd` reported "$0.00" for the same
             sub-cent figure the dialog had just called "< $0.01". -->
        <p v-if="moveResult.approvedUsd !== null" class="text-[12px] text-carbon-2">
          Covering the {{ formatUsd(moveResult.approvedUsd) }} you approved.
        </p>
        <!-- Per table, because "1,204 records" is not what finance asks about.
             They ask whether the BILL moved, which is `actual_spend`. -->
        <ul class="text-[12px] text-carbon-2 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
          <li v-if="moveResult.rows.attributionRows">
            {{ moveResult.rows.attributionRows.toLocaleString() }} tagged usage
          </li>
          <li v-if="moveResult.rows.unaccountedRows">
            {{ moveResult.rows.unaccountedRows.toLocaleString() }} untagged usage days
          </li>
          <li v-if="moveResult.rows.actualSpendRows">
            {{ moveResult.rows.actualSpendRows.toLocaleString() }} provider bill rows
          </li>
          <li v-if="moveResult.rows.reconciliationRows">
            {{ moveResult.rows.reconciliationRows.toLocaleString() }} reconciliation rows
          </li>
          <li v-if="moveResult.rows.overEmissionRows">
            {{ moveResult.rows.overEmissionRows.toLocaleString() }} over-emission rows
          </li>
          <li v-if="moveResult.rows.rollupRows">
            {{ moveResult.rows.rollupRows.toLocaleString() }} daily rollups
          </li>
        </ul>
      </div>
      <p class="text-[11px] text-carbon-3 mt-2">
        Reports can take up to a minute to catch up. The full record — including the
        range you chose — is in the audit log.
      </p>
    </div>

    <div
      v-else-if="toast"
      :data-testid="`admin-users-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

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
        <div v-if="isOrgWide">
          <select
            v-model="viewRegionId"
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
          <td class="px-5 py-3 text-sm">
            <select
              v-if="orgUnitOptions.length"
              :key="`${asUserRow(row).id}-${pickerNonce}`"
              :data-testid="`user-orgunit-${asUserRow(row).id}`"
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
          <td class="px-5 py-3 text-sm text-carbon-3">{{ fmtTs(asUserRow(row).lastSyncAt) }}</td>
          <td class="px-5 py-3 text-sm">
            <div class="flex items-center gap-2">
            <select
              v-if="isOrgWide && !regionsError"
              :data-testid="`admin-users-region-${asUserRow(row).id}`"
              :disabled="!regionsData"
              class="px-2 py-1 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
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
            <!-- Never an empty region picker over a failed read: the toolbar
                 notice above carries the reason and the retry. -->
            <span
              v-else-if="isOrgWide"
              class="text-[11px] font-semibold text-brand-hunger"
              title="The region list could not be loaded, so this teammate cannot be re-homed. Retry above the table."
            >regions unavailable</span>
            <!-- Reachable, and discoverable. See `askRepairHistory`: a select
                 cannot offer "the value you already have". -->
            <UiButton
              v-if="orgUnitOptions.some((u) => u.id === asUserRow(row).orgUnitId)"
              kind="ghost"
              size="sm"
              :data-testid="`user-repair-history-${asUserRow(row).id}`"
              :title="`Bring recorded usage that an earlier move left on another ${BU_LABEL} across to this one. Their placement does not change.`"
              @click="askRepairHistory(asUserRow(row))"
            >
              Repair history
            </UiButton>
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

    <PlaceTeammateDialog
      :open="!!pendingMove"
      :teammate-id="pendingMove?.row.id ?? ''"
      :teammate-label="pendingMove?.row.email ?? ''"
      :to-unit-id="pendingMove?.unitId ?? ''"
      :to-unit-name="pendingMove?.unitName ?? ''"
      :same-unit="pendingMove?.sameUnit ?? false"
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
