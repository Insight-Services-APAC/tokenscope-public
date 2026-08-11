<script setup lang="ts">
/*
 * UiFreshness — "updated N min ago" indicator.
 *
 * Copy is intentionally tone-matched (per design-notes.md §Microcopy):
 * action over alarm.
 *
 * It used to carry "· Anthropic actuals lag ~1 hr" on every render. That is a
 * fact about OUR ingestion mechanism, not about the reader's data — the fact
 * they need is how old this figure is, which the minutes already say. The place
 * to explain a lag is where the data IS stale, not beside a figure that is one
 * minute old.
 */

withDefaults(
  defineProps<{
    minutes?: number
  }>(),
  { minutes: 12 },
)
</script>

<template>
  <div class="text-[11px] text-carbon-3 inline-flex items-center gap-1.5">
    <span class="inline-block w-2 h-2 rounded-full bg-rag-green" aria-hidden="true" />
    Updated {{ minutes }} min ago
  </div>
</template>
