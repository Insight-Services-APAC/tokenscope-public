<script setup lang="ts">
/*
 * Region detail (feat/admin-region-lifecycle). Absorbs the old admin
 * mega-tab (app/pages/admin/region.vue) into a per-region page reached
 * from /admin/regions, and adds an EDITABLE cost-centre (org-unit) tree.
 *
 * Tabs (URL `?tab=`): Cost centres (default) / Teammates / Setup
 * checklist / Connectors.
 *
 * RBAC: admin / global-finops / platform-admin. Region scoping is
 * server-enforced; a region-bounded admin hitting another region's id
 * gets a 403 → the `regionError` state renders. Platform-admin can
 * additionally rename the region inline.
 *
 * Cost-centre edit affordances live in THIS page (a compact depth-
 * indented list) rather than OrgTree, which stays a read-only renderer.
 * Re-parent is deferred server-side, so the UI signposts it as
 * coming-soon rather than hiding it.
 */

import { computed, ref, watch } from 'vue'
import { consola } from 'consola'
import AdminTabs, { type AdminTab } from '../../../components/admin/AdminTabs.vue'
import type { OrgNode } from '../../../components/admin/OrgTree.vue'
import OrgUnitDialog from '../../../components/admin/OrgUnitDialog.vue'
import MoveOrgUnitDialog from '../../../components/admin/MoveOrgUnitDialog.vue'
import EntityTable from '../../../components/admin/EntityTable.vue'
import ConnectorCard, { type ConnectorStatus } from '../../../components/admin/ConnectorCard.vue'
import ChecklistRow from '../../../components/admin/ChecklistRow.vue'
import SetupProgressBar from '../../../components/admin/SetupProgressBar.vue'
definePageMeta({
  layout: 'admin',
  middleware: 'admin',
  // Remount on region-id change (not on ?tab= changes) so route-param-derived
  // reads — and the breadcrumb tail — never serve a stale region when Vue Router
  // reuses this component between two /admin/regions/:id navigations.
  key: (route) => String(route.params.id),
})

interface RegionResp {
  region: { id: string; code: string; display_name: string }
  counts: Record<string, number>
  connector: { label: string; status: ConnectorStatus }
  checklist: {
    items: Array<{ key: string; label: string; status: 'done' | 'in_progress' | 'todo'; sub: string }>
    progress_pct: number
    done: number
    in_progress: number
    todo: number
  }
}

const { session, ensure } = useSession()
await ensure()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})
const isPlatformAdmin = computed(() => session.value?.role === 'platform-admin')

const route = useRoute()
const router = useRouter()
const regionId = String(route.params.id)

const activeTab = computed(() => String(route.query.tab ?? 'cost-centres'))
function setTab(key: string) {
  router.push({ query: { ...route.query, tab: key } })
}

/*
 * Load ordering (perf): region metadata, the org-unit tree, the teammates
 * list and the lifecycle override all key off `regionId` (the route param) —
 * none depends on another's RESPONSE — so they're independent reads. Launch
 * each without an immediate per-call await (useFetch returns an AsyncData,
 * also a thenable) and await them together, so the page blocks on the slowest
 * read rather than the sum. Mirrors the parallel pattern on the reconciliation
 * page. (Composable rule: each useFetch stays at the top level of <script
 * setup>.)
 */
const regionAsync = useFetch<RegionResp>(
  () => `/api/v1/admin/region/${regionId}`,
  { default: () => null as unknown as RegionResp, immediate: isAdmin.value },
)
const { data: region, error: regionError, refresh: refreshRegion } = regionAsync

// Contribute the region name as the trailing breadcrumb (Admin › Regions › X).
// Cleared automatically on navigation away by the admin layout.
const { setTail } = useAdminBreadcrumbTail()
watch(
  region,
  () => {
    const name = region.value?.region?.display_name
    setTail(name ? [{ label: name }] : [])
  },
  { immediate: true },
)

const treeAsync = useFetch<{ nodes: OrgNode[] }>(
  () => `/api/v1/admin/org-units?region=${regionId}`,
  { default: () => ({ nodes: [] }), immediate: isAdmin.value },
)
const { data: tree, refresh: refreshTree } = treeAsync

