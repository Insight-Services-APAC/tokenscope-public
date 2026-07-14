<script setup lang="ts">
/*
 * ProjectEditDialog — edit a project's budget-owning metadata from the
 * top-level Admin → Projects page. Modelled on TagSessionDialog for the a11y
 * contract (role="dialog" + aria-modal + aria-labelledby, Escape closes, first
 * field focused on open, focus trap, error as aria-live alert).
 *
 * Submits only the changed fields to PATCH /api/v1/admin/projects/{id}; the
 * parent owns the success toast + list refresh via the `saved` emit.
 */
import { ref, computed, type Ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'

export interface ProjectEditTarget {
  id: string
  code: string
  display_name: string
  client_facing_name?: string | null
  wbs_code?: string | null
  type: 'billable' | 'pursuit' | 'internal' | string
  cost_owning_unit_id: string | null
  is_authorised: boolean
}

const props = defineProps<{
  project: ProjectEditTarget | null
  couOptions: { id: string; display_name: string }[]
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const displayName = ref('')
const clientFacingName = ref('')
const wbsCode = ref('')
const type = ref<'billable' | 'pursuit' | 'internal'>('billable')
const couId = ref('')
const isAuthorised = ref(false)

const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLInputElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'project-edit-title'

const normalisedType = (t: string): 'billable' | 'pursuit' | 'internal' =>
  t === 'pursuit' || t === 'internal' ? t : 'billable'

// Shared dialog a11y; onOpen prefills the form from the project being edited.
useModalA11y({
  isOpen: () => !!props.project,
  dialogEl,
  firstField: firstField as Ref<HTMLElement | null>,
  onClose: () => emit('close'),
  onOpen: () => {
    const p = props.project
    if (!p) return
    displayName.value = p.display_name ?? ''
    clientFacingName.value = p.client_facing_name ?? ''
    wbsCode.value = p.wbs_code ?? ''
    type.value = normalisedType(p.type)
    couId.value = p.cost_owning_unit_id ?? ''
    isAuthorised.value = !!p.is_authorised
    error.value = null
  },
})

const canSubmit = computed(() => !saving.value && displayName.value.trim().length > 0)

async function save() {
  const p = props.project
  if (!p) return
  // Build a patch of only the changed fields.
  const body: Record<string, unknown> = {}
  const nextName = displayName.value.trim()
  if (nextName !== (p.display_name ?? '')) body.display_name = nextName
  const nextClient = clientFacingName.value.trim()
  if (nextClient !== (p.client_facing_name ?? '')) body.client_facing_name = nextClient
  const nextWbs = wbsCode.value.trim()
  if (nextWbs !== (p.wbs_code ?? '')) body.wbs_code = nextWbs // '' clears it server-side
  if (type.value !== normalisedType(p.type)) body.type = type.value
  if (couId.value && couId.value !== (p.cost_owning_unit_id ?? '')) body.cost_owning_unit_id = couId.value
  if (isAuthorised.value !== !!p.is_authorised) body.is_authorised = isAuthorised.value

  if (Object.keys(body).length === 0) {
    emit('close')
    return
  }

  saving.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/admin/projects/${p.id}`, { method: 'PATCH', body })
    emit('saved')
  } catch (e: unknown) {
    error.value = apiErrorDetail(e, 'Save failed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="project"
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="project-edit-dialog"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-md bg-white rounded-xl shadow-xl max-h-[85vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Edit project</p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">{{ project.display_name }}</h2>
          <code class="text-[11px] bg-calm/40 px-1 rounded">{{ project.code }}</code>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="project-edit-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <label for="pe-name" class="text-[12px] font-semibold text-carbon">Display name</label>
        <input
          id="pe-name"
          ref="firstField"
          v-model="displayName"
          type="text"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
          data-testid="pe-name"
        >

        <label for="pe-client-name" class="text-[12px] font-semibold text-carbon">Client-facing name</label>
        <input
          id="pe-client-name"
          v-model="clientFacingName"
          type="text"
          placeholder="Optional — shown to the client"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
          data-testid="pe-client-name"
        >

        <label for="pe-wbs" class="text-[12px] font-semibold text-carbon">WBS code</label>
        <input
          id="pe-wbs"
          v-model="wbsCode"
          type="text"
          maxlength="64"
          placeholder="Optional — finance-system WBS code"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony focus:outline-none"
          data-testid="pe-wbs"
        >

        <label for="pe-type" class="text-[12px] font-semibold text-carbon">Type</label>
        <select
          id="pe-type"
          v-model="type"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
          data-testid="pe-type"
        >
          <option value="billable">Billable</option>
          <option value="pursuit">Pursuit</option>
          <option value="internal">Internal</option>
        </select>

        <label for="pe-cou" class="text-[12px] font-semibold text-carbon">Cost-owning unit</label>
        <select
          id="pe-cou"
          v-model="couId"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
          data-testid="pe-cou"
        >
          <option value="" disabled>Select a unit…</option>
          <option v-for="u in couOptions" :key="u.id" :value="u.id">{{ u.display_name }}</option>
        </select>

        <label class="flex items-center gap-2 text-[12px] font-semibold text-carbon mt-1">
          <input
            v-model="isAuthorised"
            type="checkbox"
            class="rounded border-calm-2"
            data-testid="pe-authorised"
          >
          Authorised for spend
        </label>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="project-edit-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="project-edit-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="!canSubmit" data-testid="pe-submit" @click="save">
            {{ saving ? 'Saving…' : 'Save changes' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
