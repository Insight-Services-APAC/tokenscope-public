<script setup lang="ts">
/*
 * One row of the admin "Scheduled worker controls" card.
 *
 * Extracted from the diagnostics page so this contract is unit-testable. It is
 * small but it makes CLAIMS to an operator, and a review caught it making two
 * false ones at once: it rendered a cron for a worker that has no cron job, and
 * offered an enable/disable toggle for a worker that never ticks. Both looked
 * fine in the template and neither could fail a test, because the markup lived
 * inline in a page that cannot be mounted without Nuxt data plumbing.
 *
 * The rule this encodes: `scheduled === false` means NO Container Apps job
 * exists, so there is nothing to turn on or off. Show that plainly instead of
 * implying control that does not exist.
 */
export interface WorkerControlRowData {
  name: string
  /** False = registered but never dispatched (no cron job at all). */
  scheduled: boolean
  unscheduledReason: string | null
  /** Live cron; null when unscheduled. */
  recommendedCron: string | null
  enabled: boolean
  /** Operator's recorded reason for having disabled it. */
  reason: string | null
}

defineProps<{ worker: WorkerControlRowData; busy?: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <li
    class="flex items-center justify-between gap-3 py-2"
    :data-testid="`admin-worker-toggle-${worker.name}`"
  >
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <!-- On/Off only means something for a worker that TICKS. -->
        <UiBadge
          v-if="worker.scheduled"
          :kind="worker.enabled ? 'harmony' : 'hunger'"
          data-testid="worker-state-badge"
        >
          {{ worker.enabled ? 'On' : 'Off' }}
        </UiBadge>
        <UiBadge v-else kind="vision" data-testid="worker-unscheduled-badge">Not scheduled</UiBadge>
        <span class="font-mono text-sm text-carbon truncate">{{ worker.name }}</span>
        <span
          v-if="worker.scheduled && worker.recommendedCron"
          class="text-[11px] text-carbon-3 font-mono"
          data-testid="worker-cron"
        >{{ worker.recommendedCron }}</span>
      </div>
      <p v-if="!worker.scheduled" class="text-[11px] text-carbon-3 mt-0.5">
        No cron job — this worker never runs.{{ worker.unscheduledReason ? ` ${worker.unscheduledReason}` : '' }}
      </p>
      <!-- The disabled-reason explains why a RUNNING worker was switched off. For an
           unscheduled worker it would assert a distinction that does not exist (it
           never runs either way), so it is suppressed along with the toggle. A stale
           row from before the API guard can still exist; do not surface it as though
           it governed anything. -->
      <p v-if="worker.scheduled && !worker.enabled && worker.reason" class="text-[11px] text-brand-hunger mt-0.5">
        {{ worker.reason }}
      </p>
    </div>
    <!-- No toggle when unscheduled: enabling or disabling has no observable
         effect, so offering the button implies control that does not exist. -->
    <UiButton
      v-if="worker.scheduled"
      :kind="worker.enabled ? 'secondary' : 'primary'"
      size="sm"
      :disabled="busy"
      data-testid="worker-toggle-button"
      @click="$emit('toggle')"
    >
      {{ busy ? '…' : worker.enabled ? 'Disable' : 'Enable' }}
    </UiButton>
  </li>
</template>
