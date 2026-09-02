<script setup lang="ts">
/*
 * Legacy singular /admin/region — dissolved into /admin/regions (list) and
 * /admin/regions/:id (per-region). This stub redirects to the caller's home
 * region, falling back to the regions list. Kept (not deleted) because older
 * links may still target this path.
 */
definePageMeta({ middleware: 'admin' })

// No `await ensure()`: the `admin` middleware populates the session before
// this page instantiates (admin-nav-responsiveness D1). A null session here
// means the middleware did not run — fall back to /admin rather than guess.
const { session } = useSession()

// Preserve the query — old ?tab= deep-links must survive the redirect.
const route = useRoute()
const qs = new URLSearchParams(route.query as Record<string, string>).toString()
const suffix = qs ? `?${qs}` : ''
const regionId = session.value?.regionId
await navigateTo(
  session.value == null ? '/admin' : regionId ? `/admin/regions/${regionId}${suffix}` : `/admin/regions${suffix}`,
)
</script>

<template>
  <div class="max-w-[1600px] mx-auto px-10 py-16 text-center text-sm text-carbon-2" data-admin-page="/admin/region">
    Redirecting…
  </div>
</template>
