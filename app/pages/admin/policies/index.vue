<script setup lang="ts">
/*
 * /admin/policies has no landing of its own — the sidebar links straight to the
 * leaf policy pages. A bare hit (typed URL / bookmark) redirects to the first
 * policy rather than 404-ing.
 */
definePageMeta({ middleware: 'admin' })
await navigateTo('/admin/policies/report-access', { redirectCode: 302, replace: true })
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-16 text-center text-sm text-carbon-2" data-admin-page="/admin/policies">Redirecting…</div>
</template>
