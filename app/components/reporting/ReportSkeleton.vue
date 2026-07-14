<script setup lang="ts">
/*
 * ReportSkeleton — loading placeholder for a reporting scope (header + KPI row
 * + chart block + table rows). Pulse blocks in the calm palette. `aria-busy`
 * + a visually-hidden label announce the loading state to AT. build-design §3:
 * every scope renders exactly one of skeleton/error/empty/data.
 */
withDefaults(
  defineProps<{
    /** Number of KPI tiles to sketch. */
    kpis?: number
    /** Number of table rows to sketch. */
    rows?: number
  }>(),
  { kpis: 4, rows: 6 },
)
</script>

<template>
  <div class="animate-pulse space-y-5" data-testid="report-skeleton" aria-busy="true" role="status">
    <span class="sr-only">Loading report…</span>

    <!-- Banner -->
    <div class="h-16 rounded-xl bg-calm-2" />

    <!-- KPI row -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div v-for="k in kpis" :key="k" class="h-24 rounded-xl bg-calm-2" />
    </div>

    <!-- Chart -->
    <div class="h-40 rounded-xl bg-calm-2" />

    <!-- Table rows -->
    <div class="space-y-2">
      <div v-for="r in rows" :key="r" class="h-8 rounded-md bg-calm-1" />
    </div>
  </div>
</template>
