<script setup lang="ts">
/*
 * UiFreshness — "updated N min ago" indicator.
 *
 * Copy is intentionally tone-matched (per design-notes.md §Microcopy):
 * action over alarm, includes the lag caveat for the Anthropic actuals.
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
    Updated {{ minutes }} min ago · Anthropic actuals lag ~1 hr
  </div>
</template>
