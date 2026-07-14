<script setup lang="ts">
/*
 * CouOwnersModal — assign / revoke cost-centre owners from the region
 * page's Cost centres tab (J4, mig 0048). Mirrors ProjectMembersModal:
 *   GET    …/admin/org-units?region={id}        (owners ride the tree payload)
 *   POST   …/admin/org-units/{id}/owners        { teammate_id }
 *   DELETE …/admin/org-units/{id}/owners/{teammateId}
 *
 * The owner is typically 2-3 levels removed from the unit in the org chart and
 * may not have signed in yet — so the picker searches the Entra DIRECTORY (the
 * same people-picker as region leaders), not just existing teammates. Assigning a
 * directory person who isn't a teammate find-or-provisions them server-side.
 * Ownership grants the P&L view (/cost-centres); it does not change their role.
 */
import { ref, watch } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

interface CouRef {
  id: string
  code: string
  display_name: string
  owners: Array<{ teammate_id: string; display_name: string | null; email: string }>
}
interface DirectoryHit {
  oid: string
  email: string
  display_name: string | null
  department?: string | null
  already_member?: boolean
  /** Teammate exists but bound to this person's OTHER Entra identity (#121) — assign converges on it. */
  teammate_via_other_identity?: boolean
}

const props = defineProps<{ cou: CouRef | null; regionId: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const owners = ref<CouRef['owners']>([])
const error = ref<string | null>(null)
const busyId = ref<string | null>(null)

const query = ref('')
const results = ref<DirectoryHit[]>([])
const searching = ref(false)

async function search() {
  const q = query.value.trim()
  if (!q) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const r = await $fetch<{ results: DirectoryHit[] }>(
      `/api/v1/admin/directory/search?q=${encodeURIComponent(q)}&limit=10`,
    )
    results.value = r.results ?? []
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Directory search failed')
  } finally {
    searching.value = false
  }
}

async function assign(t: DirectoryHit) {
  if (!props.cou) return
  busyId.value = t.oid
  error.value = null
  try {
    const r = await $fetch<{ teammate_id: string; email: string; display_name: string | null }>(
      `/api/v1/admin/org-units/${props.cou.id}/owners`,
      { method: 'POST', body: { oid: t.oid } },
    )
    owners.value = [...owners.value, { teammate_id: r.teammate_id, display_name: r.display_name, email: r.email }]
    query.value = ''
    results.value = []
    emit('changed')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to assign owner')
  } finally {
    busyId.value = null
  }
}

async function revoke(o: CouRef['owners'][number]) {
  if (!props.cou) return
  busyId.value = o.teammate_id
  error.value = null
  try {
    await $fetch(`/api/v1/admin/org-units/${props.cou.id}/owners/${o.teammate_id}`, {
      method: 'DELETE',
    })
    owners.value = owners.value.filter((x) => x.teammate_id !== o.teammate_id)
    emit('changed')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Failed to revoke owner')
  } finally {
    busyId.value = null
  }
}

watch(
  () => props.cou?.id,
  () => {
    owners.value = props.cou?.owners ? [...props.cou.owners] : []
    query.value = ''
    results.value = []
    error.value = null
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="cou"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="cou-owners-modal"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto">
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Cost-centre owners</p>
          <h2 class="text-lg font-bold text-carbon mt-0.5">{{ cou.display_name }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded">{{ cou.code }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="cou-owners-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <p v-if="error" class="text-xs text-rag-red mb-3" data-testid="cou-owners-error">{{ error }}</p>

        <label class="text-[12px] font-semibold text-carbon">Assign an owner</label>
        <input
          v-model="query"
          type="search"
          placeholder="Search the directory by name or email…"
          class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
          data-testid="cou-owners-search"
          @input="search"
        >
        <p class="text-[11px] text-carbon-3 mt-1">
          Owners get the P&L view of this centre's projects — their role is unchanged.
        </p>
        <ul v-if="results.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
          <li v-for="t in results" :key="t.oid" class="flex items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="text-sm text-carbon truncate">
                {{ t.display_name ?? t.email }}
                <span v-if="t.already_member" class="text-[10px] text-brand-harmony font-semibold ml-1">· teammate</span>
                <span
                  v-else-if="t.teammate_via_other_identity"
                  class="text-[10px] text-brand-harmony font-semibold ml-1"
                  title="Already a teammate via their other Entra identity — assigning resolves to the same person"
                >· teammate (other identity)</span>
              </div>
              <div class="text-[11px] text-carbon-3 truncate">{{ t.email }}<span v-if="t.department"> · {{ t.department }}</span></div>
            </div>
            <UiButton
              kind="primary"
              size="sm"
              :disabled="busyId === t.oid"
              :data-testid="`cou-owners-assign-${t.oid}`"
              @click="assign(t)"
            >
              Assign
            </UiButton>
          </li>
        </ul>
        <p v-else-if="query.trim() && !searching" class="text-[12px] text-carbon-3 mt-2">No matching people.</p>

        <div class="mt-5">
          <p class="text-[12px] font-semibold text-carbon">Current owners ({{ owners.length }})</p>
          <ul v-if="owners.length" class="mt-2 divide-y divide-calm-2" data-testid="cou-owners-list">
            <li v-for="o in owners" :key="o.teammate_id" class="flex items-center gap-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="text-sm text-carbon truncate">{{ o.display_name ?? o.email }}</div>
                <div class="text-[11px] text-carbon-3 truncate">{{ o.email }}</div>
              </div>
              <UiButton
                kind="ghost"
                size="sm"
                :disabled="busyId === o.teammate_id"
                :data-testid="`cou-owners-revoke-${o.teammate_id}`"
                @click="revoke(o)"
              >
                Revoke
              </UiButton>
            </li>
          </ul>
          <p v-else class="text-[12px] text-carbon-3 mt-2">
            No owners yet — this centre's projects have no P&L viewer.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