const teammatesAsync = useFetch<{
  teammates: Record<string, unknown>[]
  total: number
}>(
  () => `/api/v1/admin/teammates?region=${regionId}&limit=50`,
  { default: () => ({ teammates: [], total: 0 }), immediate: isAdmin.value },
)
const { data: teammates } = teammatesAsync

// Project-lifecycle region override (D9): grace/warn for this region, or the
// inherited platform default. Region admins (and org-wide) can set/clear it.
interface LifecycleResp {
  override: { grace_hours: number; warn_days: number } | null
  platform: { grace_hours: number; warn_days: number }
  effective: { grace_hours: number; warn_days: number }
}
const lifecycleAsync = useFetch<LifecycleResp>(
  () => `/api/v1/admin/regions/${regionId}/project-lifecycle`,
  { default: () => null as unknown as LifecycleResp, immediate: isAdmin.value },
)
const { data: lifecycle, refresh: refreshLifecycle } = lifecycleAsync

// All four reads above are independent (keyed off the route param, not each
// other's response) — block on the slowest, not their sum.
await Promise.all([regionAsync, treeAsync, teammatesAsync, lifecycleAsync])
const lcGrace = ref<number | null>(null)
const lcWarn = ref<number | null>(null)
const lcSaving = ref(false)
watch(
  lifecycle,
  (v) => {
    if (v) {
      lcGrace.value = v.effective.grace_hours
      lcWarn.value = v.effective.warn_days
    }
  },
  { immediate: true },
)
async function saveLifecycleOverride() {
  if (lcGrace.value === null || lcWarn.value === null) return
  lcSaving.value = true
  try {
    await $fetch(`/api/v1/admin/regions/${regionId}/project-lifecycle`, {
      method: 'PUT',
      body: { grace_hours: lcGrace.value, warn_days: lcWarn.value },
    })
    flashToast('ok', 'Region lifecycle override saved.')
    await refreshLifecycle()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Save failed.'))
  } finally {
    lcSaving.value = false
  }
}
async function clearLifecycleOverride() {
  lcSaving.value = true
  try {
    await $fetch(`/api/v1/admin/regions/${regionId}/project-lifecycle`, { method: 'DELETE' })
    flashToast('ok', 'Reverted to platform default.')
    await refreshLifecycle()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Clear failed.'))
  } finally {
    lcSaving.value = false
  }
}

const nodes = computed<OrgNode[]>(() => tree.value?.nodes ?? [])

const tabs = computed<AdminTab[]>(() => [
  { key: 'cost-centres', label: 'Cost centres', count: nodes.value.length },
  { key: 'teammates', label: 'Teammates', count: teammates.value?.total ?? 0 },
  { key: 'checklist', label: 'Setup checklist' },
  { key: 'connectors', label: 'Connectors' },
])

const headline = computed(() => `${region.value?.region.display_name ?? '—'} region`)
const headsUpVisible = computed(() => region.value?.connector?.status === 'none')

// ── Toast (users.vue pattern) ─────────────────────────────────────────────
const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

// ── Cost-centre dialog ────────────────────────────────────────────────────
const dialog = ref<{ mode: 'create' | 'edit'; node: OrgNode | null } | null>(null)
function openCreate() { dialog.value = { mode: 'create', node: null } }
function openEdit(node: OrgNode) { dialog.value = { mode: 'edit', node } }

// ── CC-owner assignment (J4, mig 0048) ────────────────────────────────────
const ownersFor = ref<OrgNode | null>(null)
function openOwners(node: OrgNode) { ownersFor.value = node }
function onOwnersChanged() {
  refreshTree()
  refreshRegion()
}
function onSaved() {
  const wasCreate = dialog.value?.mode === 'create'
  dialog.value = null
  flashToast('ok', wasCreate ? 'Cost centre created.' : 'Cost centre updated.')
  refreshTree()
  refreshRegion()
}

// ── Cost-centre move (reparent) ───────────────────────────────────────────
const moveFor = ref<OrgNode | null>(null)
function openMove(node: OrgNode) { moveFor.value = node }
function onMoved() {
  moveFor.value = null
  flashToast('ok', 'Cost centre moved.')
  refreshTree()
  refreshRegion()
}

