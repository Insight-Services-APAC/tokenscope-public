/*
 * useAdminNav — derives the role-filtered admin sidebar model, the active item,
 * and linked breadcrumbs from the current route + the shared IA (shared/nav/
 * admin-nav). Also owns the responsive drawer open-state.
 *
 * Uniform disclosure (per the design review): every item stays VISIBLE; ones
 * the role can't use render locked+disabled with a dynamic "Requires:" hint,
 * rather than being hidden — so the surface is discoverable and the hint never
 * goes stale against a hardcoded role string.
 */
import { computed, watch } from 'vue'
import {
  ADMIN_NAV,
  matchAdminNavItem,
  groupForItem,
  roleMeetsAccess,
  type AdminNavItem,
} from '#shared/nav/admin-nav'
import { roleLabel } from '#shared/auth/roles'
import type { Crumb } from '../components/ui/Breadcrumb.vue'

export interface AdminNavItemView extends AdminNavItem {
  active: boolean
  locked: boolean
  lockHint: string | null
}

export function useAdminNav() {
  const route = useRoute()
  const { role } = useAdminAccess()

  // Optional trailing crumbs a dynamic page contributes (e.g. a region name on
  // /admin/regions/:id). Shared state so the layout renders them.
  const crumbTail = useState<Crumb[]>('ts:admin:crumb-tail', () => [])

  // Responsive drawer (collapsed sidebar below the lg breakpoint).
  const drawerOpen = useState<boolean>('ts:admin:drawer', () => false)

  // On a PATH change: clear any page-contributed trailing crumbs (a dynamic
  // page re-sets its own tail on mount) and close the mobile drawer (covers
  // navigations that don't originate from a sidebar click, e.g. a breadcrumb
  // link). Query-only changes — e.g. tab switches — preserve both.
  watch(
    () => route.path,
    () => {
      crumbTail.value = []
      drawerOpen.value = false
    },
  )

  // fullPath (incl. query) so query-constrained items (Providers) resolve.
  const current = computed(() => matchAdminNavItem(route.fullPath))

  function hintFor(item: AdminNavItem): string | null {
    if (roleMeetsAccess(role.value, item.access)) return null
    const need =
      item.access === 'platform'
        ? 'platform-admin'
        : item.access === 'org-wide'
          ? 'global-finops'
          : 'admin'
    return `Requires: ${roleLabel(need)}`
  }

  const groups = computed(() =>
    ADMIN_NAV.map((g) => ({
      label: g.label,
      items: g.items.map<AdminNavItemView>((item) => {
        const locked = !roleMeetsAccess(role.value, item.access)
        return {
          ...item,
          active: current.value === item,
          locked,
          lockHint: locked ? hintFor(item) : null,
        }
      }),
    })),
  )

  // Routes that live OUTSIDE the grouped IA (pinned links) but still deserve a
  // breadcrumb crumb for consistency.
  const PINNED_CRUMBS: Record<string, string> = { '/admin/help': 'Roles & terms' }

  const breadcrumbs = computed<Crumb[]>(() => {
    const item = current.value
    const base: Crumb[] = [{ label: 'Admin', to: '/admin' }]
    if (!item) {
      const pinned = PINNED_CRUMBS[route.path]
      if (pinned) base.push({ label: pinned })
      return [...base, ...crumbTail.value]
    }
    const group = groupForItem(item)
    if (group?.label) base.push({ label: group.label }) // group is a section, not a route
    // The item itself: linked unless it's the last crumb with no tail.
    const tail = crumbTail.value
    if (item.to !== '/admin') {
      base.push(tail.length ? { label: item.label, to: item.to } : { label: item.label })
    }
    return [...base, ...tail]
  })

  return { groups, current, breadcrumbs, crumbTail, drawerOpen }
}

/**
 * Page helper: set the trailing breadcrumb(s) for a dynamic admin page (e.g.
 * the region name). Pass [] / call with nothing to clear. Safe to call in
 * setup; re-runs when the page's reactive source changes via a watcher there.
 */
export function useAdminBreadcrumbTail() {
  const crumbTail = useState<Crumb[]>('ts:admin:crumb-tail', () => [])
  function setTail(crumbs: Crumb[]) {
    crumbTail.value = crumbs
  }
  return { setTail }
}
