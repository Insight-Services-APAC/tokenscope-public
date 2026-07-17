/*
 * roles — the canonical role helpers + display labels added for the admin
 * redesign vocabulary layer. Guards the finance-zombie exclusion and the
 * one-source label map (no surface should render a raw enum code).
 */
import { describe, it, expect } from 'vitest'
import {
  ROLES,
  SELECTABLE_ROLES,
  ADMIN_ROLES,
  ORG_WIDE_ROLES,
  isAdminRole,
  isOrgWideRole,
  roleLabel,
  ROLE_LABELS,
} from '../../../shared/auth/roles'

describe('SELECTABLE_ROLES excludes the finance zombie', () => {
  it('never offers `finance` (retired, never assigned)', () => {
    expect(SELECTABLE_ROLES).not.toContain('finance')
  })
  it('keeps every other role', () => {
    expect([...SELECTABLE_ROLES].sort()).toEqual(ROLES.filter((r) => r !== 'finance').sort())
  })
})

describe('isAdminRole / isOrgWideRole', () => {
  it('admin roles are exactly the three admin-area roles', () => {
    expect([...ADMIN_ROLES]).toEqual(['admin', 'global-finops', 'platform-admin'])
    for (const r of ADMIN_ROLES) expect(isAdminRole(r)).toBe(true)
    expect(isAdminRole('developer')).toBe(false)
    expect(isAdminRole('finance')).toBe(false)
    expect(isAdminRole(null)).toBe(false)
  })
  it('org-wide roles are the cross-region pair', () => {
    expect([...ORG_WIDE_ROLES]).toEqual(['global-finops', 'platform-admin'])
    expect(isOrgWideRole('admin')).toBe(false)
    expect(isOrgWideRole('global-finops')).toBe(true)
  })
})

describe('roleLabel — canonical display names', () => {
  it('renders the disambiguated admin/finance labels', () => {
    expect(roleLabel('admin')).toBe('Region admin')
    expect(roleLabel('global-finops')).toBe('Global finance')
    // The zombie is labelled as retired, distinct from Global finance.
    expect(roleLabel('finance')).toBe('Finance (retired)')
  })
  it('covers every role in the enum', () => {
    for (const r of ROLES) {
      expect(ROLE_LABELS[r]).toBeTruthy()
      expect(roleLabel(r)).not.toBe(r) // never a raw code
    }
  })
  it('falls back gracefully', () => {
    expect(roleLabel(null)).toBe('—')
    expect(roleLabel('mystery')).toBe('mystery')
  })
})
