<script setup lang="ts">
/*
 * New project onboarding (Journey 4 — project + baseline budget in one
 * pass). Creates the project, then a baseline allocation, then deep-
 * links into the allocation editor where the manager wires assignees
 * and (optionally) per-developer caps.
 *
 * Two POSTs in sequence rather than one composite endpoint: the server
 * keeps project-create and allocation-create as separate resources, so
 * the UI orchestrates the pair and routes to the new allocation on
 * success.
 */
import { computed, ref } from 'vue'
import type { Crumb } from '../../components/ui/Breadcrumb.vue'

interface OrgUnit {
  id: string
  path: string
  display_name: string
  is_cost_owning_unit: boolean
  unit_type: string
}

const { session, ensure } = useSession()
await ensure()

const regionId = computed(() => session.value?.regionId ?? '')

const { data: orgUnits } = await useFetch<{ nodes: OrgUnit[] }>(
  () => (regionId.value ? `/api/v1/admin/org-units?region=${regionId.value}` : ''),
  {
    default: () => ({ nodes: [] }),
    immediate: !!regionId.value,
  },
)

// Prefer cost-owning units; fall back to all nodes if none are flagged
// (older regions may pre-date the cost-owning-unit attribute).
const couOptions = computed<OrgUnit[]>(() => {
  const nodes = orgUnits.value?.nodes ?? []
  const owning = nodes.filter((n) => n.is_cost_owning_unit)
  return owning.length > 0 ? owning : nodes
})

const code = ref('')
const displayName = ref('')
const wbsCode = ref('')
const type = ref<'billable' | 'pursuit' | 'internal'>('billable')
const couId = ref('')
const budgetUsd = ref('')
const fromIso = ref('')
const toIso = ref('')

/*
 * FE-3: idempotent two-step submit. useProjectCreate remembers the created
 * project id across attempts, so a failed budget step retries ONLY the
 * allocation POST — re-POSTing the project would 409 on the unique code and
 * dead-end the user with an orphaned, budget-less project.
 */
const {
  createdProjectId,
  submitting,
  error: submitError,
  failedStep,
  submit: submitCreate,
} = useProjectCreate()

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (!code.value.trim()) return false
  if (!displayName.value.trim()) return false
  if (!couId.value) return false
  if (!/^\d+(\.\d{1,2})?$/.test(budgetUsd.value)) return false
  if (Number(budgetUsd.value) <= 0) return false
  if (!fromIso.value || !toIso.value) return false
  return fromIso.value < toIso.value
})

const crumbs: Crumb[] = [
  { label: 'Allocations', to: '/allocations' },
  { label: 'New project' },
]

async function submit() {
  if (!canSubmit.value) return
  const allocationId = await submitCreate(
    {
      code: code.value.trim(),
      display_name: displayName.value.trim(),
      type: type.value,
      region_id: regionId.value,
      cost_owning_unit_id: couId.value,
      ...(wbsCode.value.trim() ? { wbs_code: wbsCode.value.trim() } : {}),
    },
    {
      budget_usd: budgetUsd.value,
      effective: `[${fromIso.value}T00:00:00Z,${toIso.value}T00:00:00Z)`,
    },
  )
  if (allocationId) {
    await navigateTo(`/allocations/${allocationId}`)
  }
}
</script>

<template>
  <div class="max-w-[920px] mx-auto px-10 py-8 pb-20">
    <UiPageHead
      eyebrow="Onboarding"
      title="New project"
      sub="Create a project and its baseline budget. You'll wire assignees and per-developer caps next."
    >
      <template #actions>
        <NuxtLink to="/allocations">
          <UiButton kind="secondary" size="sm">Cancel</UiButton>
        </NuxtLink>
        <UiButton
          kind="primary"
          size="sm"
          :disabled="!canSubmit"
          :title="!canSubmit && !submitting ? 'Fill in code, name, cost-owning unit, a positive budget, and a valid date range.' : undefined"
          data-testid="new-project-submit"
          @click="submit"
        >
          {{ submitting ? 'Creating…' : createdProjectId ? 'Retry budget creation' : 'Create project + budget' }}
        </UiButton>
      </template>
    </UiPageHead>
    <UiBreadcrumb :crumbs="crumbs" class="-mt-6 mb-6" />

    <!-- FE-3: the two failure modes read differently — a failed budget step
         means the project EXISTS and resubmitting retries only the budget. -->
    <div
      v-if="submitError"
      class="mb-5 px-4 py-3 rounded-md bg-brand-hunger-sheer border border-brand-hunger/40 text-sm text-brand-heart"
      data-testid="new-project-error"
      role="alert"
    >
      <template v-if="failedStep === 'allocation'">
        <span class="font-bold">Project created, but the budget could not be added</span> —
        {{ submitError }} Fix the budget fields and retry; the project will not be created twice.
      </template>
      <template v-else>
        Could not create project — {{ submitError }}
      </template>
    </div>

    <div class="space-y-5">
      <UiCard>
        <div class="text-sm font-bold text-carbon mb-3">Project details</div>
        <p
          v-if="createdProjectId"
          class="text-xs text-carbon-3 mb-3"
          data-testid="new-project-created-note"
        >
          ✓ Project created — these details are locked. Only the budget step below will be retried.
        </p>
        <div class="grid grid-cols-2 gap-4">
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Project code</span>
            <input
              v-model="code"
              type="text"
              :disabled="!!createdProjectId"
              placeholder="e.g. ACME-2026"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-code"
            >
          </label>
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Display name</span>
            <input
              v-model="displayName"
              type="text"
              :disabled="!!createdProjectId"
              placeholder="e.g. Acme platform rebuild"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-name"
            >
          </label>
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Type</span>
            <select
              v-model="type"
              :disabled="!!createdProjectId"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-type"
            >
              <option value="billable">Billable</option>
              <option value="pursuit">Pursuit</option>
              <option value="internal">Internal</option>
            </select>
          </label>
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Cost-owning unit</span>
            <select
              v-model="couId"
              :disabled="!!createdProjectId"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-cou"
            >
              <option value="" disabled>Select a unit…</option>
              <option v-for="u in couOptions" :key="u.id" :value="u.id">{{ u.display_name }}</option>
            </select>
          </label>
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">WBS code (optional)</span>
            <input
              v-model="wbsCode"
              type="text"
              maxlength="64"
              :disabled="!!createdProjectId"
              placeholder="e.g. 1.2.3 — finance-system correlation"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-wbs"
            >
          </label>
        </div>
      </UiCard>

      <UiCard>
        <div class="text-sm font-bold text-carbon mb-3">Baseline budget and effective period</div>
        <div class="grid grid-cols-3 gap-4">
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">Budget (USD)</span>
            <input
              v-model="budgetUsd"
              type="text"
              inputmode="decimal"
              placeholder="1000.00"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md font-mono focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-budget"
            >
          </label>
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">From</span>
            <input
              v-model="fromIso"
              type="date"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-from"
            >
          </label>
          <label class="text-xs">
            <span class="block text-carbon-3 font-bold uppercase tracking-[1px] mb-1">To</span>
            <input
              v-model="toIso"
              type="date"
              class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
              data-testid="new-project-to"
            >
          </label>
        </div>
      </UiCard>
    </div>
  </div>
</template>
