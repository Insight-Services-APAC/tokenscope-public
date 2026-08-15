<script setup lang="ts">
/*
 * Admin -> Operations -> Worker controls.
 *
 * Turning a worker on or off is an ACTION, not an observation, so it lives on
 * its own page rather than inside Diagnostics. Diagnostics answers "are the
 * workers running correctly"; this page answers "which ones should be running".
 * Keeping a mutating control inside a read-only health page made the destructive
 * affordance easy to hit while scanning for a fault, and made the health page
 * the answer to two unrelated questions.
 *
 * The two surfaces stay linked, in both directions, because you almost always
 * arrive at one from the other: you disable a worker BECAUSE its health is bad,
 * and you check health AFTER disabling something.
 *
 * The cron keeps firing when a worker is off (mig 0090) — the dispatch
 * short-circuits and records a 'skipped' run, so Diagnostics shows WHY nothing
 * happened rather than an unexplained gap.
 */
import { computed, ref } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useHead({ title: 'Worker controls · TokenScope' })

const { session, ensure } = useSession()
await ensure()

// The two enablement endpoints sit at DIFFERENT tiers, so this page needs two
// checks, not one. Reading is admin / global-finops (enablement.get); the fetch
// stays cold for anyone else so an unauthorised visit does not fire a 403 on load.
const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})

// Writing is global-finops only (enablement.put) — `worker_enablement` has no
// region column and every worker it governs runs estate-wide, so a toggle exceeds
// a region admin's scope. A region admin still SEES the card: knowing which
// kill-switches are thrown is not a region boundary crossing, and hiding it would
// leave them unable to explain a gap in their own region's attribution. The API is
// the real gate — withholding the button just avoids offering a certain 403.
const canToggle = computed(() => {
  const r = session.value?.role
  return r === 'global-finops' || r === 'platform-admin'
})

interface WorkerEnablementRow {
  name: string
  recommendedCron: string | null
  scheduled: boolean
  unscheduledReason: string | null
  enabled: boolean
  reason: string | null
  explicit: boolean
}

const {
  data: enablementData,
  refresh: refreshEnablement,
  pending: enablementPending,
} = await useFetch<{ workers: WorkerEnablementRow[] }>('/api/v1/admin/workers/enablement', {
  default: () => null as unknown as { workers: WorkerEnablementRow[] },
  immediate: isAdmin.value,
})

const togglingWorker = ref<string | null>(null)
async function toggleWorker(w: WorkerEnablementRow) {
  const turningOff = w.enabled
  // A disable must say why — the next person (or the next incident) should not
  // have to guess, and the API rejects a reasonless disable.
  const reason = turningOff
    ? (globalThis.prompt(`Disable "${w.name}"? Give a reason (recorded + audited):`) ?? '').trim()
    : ''
  if (turningOff && !reason) return
  togglingWorker.value = w.name
  try {
    await $fetch('/api/v1/admin/workers/enablement', {
      method: 'PUT',
      body: { workerName: w.name, enabled: !w.enabled, ...(turningOff ? { reason } : {}) },
    })
    await refreshEnablement()
  } finally {
    togglingWorker.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <header class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-lg font-bold text-carbon m-0">Worker controls</h1>
        <p class="text-xs text-carbon-3 mt-1 max-w-2xl">
          Turn a scheduled worker off without a deploy — it takes effect on its next tick.
          Disabling is audited and needs a reason. A disabled worker still records a
          <span class="font-mono">skipped</span> run, so it never looks like a silent gap.
          To see whether the workers are actually succeeding, use
          <NuxtLink to="/admin/diagnostics" class="text-brand-harmony underline">Diagnostics</NuxtLink>.
        </p>
      </div>
      <UiButton
        kind="secondary"
        size="sm"
        :disabled="enablementPending"
        data-testid="worker-controls-refresh"
        @click="refreshEnablement()"
      >
        {{ enablementPending ? 'Loading…' : 'Refresh' }}
      </UiButton>
    </header>

    <UiCard accent="vision" data-testid="admin-worker-enablement">
      <ul v-if="enablementData?.workers?.length" class="divide-y divide-carbon-6">
        <AdminWorkerControlRow
          v-for="w in enablementData.workers"
          :key="w.name"
          :worker="w"
          :busy="togglingWorker === w.name"
          :can-toggle="canToggle"
          @toggle="toggleWorker(w)"
        />
      </ul>
      <p v-else-if="enablementPending" class="text-sm text-carbon-3 italic">Loading workers…</p>
      <p v-else class="text-sm text-carbon-3 italic">
        No workers registered. This is a bootstrap state, not a healthy one.
      </p>
    </UiCard>
  </div>
</template>
