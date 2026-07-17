/*
 * admin-nav — the shared admin IA. Tests the pure matchers/access logic the
 * sidebar + breadcrumb derivation depend on (no Vue/Nuxt runtime).
 */
import { describe, it, expect } from 'vitest'
import {
  ADMIN_NAV,
  allAdminNavItems,
  matchAdminNavItem,
  groupForItem,
  roleMeetsAccess,
} from '../../../shared/nav/admin-nav'

describe('matchAdminNavItem — longest-prefix active item', () => {
  it('maps the hub root to Overview', () => {
    expect(matchAdminNavItem('/admin')?.testid).toBe('overview')
    expect(matchAdminNavItem('/admin/')?.testid).toBe('overview')
  })

  it('prefers Regions over Overview for a region detail route', () => {
    // /admin/regions/:id must NOT collapse onto Overview (/admin).
    expect(matchAdminNavItem('/admin/regions/abc-123')?.testid).toBe('regions')
    expect(matchAdminNavItem('/admin/regions')?.testid).toBe('regions')
  })

  it('resolves query-constrained items — Providers vs Reconciliation on the same path', () => {
    // Providers and Reconciliation share /admin/reconciliation; the ?tab= query
    // disambiguates. A query-constrained item out-ranks the bare one.
    expect(matchAdminNavItem('/admin/reconciliation?tab=providers')?.testid).toBe('providers')
    expect(matchAdminNavItem('/admin/reconciliation?tab=runs')?.testid).toBe('reconciliation')
    expect(matchAdminNavItem('/admin/reconciliation')?.testid).toBe('reconciliation')
    expect(matchAdminNavItem('/admin/reconciliation?tab=records')?.testid).toBe('reconciliation')
  })

  it('returns null for a non-admin path', () => {
    expect(matchAdminNavItem('/reporting')).toBeNull()
  })

  it('Overview matches ONLY exactly — never swallows an admin route not in the nav', () => {
    // /admin/help is pinned, not in ADMIN_NAV. Overview (match /admin) must NOT
    // claim it as a prefix, else Overview double-highlights and the pinned
    // breadcrumb branch never runs.
    expect(matchAdminNavItem('/admin/help')).toBeNull()
    expect(matchAdminNavItem('/admin/some-future-unlisted-page')).toBeNull()
    expect(matchAdminNavItem('/admin')?.testid).toBe('overview')
  })

  it('every nav item resolves to itself', () => {
    for (const item of allAdminNavItems()) {
      expect(matchAdminNavItem(item.to)?.to).toBe(item.to)
    }
  })
})

describe('groupForItem', () => {
  it('finds the containing group', () => {
    const teammates = allAdminNavItems().find((i) => i.testid === 'teammates')!
    expect(groupForItem(teammates)?.label).toBe('People')
  })
  it('null in → null out', () => {
    expect(groupForItem(null)).toBeNull()
  })
})

describe('roleMeetsAccess', () => {
  it('platform-admin satisfies every access level', () => {
    for (const a of ['admin', 'org-wide', 'platform'] as const) {
      expect(roleMeetsAccess('platform-admin', a)).toBe(true)
    }
  })
  it('global-finops satisfies admin + org-wide, not platform', () => {
    expect(roleMeetsAccess('global-finops', 'admin')).toBe(true)
    expect(roleMeetsAccess('global-finops', 'org-wide')).toBe(true)
    expect(roleMeetsAccess('global-finops', 'platform')).toBe(false)
  })
  it('region admin satisfies only admin', () => {
    expect(roleMeetsAccess('admin', 'admin')).toBe(true)
    expect(roleMeetsAccess('admin', 'org-wide')).toBe(false)
    expect(roleMeetsAccess('admin', 'platform')).toBe(false)
  })
  it('non-admin roles satisfy nothing', () => {
    for (const a of ['admin', 'org-wide', 'platform'] as const) {
      expect(roleMeetsAccess('developer', a)).toBe(false)
      expect(roleMeetsAccess(null, a)).toBe(false)
    }
  })
})

describe('IA invariants', () => {
  it('the first group is the ungrouped Overview home', () => {
    expect(ADMIN_NAV[0]!.label).toBeNull()
    expect(ADMIN_NAV[0]!.items).toHaveLength(1)
    expect(ADMIN_NAV[0]!.items[0]!.to).toBe('/admin')
  })
  it('every item has a unique route and testid', () => {
    const items = allAdminNavItems()
    expect(new Set(items.map((i) => i.to)).size).toBe(items.length)
    expect(new Set(items.map((i) => i.testid)).size).toBe(items.length)
  })
})
