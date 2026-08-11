<script setup lang="ts">
/*
 * Retired: the three-mode admin dial (mig 0087) is replaced by per-teammate
 * report-access grants (mig 0129, task #19) at /admin/policies/report-access.
 * This bare redirect preserves bookmarks / deep links rather than 404-ing —
 * same pattern as app/pages/admin/policies/index.vue.
 */
definePageMeta({ middleware: 'admin' })
await navigateTo('/admin/policies/report-access', { redirectCode: 302, replace: true })
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-16 text-center text-sm text-carbon-2">Redirecting…</div>
</template>
