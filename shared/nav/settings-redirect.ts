/*
 * Redirect map for the retired /admin/settings junk-drawer page. The page was
 * split into /admin/system (read-only config) + /admin/policies/* (each
 * editable surface). Old bookmarks / doc links — including fragment deep-links
 * like /admin/settings#report-visibility — must still land somewhere useful.
 *
 * Pure + unit-tested so the mapping can't silently rot. The /admin/settings
 * page is a thin client redirect that calls settingsRedirectFor(location.hash).
 */

/** Old settings anchor (fragment, sans '#') → new destination route. */
export const SETTINGS_ANCHOR_REDIRECTS: Record<string, string> = {
  'report-visibility': '/admin/policies/report-visibility',
  reporting: '/admin/policies/report-visibility',
  governance: '/admin/policies/detection-thresholds',
  'governance-dials': '/admin/policies/detection-thresholds',
  detection: '/admin/policies/detection-thresholds',
  'detection-thresholds': '/admin/policies/detection-thresholds',
  lifecycle: '/admin/policies/project-lifecycle',
  'project-lifecycle': '/admin/policies/project-lifecycle',
  directory: '/admin/policies/directory-exclusions',
  'directory-exclusions': '/admin/policies/directory-exclusions',
}

/** Where /admin/system landing sends a bare /admin/settings (no useful anchor). */
export const SETTINGS_DEFAULT_REDIRECT = '/admin/system'

/**
 * Resolve an old /admin/settings hash to its new route. Unknown/empty anchors
 * fall back to the System info page (which links the Policies pages).
 */
export function settingsRedirectFor(hash: string | null | undefined): string {
  const key = (hash ?? '').replace(/^#/, '').trim().toLowerCase()
  return SETTINGS_ANCHOR_REDIRECTS[key] ?? SETTINGS_DEFAULT_REDIRECT
}
