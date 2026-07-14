<script setup lang="ts">
/*
 * Admin → Department map. Curate the department → region map (mig 0068),
 * the PRIMARY region-derivation signal: an unplaced user's Entra `department`
 * is looked up (case-insensitively) to home them in their real region.
 *
 * Org-wide curated config (not region-scoped) — adding a mapping is a
 * deliberate placement policy, so this page is intentionally not bounded to
 * the admin's own region. Add (department text + region select), and remove
 * (hard delete — it's config, not history).
 *
 * Money-policy note (design doc fix #6): mapping a department to the
 * Global/Shared region is allowed but is a deliberate "this whole department
 * is a shared function regardless of reporting line" assertion. The UI warns
 * before such a mapping; mis-derivation lands in that region's unattributed
 * holding bucket and is admin-correctable.
 *
 * RBAC: client-side guard via useSession() — the server still 401/403s a
 * non-admin's API calls (requireRole admin / global-finops); the page just
 * hides itself.
 */
import { computed, ref } from 'vue'
import { consola } from 'consola'

interface MappingRow {
  department: string
  department_lower: string
  region_id: string
  region_code: string
  region_display_name: string
}

const { session, ensure } = useSession()
await ensure()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})

const { data: regionsData } = await useFetch<{ regions: { id: string; code: string; display_name: string }[] }>(
  '/api/v1/admin/regions',
  { default: () => ({ regions: [] }), immediate: isAdmin.value },
)

const { data, refresh, pending } = await useFetch<{ mappings: MappingRow[] }>(
  '/api/v1/admin/department-map',
  { default: () => ({ mappings: [] }), immediate: isAdmin.value },
)
const mappings = computed(() => data.value?.mappings ?? [])

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

// ── add / upsert a mapping ────────────────────────────────────────────────
const newDept = ref('')
const newRegionId = ref('')
const adding = ref(false)

const selectedIsGlobalShared = computed(
  () => regionsData.value?.regions.find((r) => r.id === newRegionId.value)?.code === 'global-shared',
)

async function addMapping() {
  const department = newDept.value.trim()
  if (!department || !newRegionId.value) return
  // Money-policy guard (fix #6): mapping to Global/Shared is a deliberate
  // "whole department is a shared function" assertion, not a geo placement.
  if (
    selectedIsGlobalShared.value &&
    !confirm(
      `Map "${department}" to the Global / Shared region?\n\n` +
        'This asserts the whole department is a shared function regardless of ' +
        "reporting line. Don't use it for a geo-correlated department — those " +
        'should map to a real region. Continue?',
    )
  ) {
    return
  }
  adding.value = true
  try {
    await $fetch('/api/v1/admin/department-map', {
      method: 'POST',
      body: { department, region_id: newRegionId.value },
    })
    flashToast('ok', `Mapped '${department}'.`)
    newDept.value = ''
    newRegionId.value = ''
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Add refused.'))
    consola.warn('department-map add failed', err)
  } finally {
    adding.value = false
  }
}

// ── remove a mapping (hard delete — config, not history) ──────────────────
const removingKey = ref<string | null>(null)
async function removeMapping(row: MappingRow) {
  if (!confirm(`Remove the mapping for "${row.department}"? Unplaced users in this department fall back to the manager walk.`)) {
    return
  }
  removingKey.value = row.department_lower
  try {
    await $fetch(`/api/v1/admin/department-map/${encodeURIComponent(row.department_lower)}`, {
      method: 'DELETE',
    })
    flashToast('ok', `Removed '${row.department}'.`)
    await refresh()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Remove refused.'))
    consola.warn('department-map remove failed', err)
  } finally {
    removingKey.value = null
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-department-map">
    <UiPageHead
      eyebrow="Administration"
      title="Department map"
      sub="Map an Entra department to a region. Unplaced users are homed in their real region by department first; the manager walk is the fallback."
      :crumbs="['Admin', 'Department map']"
    />

    <div
      v-if="toast"
      :data-testid="`admin-department-map-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <!-- Add / upsert -->
    <UiCard class="mb-5">
      <form class="flex flex-wrap items-end gap-3" data-testid="department-map-add-form" @submit.prevent="addMapping">
        <div>
          <label class="block text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1.5">Department</label>
          <input
            v-model="newDept"
            type="text"
            maxlength="200"
            placeholder="e.g. Data &amp; AI Practice"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none min-w-[280px]"
            data-testid="department-map-new-dept"
          >
        </div>
        <div>
          <label class="block text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1.5">Region</label>
          <select
            v-model="newRegionId"
            class="px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
            data-testid="department-map-new-region"
          >
            <option value="" disabled>Select a region…</option>
            <option v-for="r in regionsData?.regions" :key="r.id" :value="r.id">{{ r.display_name }}</option>
          </select>
        </div>
        <UiButton
          kind="primary"
          size="sm"
          type="submit"
          :disabled="adding || !newDept.trim() || !newRegionId"
          data-testid="department-map-add"
        >
          {{ adding ? 'Saving…' : '+ Map department' }}
        </UiButton>
        <span class="text-[11px] text-carbon-3">
          Matching is case-insensitive. Re-mapping an existing department updates its region.
        </span>
      </form>
      <p
        v-if="selectedIsGlobalShared"
        class="mt-3 text-[12px] text-rag-amber"
        data-testid="department-map-global-shared-warn"
      >
        Global / Shared declares the whole department a shared function regardless of reporting line — don't use it for a geo-correlated department.
      </p>
    </UiCard>

    <UiCard data-testid="department-map-table">
      <div v-if="pending" class="text-sm text-carbon-3 py-6 text-center">Loading…</div>
      <table v-else-if="mappings.length" class="w-full text-sm">
        <thead>
          <tr class="text-left text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 border-b border-calm-2">
            <th class="px-3 py-2">Department</th>
            <th class="px-3 py-2">Region</th>
            <th class="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in mappings"
            :key="row.department_lower"
            class="border-b border-calm-2 last:border-b-0 hover:bg-brand-harmony-sheer/30"
            :data-testid="`department-map-row-${row.department_lower}`"
          >
            <td class="px-3 py-2 text-carbon font-medium">{{ row.department }}</td>
            <td class="px-3 py-2">
              <UiBadge :kind="row.region_code === 'global-shared' ? 'neutral' : 'harmony'">
                {{ row.region_display_name }}
              </UiBadge>
            </td>
            <td class="px-3 py-2 text-right whitespace-nowrap">
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="removingKey === row.department_lower"
                :data-testid="`department-map-remove-${row.department_lower}`"
                @click="removeMapping(row)"
              >
                {{ removingKey === row.department_lower ? '…' : 'Remove' }}
              </UiButton>
            </td>
          </tr>
        </tbody>
      </table>
      <UiEmptyState
        v-else
        headline="No department mappings yet"
        sub="Add a department → region row above. Until then, unplaced users rely on the manager walk and the Global / Unassigned fallback."
      />
    </UiCard>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
