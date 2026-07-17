<script setup lang="ts">
/*
 * Legacy /admin/settings — the junk-drawer page was split into System info
 * (/admin/system, read-only config) and the Policies pages (/admin/policies/*,
 * each editable surface). This stub preserves old bookmarks / doc links.
 *
 * CLIENT-ONLY redirect on purpose: a browser never sends the URL fragment to
 * the server, so an SSR redirect (esp. a cacheable 301) would discard the
 * anchor and, once cached, permanently route every /admin/settings#x straight
 * to the default WITHOUT ever consulting the fragment map. Instead we render a
 * 200 "Redirecting…" page and resolve on the client, where window.location.hash
 * is available — so #report-visibility et al. reach their specific policy page.
 * See shared/nav/settings-redirect.ts.
 */
import { onMounted } from 'vue'
import { settingsRedirectFor } from '#shared/nav/settings-redirect'

definePageMeta({ middleware: 'admin' })

onMounted(() => {
  navigateTo(settingsRedirectFor(window.location.hash), { replace: true })
})
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-16 text-center text-sm text-carbon-2" data-testid="admin-settings-redirect">
    Redirecting…
  </div>
</template>
