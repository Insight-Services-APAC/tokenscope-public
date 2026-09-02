<script setup lang="ts">
/*
 * UiAttributionStallBanner — the degradation banner (ops-alerting §A6.2).
 *
 * Shown when the server's attribution-stall signal holds (the joiner is
 * running but landing nothing while clients still emit — §A2.2, computed by
 * server/usage/attribution-stall.ts and shipped as `attribution_stall` on the
 * /me/home and /me/usage payloads). Renders nothing on null, so it auto-clears
 * with the signal.
 *
 * Constraints:
 *  - the message shape is the design's, verbatim: "Attribution has not landed
 *    data since <time> — recent spend may be missing from these figures.";
 *  - `since` is an INSTANT, so it renders in the viewer's local zone
 *    (clock-and-day-boundary.md: instants render local; day buckets never
 *    convert).
 */
import { computed } from 'vue'

const props = defineProps<{
  /** The `attribution_stall` payload leg; null/absent = no stall, render nothing. */
  stall?: { since: string } | null
}>()

const sinceLabel = computed(() =>
  props.stall ? new Date(props.stall.since).toLocaleString() : '',
)
</script>

<template>
  <div
    v-if="stall"
    role="status"
    class="px-4 py-3 rounded-md bg-rag-amber/10 border border-rag-amber/40 text-sm text-carbon flex items-center gap-2.5"
    data-testid="attribution-stall-banner"
  >
    <span class="inline-block w-2 h-2 rounded-full bg-rag-amber shrink-0" aria-hidden="true" />
    <span>
      Attribution has not landed data since {{ sinceLabel }} — recent spend may be missing from
      these figures.
    </span>
  </div>
</template>