async function retire(node: OrgNode) {
  if (!confirm(`Retire cost centre "${node.display_name}" (${node.code})? This cannot be undone.`)) return
  try {
    await $fetch(`/api/v1/admin/org-units/${node.id}`, { method: 'DELETE' })
    flashToast('ok', `Retired ${node.display_name}.`)
    await refreshTree()
    await refreshRegion()
  } catch (err) {
    flashToast(
      'err',
      apiErrorDetail(err, 'Retire failed — the cost centre may have children, projects or teammates.'),
    )
    consola.warn('org-unit retire failed', err)
  }
}

// ── Region rename (platform-admin only) ───────────────────────────────────
const renaming = ref(false)
const renameValue = ref('')
const renameSaving = ref(false)
function openRename() {
  renameValue.value = region.value?.region.display_name ?? ''
  renaming.value = true
}
async function saveRename() {
  const name = renameValue.value.trim()
  if (!name) return
  renameSaving.value = true
  try {
    await $fetch(`/api/v1/admin/regions/${regionId}`, { method: 'PATCH', body: { display_name: name } })
    flashToast('ok', 'Region renamed.')
    renaming.value = false
    await refreshRegion()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Rename failed.'))
    consola.warn('region rename failed', err)
  } finally {
    renameSaving.value = false
  }
}

// ── Region leaders (region derivation, mig 0068) ──────────────────────────
// The manager-walk fallback target: unplaced users whose manager chain reaches
// a leader are homed in that leader's region.
const leadersOpen = ref(false)
function openLeaders() { leadersOpen.value = true }

/*
 * Checklist → action wiring. The Setup checklist used to be read-only; each
 * row now deep-links to the thing it's asking you to do — switch to the
 * relevant tab (and open the right dialog) or jump to the page that owns the
 * entity. Keyed off the server's checklist item `key`s
 * (see server/api/v1/admin/region/[regionId]/index.get.ts). Unknown keys get
 * no action (ChecklistRow falls back to its disabled placeholder), so the
 * checklist degrades gracefully if the server adds an item we don't map yet.
 */
const checklistActions: Record<string, { label: string; run: () => void }> = {
  'org-units': {
    label: 'Add cost centre',
    run: () => { setTab('cost-centres'); openCreate() },
  },
  teammates: {
    label: 'Add teammates',
    run: () => { setTab('teammates') },
  },
  projects: {
    label: 'Manage projects',
    run: () => { navigateTo('/admin/projects') },
  },
  repos: {
    label: 'Manage projects',
    run: () => { navigateTo('/admin/projects') },
  },
  'admin-roles': {
    label: 'Manage roles',
    run: () => { navigateTo('/admin/users') },
  },
  'cou-owners': {
    label: 'Assign owners',
    run: () => { setTab('cost-centres') },
  },
  'project-pms': {
    label: 'Manage projects',
    run: () => { navigateTo('/admin/projects') },
  },
}
function runChecklistAction(key: string) {
  checklistActions[key]?.run()
}

