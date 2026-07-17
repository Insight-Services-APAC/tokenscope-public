<script setup lang="ts">
/*
 * Admin → Overview. A BOUNDED role-aware launcher, not a second navigation: an
 * at-a-glance status strip + a short list of the highest-value common tasks
 * (the ones that were buried deepest in the old flat tile wall). Everything
 * else lives in the persistent sidebar — this page deliberately does NOT
 * re-list it.
 */
import { computed } from 'vue'
import { useAdminAccess } from '../../composables/useAdminAccess'

definePageMeta({ layout: 'admin', middleware: 'admin' })

const { isAdmin, isOrgWide, regionId, displayName, roleDisplay } = useAdminAccess()

// User count — the admin's home region (org-wide admins have no home region, so
// the URL getter is '' and the fetch is skipped: an explicit key avoids the
// empty-URL SSR key-derivation crash).
const usersAsync = useFetch<{ total: number }>(
  () => (regionId.value ? `/api/v1/admin/users?region=${regionId.value}&limit=1` : ''),
  { key: 'admin-overview-users', default: () => ({ total: 0 }), immediate: !!regionId.value },
)
const users = usersAsync.data

const regionsAsync = useFetch<{ regions: unknown[] }>('/api/v1/admin/regions', {
  key: 'admin-overview-regions',
  default: () => ({ regions: [] }),
  immediate: isAdmin.value,
})
const regions = regionsAsync.data

await Promise.all([usersAsync, regionsAsync])

const since24h = computed(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
const { data: audit } = useLazyFetch<{ total: number } | null>(
  () => `/api/v1/admin/audit?limit=1&since=${encodeURIComponent(since24h.value)}`,
  { key: 'admin-overview-audit', default: () => null, immediate: isAdmin.value },
)
const { data: diag } = useLazyFetch<{ postgres: { reachable: boolean } } | null>(
  '/api/v1/admin/diagnostics',
  { key: 'admin-overview-diag', default: () => null, immediate: isAdmin.value },
)
const { data: recon } = useLazyFetch<{ summary: { total: number } } | null>(
  '/api/v1/admin/reconciliation/records?limit=1',
  { key: 'admin-overview-recon', default: () => null, immediate: isAdmin.value },
)

// At-a-glance status. Lazy tiles show '…' until they land; never block paint.
const stats = computed(() => [
  { key: 'regions', label: 'Regions', value: String(regions.value?.regions.length ?? 0), to: '/admin/regions' },
  {
    key: 'teammates',
    label: 'Teammates in your region',
    value: regionId.value ? String(users.value?.total ?? 0) : '—',
    to: '/admin/users',
  },
  {
    key: 'recon',
    label: 'Proposed reconciliation deltas',
    value: recon.value ? String(recon.value.summary.total) : '…',
    to: '/admin/reconciliation',
  },
  {
    key: 'audit',
    label: 'Audit events · 24h',
    value: audit.value ? String(audit.value.total) : '…',
    to: '/admin/audit',
  },
  {
    key: 'postgres',
    label: 'Postgres',
    value: diag.value ? (diag.value.postgres.reachable ? 'ok' : 'down') : '…',
    to: '/admin/diagnostics',
  },
])

// Common tasks — the deepest / most-frequent actions, role-aware. Kept short on
// purpose; the sidebar is the complete surface.
const quickActions = computed(() => {
  const region = regionId.value ? `/admin/regions/${regionId.value}` : '/admin/regions'
  const actions = [
    { key: 'region', label: 'Set up your region', sub: 'Cost centres, owners, leaders, teammates', to: region, accent: 'vision' as const },
    { key: 'teammates', label: 'Add a teammate', sub: 'Provision someone from the directory', to: '/admin/users', accent: 'harmony' as const },
    { key: 'projects', label: 'Create a project', sub: 'Set a budget and add members', to: '/admin/projects', accent: 'zeal' as const },
    { key: 'reconciliation', label: 'Review reconciliation', sub: 'Runs, deltas and provider onboarding', to: '/admin/reconciliation', accent: 'harmony' as const },
  ]
  if (isOrgWide.value) {
    actions.push({ key: 'report-visibility', label: 'Report visibility', sub: 'Who sees which reports, org-wide', to: '/admin/policies/report-visibility', accent: 'vision' as const })
  }
  return actions
})
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-hub">
    <UiPageHead
      eyebrow="Administration"
      title="Overview"
      :sub="`Welcome back, ${displayName || roleDisplay}. Here's your region at a glance.`"
    />

    <!-- Status strip -->
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-10" data-testid="admin-overview-stats">
      <NuxtLink
        v-for="s in stats"
        :key="s.key"
        :to="s.to"
        :data-testid="`admin-stat-${s.key}`"
        class="block p-4 rounded-xl border border-calm-2 bg-paper no-underline hover:border-brand-harmony/40 transition-colors"
      >
        <div class="text-2xl font-bold text-carbon tabular-nums leading-none">{{ s.value }}</div>
        <div class="text-[11px] text-carbon-3 mt-1.5 leading-tight">{{ s.label }}</div>
      </NuxtLink>
    </div>

    <!-- Common tasks -->
    <h2 class="text-base font-bold text-carbon tracking-tight mb-1">Common tasks</h2>
    <p class="text-sm text-carbon-2 mb-4 leading-relaxed">
      The things admins do most. Everything else is in the sidebar on the left.
    </p>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      <NuxtLink
        v-for="a in quickActions"
        :key="a.key"
        :to="a.to"
        :data-testid="`admin-qa-${a.key}`"
        class="block"
      >
        <UiCard :accent="a.accent" hover>
          <div class="flex items-start justify-between gap-3">
            <h3 class="text-lg font-bold text-carbon leading-snug">{{ a.label }}</h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-carbon-3 mt-1 shrink-0" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
          </div>
          <p class="text-sm text-carbon-2 mt-2 leading-relaxed">{{ a.sub }}</p>
        </UiCard>
      </NuxtLink>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
    <p class="text-sm text-carbon-2 mt-2">Sign in as an admin to view this page.</p>
  </div>
</template>
