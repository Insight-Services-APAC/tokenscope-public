<script setup lang="ts">
/*
 * ReportEmpty — the reporting-area empty state. Thin wrapper over UiEmptyState
 * with report-appropriate defaults; every scope renders exactly one of
 * skeleton/error/empty/data (build-design §3).
 */
import UiEmptyState from '../ui/EmptyState.vue'

withDefaults(
  defineProps<{
    headline?: string
    sub?: string
  }>(),
  {
    headline: 'Nothing to report for this month yet.',
    sub: 'As sessions and bills land for the selected month, this view fills in.',
  },
)
</script>

<template>
  <div data-testid="report-empty">
    <UiEmptyState :headline="headline" :sub="sub">
      <slot />
    </UiEmptyState>
  </div>
</template>
