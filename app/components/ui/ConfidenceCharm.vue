<script setup lang="ts">
/*
 * UiConfidenceCharm — decorative stacked-circles charm.
 *
 * Per design-notes §Charms: used in empty-state hero positions
 * (empty inbox, "nothing to see" states). Three concentric circles in
 * brand colours; aria-hidden because it's pure decoration.
 */

withDefaults(
  defineProps<{
    size?: number
  }>(),
  { size: 72 },
)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 72 72"
    fill="none"
    aria-hidden="true"
    role="presentation"
  >
    <circle cx="36" cy="36" r="34" stroke="var(--brand-harmony)" stroke-width="2" opacity="0.4" />
    <circle cx="36" cy="36" r="22" stroke="var(--brand-vision)" stroke-width="2" opacity="0.6" />
    <circle cx="36" cy="36" r="10" fill="var(--brand-zeal)" opacity="0.8" />
  </svg>
</template>
