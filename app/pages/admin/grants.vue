<script setup lang="ts">
/*
 * Admin → Grants (design doc §Grant lifecycle, F3.3). Region-scoped view of a
 * single teammate's authorized connections (oauth_token grants) with an admin
 * revoke per row.
 *
 * `oauth_token` has no region of its own, so the surface is teammate-first: pick
 * a teammate (region-scoped search), then list THEIR grants. The server resolves
 * the teammate's region and re-checks requireRegionScope on both the read and the
 * revoke, so a region admin can never see or revoke a peer-region teammate's
 * grants (the picker only offers same-region teammates anyway).
 *
 * Revoke uses the new admin primitive — POST /api/v1/admin/grants/{id}/revoke
 * (region-scoped, sets revoked_at, cascades ts_actual_end for emit grants).
 *
 * RBAC: client-side guard via useSession() — the server still 401/403s a
 * non-admin's API calls; the page just hides itself.
 */
import { computed, ref, watch } from 'vue'
import { consola } from 'consola'

interface Teammate extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
}
interface GrantRow extends Record<string, unknown> {
  id: string
  client_name: string
  scopes: string[]
  scope_labels: string[]
  state: 'active' | 'inactive' | 'revoked' | 'expired'
  created_at: string
  last_used_at: string | null
  is_emit: boolean
}

const { session, ensure } = useSession()
await ensure()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})
const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'global-finops' || r === 'platform-admin'
})
const regionId = computed(() => session.value?.regionId ?? '')

const { data: regionsData } = await useFetch<{ regions: { id: string; code: string; display_name: string }[] }>(
  '/api/v1/admin/regions',
  { default: () => ({ regions: [] }) },
)
const viewRegionId = ref('')
watch(regionId, (r) => { if (!viewRegionId.value && r) viewRegionId.value = r }, { immediate: true })
const scopeRegion = computed(() =>
  isOrgWide.value ? (viewRegionId.value || regionId.value) : regionId.value,
)

// Teammate search (region-scoped). Pick one → load their grants.
const search = ref('')
const teammatesUrl = computed(() => {
  if (!scopeRegion.value) return ''
  const q = search.value.trim()
  return `/api/v1/admin/teammates?region=${scopeRegion.value}&limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`
})
const { data: tmData } = await useFetch<{ teammates: Teammate[] }>(
  () => teammatesUrl.value,
  { default: () => ({ teammates: [] }), immediate: !!regionId.value, watch: [teammatesUrl] },
)

const selected = ref<Teammate | null>(null)
// Clear the selection when the region view changes (the teammate may not belong).
watch(scopeRegion, () => { selected.value = null })

const grantsUrl = computed(() =>
  selected.value ? `/api/v1/admin/grants?teammate_id=${selected.value.id}` : '',
)
const { data: grantsData, refresh, pending } = await useFetch<{ teammate_id: string; grants: GrantRow[] }>(
  () => grantsUrl.value,
  { default: () => ({ teammate_id: '', grants: [] }), immediate: false, watch: [grantsUrl] },
)

function selectTeammate(t: Teammate) {
  selected.value = t
}

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

