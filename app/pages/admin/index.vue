<script setup lang="ts">
/*
 * Admin hub — landing page for admin / global-finops / platform-admin.
 *
 * Six tile cards: Users / Regions / Projects / Audit / Settings /
 * Diagnostics. Each tile shows a one-line summary stat fetched from its
 * sub-page endpoint. Tiles tolerate missing data (no region assigned, RLS
 * denial) and surface a placeholder rather than failing the page.
 *
 * RBAC: client-side guard via useSession() — server middleware would
 * still 401/403 a non-admin's API calls; the page just hides itself.
 */
import { computed } from 'vue'

const { session, ensure } = useSession()
await ensure()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})
const regionId = computed(() => session.value?.regionId ?? '')

/*
 * Load ordering (perf): the two CRITICAL tile stats (users, regions) are
 * fetched in PARALLEL and awaited together so the hub blocks on the slower
 * of the two, not their sum. The heavy/non-critical tiles (audit count,
 * diagnostics — which runs synchronous TCP service probes — and the
 * reconciliation summary) are `useLazyFetch`: they DON'T block the initial
 * render, and populate their tile when ready. Templates guard for the lazy
 * `data` being null with a "…" placeholder.
 *
 * useFetch/useLazyFetch must be called at the top level of <script setup>
 * (composable rule). We call them WITHOUT an immediate per-call await — each
 * returns an AsyncData (also a thenable) — then await Promise.all on the two
 * critical ones. Mirrors the parallel pattern on the reconciliation page.
 */

// User count — admin's home region. RLS-scoped via the endpoint.
const usersAsync = useFetch<{
  users: unknown[]
  total: number
  adminCount: number
}>(
  () => (regionId.value ? `/api/v1/admin/users?region=${regionId.value}&limit=1` : ''),
  {
    default: () => ({ users: [], total: 0, adminCount: 0 }),
    immediate: !!regionId.value,
  },
)
const users = usersAsync.data

// Regions count — every admin can list regions (RLS-scoped server-side).
const regionsAsync = useFetch<{
  regions: { id: string; code: string; display_name: string }[]
}>('/api/v1/admin/regions', {
  default: () => ({ regions: [] }),
  immediate: isAdmin.value,
})
const regions = regionsAsync.data

// Critical tiles: block on the slower of the two (parallel), not their sum.
await Promise.all([usersAsync, regionsAsync])

