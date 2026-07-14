<script setup lang="ts">
/*
 * UiEmptyState — friendly empty-state per design-notes §Microcopy.
 *
 * Charm + headline + sub copy. Optional default slot for action
 * affordances (CTA buttons). Used wherever a list might legitimately
 * be empty — inbox, project buckets, finance with no data, manager
 * with no team.
 */

import UiConfidenceCharm from './ConfidenceCharm.vue'

defineProps<{
  headline: string
  sub?: string
}>()
</script>

<template>
  <div class="py-12 px-6 flex flex-col items-center text-center">
    <UiConfidenceCharm class="mb-5" />
    <div class="text-lg font-bold text-carbon">{{ headline }}</div>
    <p
      v-if="sub"
      class="text-sm text-carbon-2 mt-2 max-w-md mx-auto leading-relaxed"
    >
      {{ sub }}
    </p>
    <div v-if="$slots.default" class="mt-5 flex items-center gap-2">
      <slot />
    </div>
  </div>
</template>