const revoking = ref<Set<string>>(new Set())
async function revokeGrant(g: GrantRow) {
  const who = selected.value?.email ?? 'this teammate'
  const msg = g.is_emit
    ? `Revoke ${who}'s emit connection (${g.client_name})? It stops their device emitting immediately.`
    : `Revoke ${who}'s connection (${g.client_name})? It logs that client out.`
  if (!confirm(msg)) return
  revoking.value = new Set([...revoking.value, g.id])
  try {
    await $fetch(`/api/v1/admin/grants/${g.id}/revoke`, { method: 'POST', body: {} })
    flashToast('ok', `Connection revoked: ${g.client_name}`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Revoke refused.'))
    consola.warn('grant revoke failed', err)
  } finally {
    const next = new Set(revoking.value)
    next.delete(g.id)
    revoking.value = next
  }
}

function grantBadge(g: GrantRow): { kind: 'hunger' | 'rag-amber' | 'rag-green'; label: string } {
  switch (g.state) {
    case 'revoked': return { kind: 'hunger', label: 'Revoked' }
    case 'expired': return { kind: 'rag-amber', label: 'Expired' }
    case 'inactive': return { kind: 'rag-amber', label: 'Inactive' }
    default: return { kind: 'rag-green', label: 'Active' }
  }
}
function fmtTs(v: string | null): string {
  return v ? new Date(v).toLocaleString() : '—'
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-grants">
    <UiPageHead
      eyebrow="Administration"
      title="Grants"
      sub="Authorized connections (OAuth/MCP grants) per teammate. Revoke a connection to log a client out — emit grants also stop the device emitting."
      :crumbs="['Admin', 'Grants']"
    />

    <div
      v-if="toast"
      :data-testid="`admin-grants-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
      <!-- Teammate picker -->
      <UiCard>
        <UiEyebrow>Teammate</UiEyebrow>
        <select
          v-if="isOrgWide"
          v-model="viewRegionId"
          class="mt-2 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white"
          data-testid="admin-grants-region-view"
          title="Browse teammates in another region"
        >
          <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
        </select>
        <input
          v-model="search"
          type="text"
          placeholder="Search by name or email"
          class="mt-2 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
          data-testid="admin-grants-search"
        >
        <ul class="mt-3 divide-y divide-calm-2 max-h-[420px] overflow-auto" data-testid="admin-grants-teammates">
          <li
            v-for="t in tmData?.teammates ?? []"
            :key="t.id"
            class="py-2"
          >
            <button
              type="button"
              class="text-left w-full hover:bg-brand-harmony-sheer/30 rounded px-1 py-0.5"
              :class="selected?.id === t.id ? 'bg-brand-harmony-sheer/50' : ''"
              :data-testid="`admin-grants-teammate-${t.id}`"
              @click="selectTeammate(t)"
            >
              <div class="text-sm text-carbon font-medium truncate">{{ t.display_name ?? t.email }}</div>
              <div class="text-[11px] text-carbon-3 truncate">{{ t.email }}</div>
            </button>
          </li>
          <li v-if="!(tmData?.teammates?.length)" class="py-3 text-xs text-carbon-3">
            No teammates match.
          </li>
        </ul>
      </UiCard>

      <!-- Grants for the selected teammate -->
      <UiCard>
        <UiEyebrow>Authorized connections</UiEyebrow>
        <p v-if="!selected" class="text-sm text-carbon-2 mt-2" data-testid="admin-grants-noselection">
          Pick a teammate on the left to see their connections.
        </p>
        <template v-else>
          <div class="text-sm text-carbon font-medium mt-1">{{ selected.display_name ?? selected.email }}</div>
          <div class="text-[11px] text-carbon-3">{{ selected.email }}</div>

          <p v-if="pending" class="text-xs text-carbon-3 mt-3">Loading…</p>
          <ul
            v-else-if="grantsData?.grants?.length"
            class="mt-3 divide-y divide-calm-2"
            data-testid="admin-grants-list"
          >
            <li
              v-for="g in grantsData.grants"
              :key="g.id"
              class="flex flex-wrap items-center gap-3 py-3"
              :data-testid="`admin-grants-row-${g.id}`"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-carbon truncate">{{ g.client_name }}</span>
                  <UiBadge :kind="grantBadge(g).kind" :data-testid="`admin-grant-state-${g.id}`">
                    {{ grantBadge(g).label }}
                  </UiBadge>
                  <UiBadge v-if="g.is_emit" kind="rag-amber" :data-testid="`admin-grant-emit-${g.id}`">Emits</UiBadge>
                </div>
                <ul class="mt-1 space-y-0.5">
                  <li v-for="(label, i) in g.scope_labels" :key="i" class="text-[11px] text-carbon-3">· {{ label }}</li>
                </ul>
                <div class="text-[11px] text-carbon-3 mt-1">
                  connected {{ fmtTs(g.created_at) }} · last used {{ fmtTs(g.last_used_at) }}
                </div>
              </div>
              <UiButton
                v-if="g.state !== 'revoked'"
                kind="ghost"
                size="sm"
                :disabled="revoking.has(g.id)"
                :data-testid="`admin-grant-revoke-${g.id}`"
                title="Revoke this connection — logs the client out (and stops emission if it's an emit grant)."
                @click="revokeGrant(g)"
              >
                <span v-if="revoking.has(g.id)">…</span>
                <span v-else>Revoke</span>
              </UiButton>
              <span v-else class="text-[11px] text-carbon-3">—</span>
            </li>
          </ul>
          <p v-else class="text-xs text-carbon-2 mt-3" data-testid="admin-grants-empty">
            No authorized connections for this teammate.
          </p>
        </template>
      </UiCard>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