// Audit count over last 24h (region-scoped via the endpoint for admin). Lazy:
// off the critical path — the Audit tile shows "…" until it lands.
const since24h = computed(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
const { data: audit } = useLazyFetch<{ events: unknown[]; total: number } | null>(
  () => `/api/v1/admin/audit?limit=1&since=${encodeURIComponent(since24h.value)}`,
  {
    default: () => null,
    immediate: isAdmin.value,
  },
)

// Diagnostics — hits an endpoint with synchronous TCP service probes; keep it
// OFF the critical path so it never blocks first paint. Lazy.
const { data: diag } = useLazyFetch<{
  postgres: { reachable: boolean }
  redis: { unavailable: boolean }
} | null>('/api/v1/admin/diagnostics', {
  default: () => null,
  immediate: isAdmin.value,
})

// Reconciliation — proposed-delta count (awaiting application). Lazy.
const { data: recon } = useLazyFetch<{ summary: { total: number } } | null>(
  '/api/v1/admin/reconciliation/records?limit=1',
  { default: () => null, immediate: isAdmin.value },
)

/*
 * Tile catalogue. Each tile keeps its exact route, accent and (lazy-loaded)
 * stat — only the *grouping* below is new. Tiles are organised into three
 * task-oriented sections so a new region admin reads "start with your region"
 * rather than a flat wall of equal tiles:
 *
 *   region  — set up & run your own region (the day-one path)
 *   global  — org-wide configuration (global-finops / platform-admin)
 *   ops     — operational health + the audit/security surface
 *
 * `section` is purely presentational; visibility/role-gating is unchanged
 * (the whole hub is admin-gated by `isAdmin`).
 */
const tiles = computed(() => [
  {
    key: 'regions',
    section: 'region' as const,
    label: 'Regions',
    description: 'Your region and its cost-centre tree — create business units & practices, assign owners and leaders.',
    to: '/admin/regions',
    stat: `${regions.value?.regions.length ?? 0} regions`,
    accent: 'vision' as const,
  },
  {
    key: 'users',
    section: 'region' as const,
    label: 'Users',
    description: 'List, place, and invite teammates.',
    to: '/admin/users',
    stat: `${users.value?.total ?? 0} in region`,
    accent: 'harmony' as const,
  },
  {
    key: 'projects',
    section: 'region' as const,
    label: 'Projects',
    description: 'Create projects, set budgets, manage members.',
    to: '/admin/projects',
    stat: '',
    accent: 'zeal' as const,
  },
  {
    key: 'activity-tags',
    section: 'region' as const,
    label: 'Activity tags',
    description: 'Manage the activity vocabulary the picker suggests.',
    to: '/admin/activity-tags',
    stat: '',
    accent: 'harmony' as const,
  },
  {
    key: 'rate-cards',
    section: 'global' as const,
    label: 'Rate cards',
    description: 'Provider pricing — scope, period, and per-unit rates.',
    to: '/admin/rate-cards',
    stat: '',
    accent: 'zeal' as const,
  },
  {
    key: 'department-map',
    section: 'global' as const,
    label: 'Department map',
    description: 'Map Entra departments to regions — homes unplaced users.',
    to: '/admin/department-map',
    stat: '',
    accent: 'harmony' as const,
  },
  {
    key: 'settings',
    section: 'global' as const,
    label: 'Settings',
    description: 'Public config — auth, Entra IDs, region. Read-only.',
    to: '/admin/settings',
    stat: '',
    accent: 'zeal' as const,
  },
  {
    key: 'diagnostics',
    section: 'ops' as const,
    label: 'Diagnostics',
    description: 'Operational health — Postgres, Redis, queues.',
    to: '/admin/diagnostics',
    stat: diag.value ? (diag.value.postgres.reachable ? 'pg: ok' : 'pg: down') : '…',
    accent: 'hunger' as const,
  },
  {
    key: 'reconciliation',
    section: 'ops' as const,
    label: 'Reconciliation',
    description: 'Billing-reconciliation run history + the deltas it produced.',
    to: '/admin/reconciliation',
    stat: recon.value ? `${recon.value.summary.total} proposed` : '…',
    accent: 'vision' as const,
  },
  {
    key: 'audit',
    section: 'ops' as const,
    label: 'Audit',
    description: 'Mutation trail across admin actions and impersonation.',
    to: '/admin/audit',
    stat: audit.value ? `${audit.value.total} events · last 24h` : '…',
    accent: 'vision' as const,
  },
  {
    key: 'instances',
    section: 'ops' as const,
    label: 'Instances',
    description: 'See and block emitting devices.',
    to: '/admin/instances',
    stat: '',
    accent: 'hunger' as const,
  },
  {
    key: 'grants',
    section: 'ops' as const,
    label: 'Grants',
    description: 'Authorized connections per teammate — revoke a client.',
    to: '/admin/grants',
    stat: '',
    accent: 'vision' as const,
  },
])

/*
 * Section metadata + derived membership. Sections render in this order; a
 * section with no tiles is hidden (defensive — today every section has tiles).
 */
const sections = [
  {
    key: 'region',
    title: 'Set up & manage your region',
    sub: 'Start here. Your region holds the cost-centre tree (business units & practices), its teammates, and the projects that bill to it.',
  },
  {
    key: 'global',
    title: 'Global configuration',
    sub: 'Org-wide settings shared across every region.',
  },
  {
    key: 'ops',
    title: 'Operations',
    sub: 'Operational health, reconciliation, and the audit / device surface.',
  },
] as const

const sectionedTiles = computed(() =>
  sections
    .map((s) => ({ ...s, tiles: tiles.value.filter((t) => t.section === s.key) }))
    .filter((s) => s.tiles.length > 0),
)
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-hub">
    <UiPageHead
      eyebrow="Administration"
      title="Admin"
      sub="Users, Regions, and Projects are the day-to-day governance tools."
    />
    <p class="-mt-4 mb-8 text-sm text-carbon-2 leading-relaxed" data-testid="admin-hub-helper">
      New here? Start with your
      <NuxtLink to="/admin/regions" class="font-semibold text-brand-harmony no-underline hover:underline">
        Region
      </NuxtLink>
      to create your business units and practices.
    </p>

    <section
      v-for="s in sectionedTiles"
      :key="s.key"
      class="mb-10 last:mb-0"
      :data-testid="`admin-section-${s.key}`"
    >
      <div class="mb-4">
        <h2 class="text-base font-bold text-carbon tracking-tight">{{ s.title }}</h2>
        <p class="text-sm text-carbon-2 mt-1 leading-relaxed">{{ s.sub }}</p>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        <NuxtLink
          v-for="t in s.tiles"
          :key="t.key"
          :to="t.to"
          :data-testid="`admin-tile-${t.key}`"
          class="block"
        >
          <UiCard :accent="t.accent" hover>
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3 mb-1.5">
                  {{ t.label }}
                </div>
                <h3 class="text-lg font-bold text-carbon leading-snug">
                  Open {{ t.label }}
                </h3>
              </div>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-carbon-3 mt-1"
                aria-hidden="true"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </div>
            <p class="text-sm text-carbon-2 mt-2 leading-relaxed">{{ t.description }}</p>
            <div v-if="t.stat" class="mt-4 text-xs text-carbon-3 font-mono">
              {{ t.stat }}
            </div>
          </UiCard>
        </NuxtLink>
      </div>
    </section>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
    <p class="text-sm text-carbon-2 mt-2">
      Sign in as an admin or global-finops to view this hub.
    </p>
  </div>
</template>
