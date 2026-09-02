<script setup lang="ts">
/*
 * AdminPageSkeleton — the loading placeholder every admin page renders while
 * its data is ABSENT (not while a refetch is in flight). `aria-busy` + the
 * visually-hidden label announce the state to AT and are the attribute the
 * smoke gate asserts on. docs/design/admin-nav-responsiveness.md D2.
 */
withDefaults(
  defineProps<{
    /** Stat tiles to sketch above the rows (0 = none). */
    tiles?: number
    /** Table rows to sketch. */
    rows?: number
    /** Sketch a toolbar strip (filters / actions) above the rows. */
    toolbar?: boolean
  }>(),
  { tiles: 0, rows: 6, toolbar: true },
)
</script>

<template>
  <div class="animate-pulse space-y-4" data-testid="admin-skeleton" aria-busy="true" role="status">
    <span class="sr-only">Loading…</span>

    <div v-if="tiles > 0" class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <div v-for="t in tiles" :key="t" class="h-20 rounded-xl bg-calm-2" />
    </div>

    <div v-if="toolbar" class="h-10 w-2/3 rounded-md bg-calm-2" />

    <div class="space-y-2">
      <div v-for="r in rows" :key="r" class="h-8 rounded-md bg-calm-1" />
    </div>
  </div>
</template>
