// @vitest-environment node
/*
 * The CLIENT half of the reporting-nav relocation.
 *
 * The verdict moved to the server, and an external review pointed out that the
 * server tests stay green if the header inverts it, drops the owner deep-link,
 * renders the entry unconditionally, or mangles the query string — none of that
 * is reachable from a route test. This covers that half.
 *
 * The e2e suite that would otherwise catch it is skipped
 * (tests/e2e/journey-1.spec.ts), so this is the only guard on the link target.
 */
import { describe, it, expect } from 'vitest'
import {
  reportingNavEntry,
  withReportingEntry,
  type NavLink,
} from '../../../shared/nav/reporting-entry'

const DEV: NavLink[] = [
  { to: '/', label: 'Home' },
  { to: '/projects', label: 'My projects' },
  { to: '/usage', label: 'My usage' },
]
const ADMIN: NavLink[] = [...DEV, { to: '/admin', label: 'Admin' }]

describe('reportingNavEntry', () => {
  it('renders nothing when the verdict says not visible', () => {
    expect(reportingNavEntry({ visible: false, scope: null })).toBeNull()
  })

  it('FAILS CLOSED on an absent verdict — loading, unauthenticated, or degraded', () => {
    // The degraded case is real: /auth/me catches a DB failure and returns
    // {visible:false}. Undefined covers "probe has not answered yet".
    expect(reportingNavEntry(undefined)).toBeNull()
    expect(reportingNavEntry(null)).toBeNull()
  })

  it('links to bare /reporting when there is no deep-link scope', () => {
    expect(reportingNavEntry({ visible: true, scope: null })).toEqual({
      to: '/reporting',
      label: 'Reporting',
    })
  })

  it('deep-links an owner to their P&L scope', () => {
    expect(reportingNavEntry({ visible: true, scope: 'cost-centre' })).toEqual({
      to: '/reporting?scope=cost-centre',
      label: 'Reporting',
    })
  })

  it('never invents a scope — a visible verdict with none stays bare', () => {
    // Guards the "the shell self-lands on its own defaultScope, so this must
    // never hardcode one" rule: a hardcoded default here would send every
    // non-owner to the wrong tab.
    const link = reportingNavEntry({ visible: true, scope: null })
    expect(link?.to).not.toContain('scope=')
  })
})

describe('withReportingEntry', () => {
  it('splices BEFORE Admin, which stays last', () => {
    const links = withReportingEntry(ADMIN, { visible: true, scope: null })
    expect(links.map((l) => l.to)).toEqual([
      '/',
      '/projects',
      '/usage',
      '/reporting',
      '/admin',
    ])
    expect(links.at(-1)?.to).toBe('/admin')
  })

  it('appends at the end when the role has no Admin entry', () => {
    const links = withReportingEntry(DEV, { visible: true, scope: 'cost-centre' })
    expect(links.map((l) => l.to)).toEqual([
      '/',
      '/projects',
      '/usage',
      '/reporting?scope=cost-centre',
    ])
  })

  it('returns the base links untouched when not visible', () => {
    expect(withReportingEntry(ADMIN, { visible: false, scope: null }).map((l) => l.to)).toEqual(
      ADMIN.map((l) => l.to),
    )
    expect(withReportingEntry(ADMIN, undefined).map((l) => l.to)).toEqual(ADMIN.map((l) => l.to))
  })

  it('does not mutate the caller’s base array', () => {
    const base = [...ADMIN]
    withReportingEntry(base, { visible: true, scope: null })
    expect(base).toHaveLength(ADMIN.length)
  })
})
