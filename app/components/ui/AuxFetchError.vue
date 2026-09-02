<script setup lang="ts">
/*
 * UiAuxFetchError — the one-line failure surface for an AUXILIARY read: the
 * ones that populate pickers and dropdowns rather than the page's own table.
 *
 * D2 (docs/design/admin-nav-responsiveness.md) forbids a false empty. An
 * auxiliary read that collapses failure into `[]` renders as "no options", and
 * the operator cannot tell "your region has no Business Units" from "we could
 * not load them". UiFetchErrorBanner is the block-level surface a PRIMARY read
 * gets; this is the inline form that fits under a control, so the control can
 * be disabled and still say why.
 *
 * Renders nothing while `error` is null — drop it under the control
 * unconditionally.
 */
import { computed } from 'vue'
import { apiErrorDetail } from '../../composables/useApiError'

const props = defineProps<{
  /** The `error` ref value from the auxiliary useLazyFetch (null when healthy). */
  error: unknown
  /** What failed, in user terms — e.g. "regions", "Business Units". */
  label: string
  /** Override when a page needs to target one of several notices. */
  testid?: string
}>()

const emit = defineEmits<{ retry: [] }>()

const detail = computed(() => (props.error ? apiErrorDetail(props.error, '') : ''))
</script>

<template>
  <p
    v-if="error"
    role="alert"
    class="mt-1 max-w-[20rem] text-[11px] font-semibold text-brand-hunger leading-snug break-words"
    :data-testid="testid ?? 'aux-fetch-error'"
  >
    Couldn't load {{ label }}<span v-if="detail" class="font-normal"> ({{ detail }})</span>.
    <button
      type="button"
      class="underline hover:no-underline"
      :data-testid="`${testid ?? 'aux-fetch-error'}-retry`"
      @click="emit('retry')"
    >Retry</button>
  </p>
</template>
