<script setup lang="ts">
/*
 * SettlingStateChip — the settling clock for a vendor's numbers.
 *
 * build-design §5 + owner-decisions gate fold-in: nothing in the reporting
 * area is billed-grade, so the copy bank BANS "finalised". `settled` is a clock
 * state ONLY (past the settling horizon) until the reporting-snapshot close
 * machinery ships — it renders the exact provisional copy, never a close claim.
 *
 * Reuses UiBadge (the shared pill primitive) for the state dot; the long
 * descriptor sits alongside so the pill stays compact.
 */
import { computed } from 'vue'
import UiBadge from '../ui/Badge.vue'
import { vendorLabel, type SettlingState } from '#shared/reports/types'
import { settlingDay, settlingPill } from '#shared/reports/settling-words'

const props = withDefaults(
  defineProps<{
    state: SettlingState
    /** ISO day or UTC-midnight instant the vendor's numbers settle at; shown as "1 Dec 2026". */
    horizonDate?: string
    /** Vendor code — prefixes the chip when set (e.g. "Anthropic"). */
    vendor?: string
  }>(),
  { horizonDate: undefined, vendor: undefined },
)

// Short pill word (shared with the printed header, #583) + long human
// descriptor. NEVER "finalised" anywhere.
const pill = computed(() => settlingPill(props.state))

const descriptor = computed(() => {
  switch (props.state) {
    case 'estimated':
      return 'month in progress'
    case 'settling': {
      const until = props.horizonDate ? settlingDay(props.horizonDate) : ''
      return until ? `provisional until ${until}` : 'provisional'
    }
    case 'settled':
      // Exact required copy — a clock state, not a close run.
      return 'past settling horizon — provisional (no close run)'
  }
  return ''
})

// All three states are pre-close → amber dot (nothing reads as green/final).
const vendorText = computed(() => (props.vendor ? vendorLabel(props.vendor) : ''))
</script>

<template>
  <span
    class="inline-flex items-center gap-2 flex-wrap"
    data-testid="settling-state-chip"
    :data-state="state"
  >
    <span v-if="vendorText" class="text-[11px] font-semibold text-carbon-2">{{ vendorText }}</span>
    <UiBadge kind="rag-amber" dot="amber">{{ pill }}</UiBadge>
    <span class="text-[11px] text-carbon-3">{{ descriptor }}</span>
  </span>
</template>
