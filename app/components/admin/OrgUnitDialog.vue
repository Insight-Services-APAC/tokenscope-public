<script setup lang="ts">
/*
 * OrgUnitDialog — accessible create / edit editor for a region's cost-centre
 * (org-unit) tree. Modelled on TagSessionDialog: role="dialog" + aria-modal +
 * aria-labelledby, Escape closes, the first field is focused on open, Tab cycles
 * within the dialog (focus trap), and the error is an aria-live alert.
 *
 * Create mode: parent (select; '(root)' = null), code, display_name, unit_type,
 * is_cost_owning_unit → POST /api/v1/admin/org-units.
 * Edit mode: display_name, unit_type, is_cost_owning_unit only — re-parent + code
 * changes are deferred server-side, so parent + code render read-only.
 * → PATCH /api/v1/admin/org-units/{id}.
 *
 * The inline error surfaces `err.data.data.detail` (409 dup, 422 bad parent).
 */
import { ref } from 'vue'
import UiButton from '../ui/Button.vue'
import { useModalA11y } from '../../composables/useModalA11y'
import { apiErrorDetail } from '../../composables/useApiError'
import type { OrgNode } from './OrgTree.vue'

const props = defineProps<{
  mode: 'create' | 'edit'
  regionId: string
  node?: OrgNode | null
  parents: OrgNode[]
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const parentId = ref<string>('')
const code = ref('')
const displayName = ref('')
const unitType = ref('team')
const isCou = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const firstField = ref<HTMLElement | null>(null)
const dialogEl = ref<HTMLElement | null>(null)
const titleId = 'org-unit-dialog-title'

const UNIT_TYPES = ['bu', 'practice', 'team']

function seedForm() {
  if (props.mode === 'edit' && props.node) {
    parentId.value = props.node.parent_id ?? ''
    code.value = props.node.code
    displayName.value = props.node.display_name
    unitType.value = props.node.unit_type
    isCou.value = props.node.is_cost_owning_unit
  } else {
    parentId.value = ''
    code.value = ''
    displayName.value = ''
    unitType.value = 'team'
    isCou.value = false
  }
  error.value = null
}

// This component renders only when opened (parent v-if), so it is mounted in
// the "open" state and unmounted to close. isOpen is therefore constantly true
// while mounted; the parent's modal overlay prevents switching mode/node on a
// live instance, so seeding once on mount (via onOpen) matches prior behaviour.
useModalA11y({
  isOpen: () => true,
  dialogEl,
  firstField,
  onClose: () => emit('close'),
  onOpen: seedForm,
})

// The parent display name for the read-only line in edit mode.
function parentLabel(): string {
  if (!props.node?.parent_id) return '(root)'
  const p = props.parents.find((n) => n.id === props.node?.parent_id)
  return p ? `${p.display_name} (${p.code})` : props.node.parent_id
}

async function save() {
  saving.value = true
  error.value = null
  try {
    if (props.mode === 'create') {
      await $fetch('/api/v1/admin/org-units', {
        method: 'POST',
        body: {
          region_id: props.regionId,
          parent_id: parentId.value || null,
          code: code.value.trim(),
          display_name: displayName.value.trim(),
          unit_type: unitType.value.trim(),
          is_cost_owning_unit: isCou.value,
        },
      })
    } else if (props.node) {
      await $fetch(`/api/v1/admin/org-units/${props.node.id}`, {
        method: 'PATCH',
        body: {
          display_name: displayName.value.trim(),
          unit_type: unitType.value.trim(),
          is_cost_owning_unit: isCou.value,
        },
      })
    }
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
    class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
    data-testid="org-unit-dialog-overlay"
    @click.self="emit('close')"
  >
    <div
      ref="dialogEl"
      class="w-full max-w-md bg-white rounded-xl shadow-xl"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      data-testid="org-unit-dialog"
    >
      <div class="px-6 py-4 border-b border-calm-2 flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">
            {{ mode === 'create' ? 'New cost centre' : 'Edit cost centre' }}
          </p>
          <h2 :id="titleId" class="text-lg font-bold text-carbon mt-0.5">
            {{ mode === 'create' ? 'Add a cost centre' : displayName }}
          </h2>
        </div>
        <UiButton kind="ghost" size="sm" data-testid="oud-close" @click="emit('close')">Close</UiButton>
      </div>

      <div class="px-6 py-4">
        <!-- Parent -->
        <template v-if="mode === 'create'">
          <label for="oud-parent" class="text-[12px] font-semibold text-carbon">Parent</label>
          <select
            id="oud-parent"
            ref="firstField"
            v-model="parentId"
            class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
            data-testid="oud-parent"
          >
            <option value="">(root)</option>
            <option v-for="p in parents" :key="p.id" :value="p.id">
              {{ '— '.repeat(p.depth) }}{{ p.display_name }} ({{ p.code }})
            </option>
          </select>
        </template>
        <template v-else>
          <div class="text-[12px] font-semibold text-carbon">Parent</div>
          <div class="mt-1 mb-3 px-3 py-2 text-sm text-carbon-2 bg-calm/40 rounded-md" data-testid="oud-parent-readonly">
            {{ parentLabel() }}
            <span class="block text-[11px] text-carbon-3 mt-0.5">To re-parent this unit, use the Move action on its row.</span>
          </div>
        </template>

        <!-- Code -->
        <label for="oud-code" class="text-[12px] font-semibold text-carbon">Code</label>
        <input
          v-if="mode === 'create'"
          id="oud-code"
          v-model="code"
          placeholder="e.g. apac-eng-platform"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white font-mono focus:border-brand-harmony focus:outline-none"
          data-testid="oud-code"
        >
        <div
          v-else
          class="mt-1 mb-3 px-3 py-2 text-sm font-mono text-carbon-2 bg-calm/40 rounded-md"
          data-testid="oud-code-readonly"
        >
          {{ code }}
        </div>

        <!-- Display name -->
        <label for="oud-name" class="text-[12px] font-semibold text-carbon">Display name</label>
        <input
          id="oud-name"
          :ref="(el) => { if (mode === 'edit') firstField = el as HTMLElement | null }"
          v-model="displayName"
          placeholder="e.g. Platform Engineering"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
          data-testid="oud-name"
        >

        <!-- Unit type -->
        <label for="oud-type" class="text-[12px] font-semibold text-carbon">Unit type</label>
        <select
          id="oud-type"
          v-model="unitType"
          class="mt-1 mb-3 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
          data-testid="oud-type"
        >
          <option v-for="t in UNIT_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>

        <!-- Cost-owning unit -->
        <label class="flex items-center gap-2 text-[12px] font-semibold text-carbon mb-1 cursor-pointer">
          <input
            v-model="isCou"
            type="checkbox"
            class="w-4 h-4 accent-brand-harmony"
            data-testid="oud-cou"
          >
          Cost-owning unit
        </label>
        <p class="text-[11px] text-carbon-3 mb-2">Projects bill to the nearest cost-owning ancestor.</p>

        <p v-if="error" class="text-xs text-rag-red mt-3" data-testid="oud-error" role="alert">{{ error }}</p>

        <div class="flex justify-end gap-2 mt-5">
          <UiButton kind="ghost" data-testid="oud-cancel" @click="emit('close')">Cancel</UiButton>
          <UiButton kind="primary" :disabled="saving" data-testid="oud-submit" @click="save">
            {{ saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
