<script setup lang="ts">
/*
 * Admin → Instances (ADR-0005 decision 3 — "admin: region-wide" spot +
 * block). Region-scoped table of enrolled devices with per-device spend,
 * anomaly flags (revoked / silent), and an admin revoke per row.
 *
 * Revoke uses the EXISTING admin primitive — DELETE /api/v1/instances/{id}
 * (admin + region-scoped, sets ts_actual_end). We do NOT add a new admin
 * revoke endpoint.
 *
 * Region scope: region-scoped admins stay in their home region; org-wide
 * role (platform-admin) gets a region-view picker, mirroring
 * admin/users.vue. The server re-checks requireRegionScope on both the read
 * and the revoke, so the picker is a convenience, not the gate.
 *
 * Search, filters and paging run ON THE SERVER (#582): the page used to take
 * the server default of 100 devices with no way to reach the rest of a region
 * of ~1,500 developers. Search is by teammate name or email; filters are
 * status (the five device states, the same rule as the row's badge) and
 * tool. limit=50 offset=N, and any filter change restarts at page 1, the
 * Admin → Teammates pattern.
 *
 * RBAC: client-side guard via useSession() — server middleware still
 * 401/403s a non-admin's API calls; the page just hides itself.
 */

import AdminResultToast from '../../components/admin/AdminResultToast.vue'
import { useResultToast } from '../../composables/useResultToast'
import { computed, ref, watch } from 'vue'
import { consola } from 'consola'
import AdminDataTable from '../../components/admin/AdminDataTable.vue'
// The product name (Claude Code, GitHub Copilot CLI), never the raw tool code (#582, PO).
import { deviceToolName } from '#shared/schemas/device-name'
import { INSTANCE_STATES, INSTANCE_STATE_BADGE, INSTANCE_STATE_LABEL, type InstanceState } from '#shared/schemas/device-name'
import { ADMIN_LIST_SEARCH_MAX } from '#shared/schemas/admin-list-search'
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface InstanceRow extends Record<string, unknown> {
  instance_id: string
  tool: string
  /** The owner's name for the device (#576): shown read-only; only the owner sets it. */
  display_name: string | null
  project: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
  revoked: boolean
  state: InstanceState
  teammate_id: string
  teammate_email: string
  teammate_display_name: string | null
}

const { session } = useSession()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})
const regionId = computed(() => session.value?.regionId ?? '')

// Both reads are declared lazily and never awaited: navigation is never gated
// on data (docs/design/admin-nav-responsiveness.md D1/D2).
// The region picker's read keeps its `error`: a failed read collapsed into `[]`
// renders as "no other regions" — the false empty D2 forbids.
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

const scopeRegion = computed(() =>
  isOrgWide.value ? (viewRegionId.value || regionId.value) : regionId.value,
)
const query = ref('')
const statusFilter = ref<'' | InstanceState>('')
const toolFilter = ref('')
const offset = ref(0)
const LIMIT = 50
watch([query, statusFilter, toolFilter, scopeRegion], () => {
  offset.value = 0
})
// A tool is a per-region fact; a tool picked in one region may not exist in the next.
watch(scopeRegion, () => {
  toolFilter.value = ''
})
const filtering = computed(() => query.value.trim() !== '' || statusFilter.value !== '' || toolFilter.value !== '')

const instancesUrl = computed(() => {
  if (!scopeRegion.value) return ''
  const parts = [`region=${scopeRegion.value}`, `limit=${LIMIT}`, `offset=${offset.value}`]
  const q = query.value.trim()
  if (q) parts.push(`q=${encodeURIComponent(q)}`)
  if (statusFilter.value) parts.push(`status=${statusFilter.value}`)
  if (toolFilter.value) parts.push(`tool=${encodeURIComponent(toolFilter.value)}`)
  return `/api/v1/admin/instances?${parts.join('&')}`
})

function nextPage() {
  if (offset.value + LIMIT < (data.value?.total ?? 0)) offset.value += LIMIT
}
function prevPage() {
  offset.value = Math.max(0, offset.value - LIMIT)
}

