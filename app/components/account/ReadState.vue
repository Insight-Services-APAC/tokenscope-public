<script setup lang="ts">
/*
 * AccountReadState — one My account card's read, in its three honest states
 * (#581): loading (a skeleton), failed (it says so and offers Retry), loaded
 * (the card's own content, empty or not).
 *
 * The page used to await six reads in a row and print a confident empty for
 * any that failed ("No enrolled devices yet"). A failed read is not an empty
 * one: it renders here as a failure, and the slot (where the "none yet" lines
 * live) only renders once the read has landed.
 */
import { computed } from 'vue'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'

const props = defineProps<{
  /** The read has not landed yet (and there is nothing to show from before). */
  loading: boolean
  /** The read's error, null when healthy. */
  error: unknown
  /** What failed, in the reader's words: "your devices". */
  label: string
  /** What the failure means for the reader. */
  failSub?: string
  testid: string
}>()

const emit = defineEmits<{ retry: [] }>()

const detail = computed(() => (props.error ? apiErrorDetail(props.error, '') : ''))
</script>

<template>
  <div
    v-if="error"
    role="alert"
    class="mt-3 rounded-md border border-brand-hunger/40 bg-brand-hunger-sheer px-4 py-3 flex items-center justify-between gap-4"
    :data-testid="`${testid}-error`"
  >
    <div class="min-w-0">
      <p class="text-sm font-semibold text-brand-heart">We couldn't load {{ label }}.</p>
      <p class="text-[12px] text-carbon-2 mt-0.5">
        {{ failSub ?? 'Nothing is shown rather than a guess.' }}
        <span v-if="detail" class="text-carbon-3">({{ detail }})</span>
      </p>
    </div>
    <UiButton kind="secondary" size="sm" :data-testid="`${testid}-retry`" @click="emit('retry')">Retry</UiButton>
  </div>
  <div
    v-else-if="loading"
    class="mt-3 animate-pulse space-y-2"
    role="status"
    aria-busy="true"
    :aria-label="`Loading ${label}`"
    :data-testid="`${testid}-loading`"
  >
    <div class="h-4 rounded bg-calm-2 w-2/3" />
    <div class="h-4 rounded bg-calm-2 w-1/2" />
  </div>
  <slot v-else />
</template>
