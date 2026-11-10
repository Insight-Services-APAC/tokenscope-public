<script setup lang="ts">
/*
 * AdminResultToast: the one way an admin page shows the result of an action
 * (#544). Both live regions are always in the page, empty until a result
 * lands: a region inserted together with its text is often not announced.
 * Success goes in role="status" (polite), a refusal in role="alert".
 *
 * Each message is keyed on its `seq`, so a repeat of the same text replaces
 * the node and is announced again rather than read as no change.
 *
 * `testid` keeps each page's existing hook: the message renders as
 * `${testid}-ok` or `${testid}-err`.
 */
import type { ResultToast } from '../../composables/useResultToast'

defineProps<{
  toast: ResultToast | null
  testid: string
}>()

const emit = defineEmits<{ dismiss: [] }>()
</script>

<template>
  <div data-result-toast>
    <div role="status" aria-live="polite">
      <div
        v-if="toast?.kind === 'ok'"
        :key="toast.seq"
        :data-testid="`${testid}-ok`"
        class="mb-4 p-3 rounded-md text-sm font-medium bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30"
      >
        {{ toast.message }}
      </div>
    </div>
    <div role="alert">
      <div
        v-if="toast?.kind === 'err'"
        :key="toast.seq"
        :data-testid="`${testid}-err`"
        class="mb-4 p-3 rounded-md text-sm font-medium bg-brand-hunger/10 text-brand-heart border border-brand-hunger/30 flex items-start gap-3"
      >
        <span class="flex-1">{{ toast.message }}</span>
        <button
          type="button"
          class="shrink-0 text-xs font-semibold underline underline-offset-2 hover:no-underline"
          :data-testid="`${testid}-dismiss`"
          @click="emit('dismiss')"
        >
          Dismiss
        </button>
      </div>
    </div>
  </div>
</template>
