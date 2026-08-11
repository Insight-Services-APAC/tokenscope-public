/*
 * settings-redirect — the retired /admin/settings junk drawer's redirect map.
 * Guards that old fragment deep-links resolve to their new policy pages and
 * unknown/empty anchors fall back to System info, so bookmarks/doc links can't
 * silently 404.
 */
import { describe, it, expect } from 'vitest'
import {
  settingsRedirectFor,
  SETTINGS_ANCHOR_REDIRECTS,
  SETTINGS_DEFAULT_REDIRECT,
} from '../../../shared/nav/settings-redirect'

describe('settingsRedirectFor', () => {
  it('maps each known anchor to a Policies page', () => {
    expect(settingsRedirectFor('#report-visibility')).toBe('/admin/policies/report-access')
    expect(settingsRedirectFor('#governance')).toBe('/admin/policies/detection-thresholds')
    expect(settingsRedirectFor('#detection-thresholds')).toBe('/admin/policies/detection-thresholds')
    expect(settingsRedirectFor('#lifecycle')).toBe('/admin/policies/project-lifecycle')
    expect(settingsRedirectFor('#directory-exclusions')).toBe('/admin/policies/directory-exclusions')
  })

  it('is case-insensitive and tolerates a missing #', () => {
    expect(settingsRedirectFor('Report-Visibility')).toBe('/admin/policies/report-access')
    expect(settingsRedirectFor('#DIRECTORY')).toBe('/admin/policies/directory-exclusions')
  })

  it('falls back to System info for unknown / empty / nullish anchors', () => {
    expect(settingsRedirectFor('#nope')).toBe(SETTINGS_DEFAULT_REDIRECT)
    expect(settingsRedirectFor('')).toBe(SETTINGS_DEFAULT_REDIRECT)
    expect(settingsRedirectFor(null)).toBe(SETTINGS_DEFAULT_REDIRECT)
    expect(settingsRedirectFor(undefined)).toBe(SETTINGS_DEFAULT_REDIRECT)
    expect(SETTINGS_DEFAULT_REDIRECT).toBe('/admin/system')
  })

  it('every mapped destination is a real /admin route shape', () => {
    for (const dest of Object.values(SETTINGS_ANCHOR_REDIRECTS)) {
      expect(dest).toMatch(/^\/admin\/(policies|system)/)
    }
  })
})