// Explicit key because the getter can be '' (D1); the watch carries the refetch.
const { data, error, refresh } = useLazyFetch<{
  instances: InstanceRow[]
  region: string
  total: number
  tools: string[]
  offset: number
} | null>(
  () => instancesUrl.value,
  {
    key: 'admin-instances-list',
    server: false,
    default: () => null,
    immediate: !!regionId.value,
    watch: [instancesUrl],
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

const { toast, flashToast, dismissToast } = useResultToast()

const revoking = ref<Set<string>>(new Set())
async function revokeInstance(row: InstanceRow) {
  if (!confirm(`Revoke ${row.teammate_email}'s device? It stops emitting immediately.`)) return
  revoking.value = new Set([...revoking.value, row.instance_id])
  try {
    await $fetch(`/api/v1/instances/${row.instance_id}`, { method: 'DELETE' })
    flashToast('ok', `Device revoked: ${row.teammate_email}`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Revoke refused.'))
    consola.warn('instance revoke failed', err)
  } finally {
    const next = new Set(revoking.value)
    next.delete(row.instance_id)
    revoking.value = next
  }
}

const columns = [
  { key: 'teammate', label: 'Teammate' },
  { key: 'instance', label: 'Device' },
  { key: 'tool', label: 'Tool' },
  { key: 'spend', label: 'Spend (MTD)' },
  { key: 'last', label: 'Last emission' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Actions' },
]

function asRow(row: Record<string, unknown>): InstanceRow {
  return row as unknown as InstanceRow
}
function fmtTs(v: string | null): string {
  return v ? new Date(v).toLocaleString() : '—'
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-instances" data-admin-page="/admin/instances">
    <UiPageHead
      eyebrow="Administration"
      title="Devices"
      sub="Enrolled devices in this region. Spot a device that's wrong or cannot send, and revoke it."
    />

    <AdminResultToast :toast="toast" testid="admin-instances-toast" @dismiss="dismissToast" />

    <UiFetchErrorBanner v-if="error" :error="error" label="devices" @retry="refresh" />
    <AdminDataTable
      v-else
      :rows="data?.instances ?? []"
      :columns="columns"
      :loading="skeleton"
      :empty-headline="filtering ? 'No matching devices' : 'No devices'"
      :empty-sub="filtering ? 'No devices in this region match the search and filters.' : 'No enrolled devices in this region yet.'"
    >
      <template #toolbar>
        <form class="flex items-center gap-2 flex-1 min-w-[200px]" role="search" @submit.prevent="refresh()">
          <input
            v-model="query"
            type="search"
            :maxlength="ADMIN_LIST_SEARCH_MAX"
            placeholder="Search by teammate name or email…"
            aria-label="Search devices by teammate name or email"
            class="flex-1 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony"
            data-testid="admin-instances-search"
          >
        </form>
        <select
          v-model="statusFilter"
          aria-label="Show devices by status"
          class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-instances-status-filter"
        >
          <option value="">All statuses</option>
          <option v-for="st in INSTANCE_STATES" :key="st" :value="st">{{ INSTANCE_STATE_LABEL[st] }}</option>
        </select>
        <select
          v-model="toolFilter"
          aria-label="Show devices for this tool"
          class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-instances-tool-filter"
        >
          <option value="">All tools</option>
          <option v-for="t in data?.tools ?? []" :key="t" :value="t">{{ deviceToolName(t) }}</option>
        </select>
        <div v-if="isOrgWide">
          <select
            v-model="viewRegionId"
            :disabled="!regionsData"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white disabled:bg-calm/40 disabled:cursor-not-allowed"
            data-testid="admin-instances-region-view"
            :title="regionsError ? 'The region list could not be loaded.' : 'Browse devices in another region'"
          >
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
          <UiAuxFetchError
            :error="regionsError"
            label="regions"
            testid="admin-instances-regions-error"
            @retry="refreshRegions"
          />
        </div>
      </template>
      <template #row="{ row }">
        <tr
          :data-testid="`admin-instances-row-${asRow(row).instance_id}`"
          class="hover:bg-brand-harmony-sheer/30"
        >
          <td class="px-5 py-3 text-sm">
            <div class="text-carbon font-medium">{{ asRow(row).teammate_display_name ?? asRow(row).teammate_email }}</div>
            <div class="text-[11px] text-carbon-3">{{ asRow(row).teammate_email }}</div>
          </td>
          <td class="px-5 py-3 text-sm">
            <code class="text-[11px] bg-calm/40 px-1 rounded text-carbon">{{ asRow(row).instance_id.slice(0, 8) }}</code>
            <span v-if="asRow(row).project" class="text-[11px] text-carbon-3 ml-1">· {{ asRow(row).project }}</span>
            <div
              v-if="asRow(row).display_name"
              class="text-[11px] text-carbon-2 mt-0.5"
              title="Named by its owner on My account"
              :data-testid="`admin-instances-name-${asRow(row).instance_id}`"
            >{{ asRow(row).display_name }}</div>
          </td>
          <td class="px-5 py-3 text-sm text-carbon-2">{{ deviceToolName(asRow(row).tool) }}</td>
          <td class="px-5 py-3 text-sm text-carbon font-mono">${{ asRow(row).spend_usd_mtd }}</td>
          <td class="px-5 py-3 text-sm text-carbon-3">{{ fmtTs(asRow(row).last_emission) }}</td>
          <td class="px-5 py-3 text-sm">
            <UiBadge :kind="INSTANCE_STATE_BADGE[asRow(row).state]">{{ INSTANCE_STATE_LABEL[asRow(row).state] }}</UiBadge>
          </td>
          <td class="px-5 py-3 text-sm">
            <UiButton
              v-if="!asRow(row).revoked"
              kind="ghost"
              size="sm"
              :disabled="revoking.has(asRow(row).instance_id)"
              :data-testid="`admin-instance-revoke-${asRow(row).instance_id}`"
              title="Force-revoke this device — stops emission immediately."
              @click="revokeInstance(asRow(row))"
            >
              <span v-if="revoking.has(asRow(row).instance_id)">…</span>
              <span v-else>Revoke</span>
            </UiButton>
            <span v-else class="text-[11px] text-carbon-3">—</span>
          </td>
        </tr>
      </template>
    </AdminDataTable>

    <div
      v-if="!error && data && (data.total > 0 || offset > 0)"
      class="mt-4 flex items-center justify-end gap-3"
      data-testid="admin-instances-pager"
    >
      <span class="text-xs text-carbon-3" data-testid="admin-instances-window">
        <template v-if="data.instances.length">{{ data.offset + 1 }} to {{ data.offset + data.instances.length }} of {{ data.total }} devices</template>
      </span>
      <template v-if="data.total > LIMIT || offset > 0">
        <UiButton kind="ghost" size="sm" :disabled="offset === 0" data-testid="admin-instances-prev" @click="prevPage">← Previous</UiButton>
        <UiButton kind="ghost" size="sm" :disabled="offset + LIMIT >= data.total" data-testid="admin-instances-next" @click="nextPage">Next →</UiButton>
      </template>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/instances">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
