<script setup lang="ts">
/*
 * ReportVisibilitySection — the org-wide report-visibility policy on
 * Admin → Settings, backed by GET/PUT /api/v1/admin/report-visibility
 * (mig 0087, shared/auth/report-visibility.ts).
 *
 * ONE easy-to-understand knob on top of the full RBAC: three named presets
 * deciding which /reports scopes each persona sees. 'standard' = today's
 * behaviour exactly; the other two progressively let region admins (and then
 * cost-centre owners) see the org-wide reports.
 *
 * Each preset card renders the WHO-SEES-WHAT matrix straight from the GET
 * payload, which the endpoint sources from the SAME shared object enforcement
 * uses — so the preview cannot drift from the gate.
 *
 * Org-wide config: only platform-admin / global-finops may change it (mirrors
 * the governance platform baseline + directory exclusions). A region admin sees
 * the policy read-only. Extracted so the render logic is unit-testable with the
 * plain @vue/test-utils harness: data arrives via props; only the PUT uses the
 * global $fetch.
 */
import { ref, computed, watch } from 'vue'
import UiCard from '../ui/Card.vue'
import UiEyebrow from '../ui/Eyebrow.vue'
import UiBadge from '../ui/Badge.vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

export interface ReportVisibilityMatrixRow {
  persona: string
  scopes: string[]
}
export interface ReportVisibilityModePreset {
  mode: string
  label: string
  description: string
  matrix: ReportVisibilityMatrixRow[]
}
export interface ReportVisibilityData {
  mode: string
  updated_by: string | null
  updated_by_name: string | null
  updated_at: string | null
  modes: ReportVisibilityModePreset[]
}

const props = defineProps<{
  data: ReportVisibilityData | null
  /** platform-admin / global-finops — only they may change it (org-wide config). */
  orgWide: boolean
}>()

const emit = defineEmits<{ saved: [] }>()

// Draft selection — seeded to the current mode, re-seeded when the data
// refreshes (e.g. after a save).
const draft = ref<string | null>(null)
watch(
  () => props.data?.mode,
  (mode) => {
    draft.value = mode ?? null
  },
  { immediate: true },
)

const modes = computed<ReportVisibilityModePreset[]>(() => props.data?.modes ?? [])
const currentMode = computed<string | null>(() => props.data?.mode ?? null)
const dirty = computed(() => draft.value !== null && draft.value !== currentMode.value)

const setBy = computed(() => {
  const d = props.data
  if (!d || !d.updated_at) return null
  const when = d.updated_at.slice(0, 10) // YYYY-MM-DD is enough for a footer
  return `Set by ${d.updated_by_name ?? 'unknown'} · ${when}`
})

const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 3500)
}

const saving = ref(false)

async function save() {
  if (!props.orgWide || draft.value === null || !dirty.value) return
  saving.value = true
  try {
    await $fetch('/api/v1/admin/report-visibility', {
      method: 'PUT',
      body: { mode: draft.value },
    })
    const label = modes.value.find((m) => m.mode === draft.value)?.label ?? draft.value
    flashToast('ok', `Report visibility set to "${label}".`)
    emit('saved')
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Save refused.'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiCard accent="vision" data-testid="settings-report-visibility">
    <UiEyebrow>Reporting</UiEyebrow>
    <h2 class="text-lg font-bold text-carbon mt-1 mb-1">Report visibility</h2>
    <p class="text-xs text-carbon-3 mb-4 leading-relaxed">
      One org-wide knob on top of the full RBAC: which reporting scopes each persona can see.
      <span class="font-semibold">Standard</span> is today's behaviour exactly; the looser presets
      progressively let region admins — then cost-centre owners — see the org-wide reports. Only
      the READ side of <span class="font-mono">/reports</span> is affected; nothing else changes.
    </p>

    <div
      v-if="toast"
      :data-testid="`settings-report-visibility-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <p v-if="!data" class="text-sm text-carbon-3 italic">Loading report-visibility policy…</p>
    <div v-else class="flex flex-col gap-3">
      <label
        v-for="preset in modes"
        :key="preset.mode"
        class="block rounded-md border p-4 cursor-pointer transition-colors"
        :class="[
          draft === preset.mode
            ? 'border-brand-vision bg-brand-vision/5'
            : 'border-calm-2 hover:border-calm-3',
          orgWide ? '' : 'cursor-default',
        ]"
        :data-testid="`report-visibility-card-${preset.mode}`"
      >
        <div class="flex items-start gap-3">
          <input
            type="radio"
            name="report-visibility-mode"
            class="mt-1"
            :value="preset.mode"
            :checked="draft === preset.mode"
            :disabled="!orgWide"
            :data-testid="`report-visibility-radio-${preset.mode}`"
            @change="draft = preset.mode"
          >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold text-carbon">{{ preset.label }}</span>
              <UiBadge
                v-if="preset.mode === currentMode"
                kind="rag-green"
                :data-testid="`report-visibility-current-${preset.mode}`"
              >current</UiBadge>
            </div>
            <div class="text-xs text-carbon-3 leading-relaxed mt-0.5">{{ preset.description }}</div>
            <dl class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
              <div
                v-for="row in preset.matrix"
                :key="row.persona"
                class="flex items-baseline gap-1.5"
                :data-testid="`report-visibility-matrix-${preset.mode}-${row.persona}`"
              >
                <dt class="text-carbon-2 font-medium shrink-0">{{ row.persona }}</dt>
                <dd class="text-carbon-3 font-mono truncate">
                  {{ row.scopes.length ? row.scopes.join(', ') : 'no reports' }}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </label>

      <div class="flex items-center justify-between gap-3 mt-1">
        <p class="text-[11px] text-carbon-3 italic" data-testid="report-visibility-setby">
          {{ setBy ?? 'Using the default (Standard) — never changed.' }}
        </p>
        <UiButton
          v-if="orgWide"
          kind="primary"
          size="sm"
          :disabled="saving || !dirty"
          data-testid="report-visibility-save"
          @click="save"
        >
          {{ saving ? 'Saving…' : 'Save' }}
        </UiButton>
      </div>
      <p v-if="!orgWide" class="text-[11px] text-carbon-3 italic">
        Report visibility is org-wide config — only platform / global-finops admins can change it.
      </p>
    </div>
  </UiCard>
</template>