const teammateColumns = [
  { key: 'display_name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'org_unit_display_name', label: 'Org unit' },
  { key: 'source', label: 'Source' },
]
</script>

<template>
  <div v-if="!isAdmin" class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-testid="admin-access-required">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>

  <div v-else-if="!regionError && region" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="region-detail">
    <UiPageHead
      eyebrow="Region"
      :title="headline"
    >
      <template #actions>
        <span class="inline-flex items-center gap-1">
          <UiButton
            kind="ghost"
            size="sm"
            data-testid="region-leaders-open"
            title="Placement anchors (SVP / shared function) that decide which cost centre a teammate rolls up to. Not a role, not an owner."
            @click="openLeaders"
          >
            Region leaders
          </UiButton>
          <AdminHelpLink anchor="region-leader" label="a Region leader" />
        </span>
        <UiButton
          v-if="isPlatformAdmin"
          kind="ghost"
          size="sm"
          data-testid="region-rename-open"
          title="Rename this region"
          @click="openRename"
        >
          ✎ Rename
        </UiButton>
        <UiBadge :kind="region.connector.status === 'planned' ? 'harmony' : 'neutral'">
          {{ region.connector.status === 'planned' ? region.connector.label : 'No connector' }}
        </UiBadge>
      </template>
    </UiPageHead>

    <!-- Toast -->
    <div
      v-if="toast"
      :data-testid="`region-detail-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <!-- KPI row -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-5 mb-8" data-testid="admin-kpi-row">
      <UiKpi accent="harmony" label="Org units" :value="String(region.counts.org_units ?? 0)" :sub="`across ${region.counts.bus ?? 0} business ${region.counts.bus === 1 ? 'unit' : 'units'}`" />
      <UiKpi accent="vision" label="Teammates" :value="String(region.counts.teammates ?? 0)" sub="in this region" />
      <UiKpi accent="hunger" label="Projects" :value="String(region.counts.projects ?? 0)" :sub="`${region.counts.projects_onboarded ?? 0} onboarded · ${Math.max(0, (region.counts.projects ?? 0) - (region.counts.projects_onboarded ?? 0))} catalogue`" />
      <UiKpi accent="zeal" label="Connector status" :value="region.connector.status === 'planned' ? 'PSR' : 'None'" :sub="region.connector.status === 'planned' ? 'planned for pilot' : 'manual setup mode'" />
    </div>

    <AdminTabs :tabs="tabs" :model-value="activeTab" @update:model-value="setTab" />

    <!-- Cost centres -->
    <UiCard v-if="activeTab === 'cost-centres'" data-testid="panel-cost-centres">
      <div class="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <p class="text-[11px] text-carbon-3 max-w-xl leading-relaxed m-0">
          Nested by depth. Projects bill to the nearest <strong>cost-owning
          unit</strong>. Each cost-owning unit can have <strong>cost-centre
          owners</strong><AdminHelpLink anchor="cost-centre-owner" label="a cost-centre owner" /> — the people who
          can see its spend &amp; budget. <em>(Cost-centre owners are different
          from Region leaders, above.)</em>
        </p>
        <UiButton kind="primary" size="sm" data-testid="cost-centre-create-open" @click="openCreate">
          + New cost centre
        </UiButton>
      </div>

      <!-- Get-started CTA: shown when the cost-centre tree is empty so a new
           region admin sees the very first action front-and-centre. -->
      <div
        v-if="!nodes.length"
        class="mb-5 p-5 rounded-lg bg-brand-harmony-sheer border border-brand-harmony/25"
        data-testid="cost-centre-getstarted"
      >
        <div class="text-sm font-bold text-carbon">Set up your region's structure</div>
        <p class="text-sm text-carbon-2 mt-1 leading-relaxed">
          Create your first business unit, then add practices under it. Projects
          bill to the nearest cost-owning unit, so this tree is the backbone of
          attribution.
        </p>
        <div class="mt-4">
          <UiButton kind="primary" size="sm" data-testid="cost-centre-getstarted-create" @click="openCreate">
            + Create your first business unit
          </UiButton>
        </div>
      </div>

      <div v-if="nodes.length" data-testid="cost-centre-list">
        <div
          v-for="node in nodes"
          :key="node.id"
          class="grid grid-cols-[1fr_auto] items-center gap-3 py-2 border-b border-calm-2 last:border-b-0 hover:bg-brand-harmony-sheer/40 rounded-md"
          :style="{ paddingLeft: `${node.depth * 20}px` }"
          :data-depth="node.depth"
          :data-testid="`cc-row-${node.code}`"
          :data-path="node.path"
        >
          <div class="flex items-center gap-2 min-w-0 flex-wrap">
            <span class="text-sm font-bold text-carbon truncate">{{ node.display_name }}</span>
            <span class="text-[10px] text-carbon-3 font-mono">{{ node.code }}</span>
            <UiBadge v-if="node.is_cost_owning_unit" kind="zeal" :data-testid="`cc-cou-${node.code}`" title="Cost-owning unit (CoU) — a P&L node that projects bill to.">Cost-owning</UiBadge>
            <span class="text-[11px] text-carbon-3">
              {{ node.teammate_count }} {{ node.teammate_count === 1 ? 'teammate' : 'teammates' }}
              · {{ node.project_count }} {{ node.project_count === 1 ? 'project' : 'projects' }}
            </span>
            <span
              v-if="node.is_cost_owning_unit"
              class="text-[11px]"
              :class="node.owners.length ? 'text-carbon-2' : 'text-rag-amber'"
              :data-testid="`cc-owners-${node.code}`"
            >
              {{ node.owners.length
                ? `Owner: ${node.owners.map((o) => o.display_name ?? o.email).join(', ')}`
                : 'No owner' }}
            </span>
          </div>
          <div class="flex items-center gap-1 whitespace-nowrap">
            <UiButton
              v-if="node.is_cost_owning_unit"
              kind="ghost"
              size="sm"
              :data-testid="`cc-owners-open-${node.code}`"
              @click="openOwners(node)"
            >
              Owners
            </UiButton>
            <UiButton kind="ghost" size="sm" :data-testid="`cc-edit-${node.code}`" @click="openEdit(node)">Edit</UiButton>
            <UiButton
              kind="ghost"
              size="sm"
              :data-testid="`move-btn-${node.id}`"
              title="Move this cost centre (and its subtree) under a different parent in this region."
              @click="openMove(node)"
            >
              Move
            </UiButton>
            <UiButton kind="ghost" size="sm" :data-testid="`cc-retire-${node.code}`" @click="retire(node)">Retire</UiButton>
          </div>
        </div>
      </div>
      <!-- Empty state is handled by the get-started CTA above (shown when
           `!nodes.length`) — a single, action-first treatment. -->
    </UiCard>

    <!-- Teammates -->
    <EntityTable
      v-else-if="activeTab === 'teammates'"
      entity-label="Teammates"
      :rows="teammates?.teammates ?? []"
      :columns="teammateColumns"
      :total="teammates?.total"
    >
      <template #addHint>Teammates self-onboard on first sign-in — set role + region from Admin → Users.</template>
    </EntityTable>

    <!-- Setup checklist -->
    <UiCard v-else-if="activeTab === 'checklist'" data-testid="panel-checklist">
      <SetupProgressBar
        :done="region.checklist.done"
        :in-progress="region.checklist.in_progress"
        :todo="region.checklist.todo"
      />
      <div class="mt-5">
        <ChecklistRow
          v-for="(item, idx) in region.checklist.items"
          :key="item.key"
          :index="idx + 1"
          :label="item.label"
          :sub="item.sub"
          :status="item.status"
          :action-label="checklistActions[item.key]?.label"
          @action="runChecklistAction(item.key)"
        />
      </div>
      <div
        v-if="headsUpVisible"
        class="mt-5 p-3 rounded-md bg-brand-vision-lite/60 border border-brand-vision/30 text-xs text-[#1f4ea3] leading-relaxed"
        data-testid="checklist-headsup"
      >
        <span class="font-bold">Heads up.</span>
        {{ region.region.display_name }} has no FIN connector configured yet.
        Teammates, projects and repos are added manually — TokenScope tolerates
        this. You can still attribute every session.
      </div>

      <!-- Project-lifecycle override (D9) -->
      <div class="mt-6 pt-5 border-t border-calm-2" data-testid="region-lifecycle">
        <div class="text-[12px] font-semibold text-carbon uppercase tracking-wide">Project lifecycle</div>
        <p class="text-xs text-carbon-3 mt-1 mb-3 leading-relaxed">
          End-date cadence for this region. Leave at the platform default
          ({{ lifecycle?.platform.grace_hours ?? 2 }}h grace / {{ lifecycle?.platform.warn_days ?? 7 }}d warning),
          or override it for {{ region.region.display_name }}.
          <span v-if="lifecycle?.override" class="text-brand-zeal font-semibold" data-testid="region-lifecycle-overridden">
            Currently overridden.
          </span>
        </p>
        <div class="flex flex-wrap items-end gap-3">
          <label class="text-xs text-carbon-2">
            Grace (hours)
            <input
              v-model.number="lcGrace"
              type="number"
              min="0"
              max="168"
              data-testid="region-lifecycle-grace"
              class="mt-1 block w-28 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
            >
          </label>
          <label class="text-xs text-carbon-2">
            Warning (days)
            <input
              v-model.number="lcWarn"
              type="number"
              min="1"
              max="90"
              data-testid="region-lifecycle-warn"
              class="mt-1 block w-28 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
            >
          </label>
          <UiButton
            kind="primary"
            size="sm"
            :disabled="lcSaving"
            data-testid="region-lifecycle-save"
            @click="saveLifecycleOverride"
          >
            {{ lcSaving ? 'Saving…' : 'Save override' }}
          </UiButton>
          <UiButton
            v-if="lifecycle?.override"
            kind="ghost"
            size="sm"
            :disabled="lcSaving"
            data-testid="region-lifecycle-clear"
            @click="clearLifecycleOverride"
          >
            Revert to default
          </UiButton>
        </div>
      </div>
    </UiCard>

    <!-- Connectors -->
    <div v-else-if="activeTab === 'connectors'" data-testid="panel-connectors">
      <div
        v-if="headsUpVisible"
        class="mb-5 p-3 rounded-md bg-brand-vision-lite/60 border border-brand-vision/30 text-xs text-[#1f4ea3] leading-relaxed"
      >
        <span class="font-bold">{{ region.region.display_name }} has no FIN-system connector yet.</span>
        APAC will get a PSR-based connector during the pilot. US will stay manual through pilot.
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ConnectorCard
          name="PSR (APAC)"
          scope="Inbound APAC"
          description="Project + teammate sync from PSR. Coming during pilot."
          :status="region.region.code === 'apac' ? 'planned' : 'unconfigured'"
          cta="configure"
        />
        <ConnectorCard
          name="Workday (EMEA)"
          scope="Inbound EMEA"
          description="Inbound org / teammate connector — not configured."
          status="unconfigured"
          cta="configure"
        />
        <ConnectorCard
          name="NetSuite (US)"
          scope="Inbound US"
          description="Inbound project / CoU connector — not configured."
          status="unconfigured"
          cta="configure"
        />
      </div>
      <div class="mt-4">
        <ConnectorCard
          name="CSV upload"
          scope="Manual · any region"
          description="Bulk upload of teammates / projects / repos. Use anytime."
          status="available"
          cta="upload-csv"
        />
      </div>
    </div>

    <!-- Cost-centre create/edit dialog -->
    <OrgUnitDialog
      v-if="dialog"
      :mode="dialog.mode"
      :region-id="regionId"
      :node="dialog.node"
      :parents="nodes"
      @close="dialog = null"
      @saved="onSaved"
    />

    <!-- Cost-centre move (reparent) dialog -->
    <MoveOrgUnitDialog
      v-if="moveFor"
      :node="moveFor"
      :units="nodes"
      @close="moveFor = null"
      @moved="onMoved"
    />

    <!-- CC-owner assignment (J4) -->
    <AdminCouOwnersModal
      :cou="ownersFor"
      :region-id="regionId"
      @close="ownersFor = null"
      @changed="onOwnersChanged"
    />

    <!-- Region leaders — manager-walk fallback target (mig 0068) -->
    <AdminRegionLeadersModal
      :region-id="leadersOpen ? regionId : null"
      :region-name="region.region.display_name"
      :region-code="region.region.code"
      @close="leadersOpen = false"
      @changed="refreshRegion"
    />

    <!-- Rename region (platform-admin) -->
    <div
      v-if="renaming"
      class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
      data-testid="region-rename-overlay"
      @click.self="renaming = false"
    >
      <div
        class="w-full max-w-sm bg-white rounded-xl shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="region-rename-title"
        data-testid="region-rename-dialog"
      >
        <div class="px-6 py-4 border-b border-calm-2">
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Region</p>
          <h2 id="region-rename-title" class="text-lg font-bold text-carbon mt-0.5">Rename region</h2>
        </div>
        <div class="px-6 py-4">
          <label for="region-rename-input" class="text-[12px] font-semibold text-carbon">Display name</label>
          <input
            id="region-rename-input"
            v-model="renameValue"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
            data-testid="region-rename-input"
            @keyup.enter="saveRename"
            @keyup.escape="renaming = false"
          >
          <div class="flex justify-end gap-2 mt-5">
            <UiButton kind="ghost" data-testid="region-rename-cancel" @click="renaming = false">Cancel</UiButton>
            <UiButton kind="primary" :disabled="renameSaving" data-testid="region-rename-submit" @click="saveRename">
              {{ renameSaving ? 'Saving…' : 'Save' }}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-else-if="regionError" class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-testid="admin-error">
    <div class="text-lg font-bold text-carbon">Region not available.</div>
    <p class="text-sm text-carbon-2 mt-2">
      You don't have permission to view this region, or the region was removed.
    </p>
    <NuxtLink to="/admin/regions" class="inline-block mt-4 text-sm font-semibold text-brand-harmony no-underline" data-testid="admin-no-region">
      ← Back to all regions
    </NuxtLink>
  </div>

  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center text-carbon-3 text-sm">
    Loading region…
  </div>
</template>
