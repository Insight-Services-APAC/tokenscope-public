/*
 * safeReturnPath: which `?next=` values the sign-in page will send someone
 * back to (#541). Same-site paths only; every refused shape lands on Home.
 * The server half of the same rule (the OIDC module's own sanitiser, which
 * receives the value as callbackRedirectUrl) is pinned in
 * tests/unit/server/oidc-callback-redirect.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { entraLoginHref, isPageToReturnTo, safeReturnPath, withBrowserHash } from '../../../app/utils/return-path'

describe('safeReturnPath', () => {
  it.each([
    ['/inbox', '/inbox'],
    ['/projects/9a1e0000-0000-4000-8000-000000000001', '/projects/9a1e0000-0000-4000-8000-000000000001'],
    ['/inbox?status=open&item=42', '/inbox?status=open&item=42'],
    ['/usage#daily', '/usage#daily'],
    ['/reporting/region?month=2026-10', '/reporting/region?month=2026-10'],
    ['/', '/'],
  ])('keeps a same-site path: %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected)
  })

  it.each([
    ['https://evil.example/inbox', 'absolute URL'],
    ['http://evil.example', 'absolute URL, http'],
    ['//evil.example/inbox', 'protocol-relative'],
    ['/\\evil.example', 'backslash, which browsers read as //'],
    ['/\\/evil.example', 'backslash then slash'],
    ['\\\\evil.example', 'double backslash'],
    ['javascript:alert(1)', 'script URL'],
    ['inbox', 'relative, no leading slash'],
    [`/${String.fromCharCode(9)}/evil.example`, 'tab inside'],
    [`/${String.fromCharCode(10)}/evil.example`, 'newline inside'],
    ['/login', 'sign-in itself (a loop)'],
    ['/login?next=/inbox', 'sign-in itself with its own next'],
    ['/auth/entra/login', 'the sign-in handler (a loop)'],
    ['/x/..//evil.example', 'normalises to //evil.example'],
    ['/x/../\\evil.example', 'normalises through a backslash'],
    ['', 'empty'],
  ])('refuses %s (%s)', (input) => {
    expect(safeReturnPath(input)).toBeNull()
  })

  it('refuses anything that is not a string', () => {
    expect(safeReturnPath(undefined)).toBeNull()
    expect(safeReturnPath(null)).toBeNull()
    expect(safeReturnPath(['/inbox'])).toBeNull()
    expect(safeReturnPath(42)).toBeNull()
  })
})

describe('entraLoginHref', () => {
  it('carries a return path as the module callbackRedirectUrl', () => {
    expect(entraLoginHref('/inbox?status=open')).toBe(
      '/auth/entra/login?callbackRedirectUrl=%2Finbox%3Fstatus%3Dopen',
    )
  })

  it('is the plain sign-in link with nothing to return to, or Home', () => {
    expect(entraLoginHref(null)).toBe('/auth/entra/login')
    expect(entraLoginHref('/')).toBe('/auth/entra/login')
  })

  it('carries a fragment, encoded, so the callback lands on it', () => {
    expect(entraLoginHref('/projects/ABC#manage')).toBe(
      '/auth/entra/login?callbackRedirectUrl=%2Fprojects%2FABC%23manage',
    )
  })

  it('never carries a refused next value', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      expect(entraLoginHref(safeReturnPath(bad))).toBe('/auth/entra/login')
    }
  })
})

describe('isPageToReturnTo', () => {
  it('is true for a page, false for Home or nothing', () => {
    expect(isPageToReturnTo('/inbox')).toBe(true)
    expect(isPageToReturnTo('/')).toBe(false)
    expect(isPageToReturnTo(null)).toBe(false)
  })
})

describe('withBrowserHash', () => {
  it('adds the fragment the browser kept across the redirect', () => {
    // The inbox's budget request link (DrawerBodyBudgetRequest.vue).
    expect(withBrowserHash('/projects/ABC', '#manage')).toBe('/projects/ABC#manage')
  })

  it('keeps a fragment next already carries', () => {
    expect(withBrowserHash('/usage#daily', '#manage')).toBe('/usage#daily')
  })

  it.each([[''], ['#'], ['#a b'], ['#x/../..//evil'], [`#${'a'.repeat(65)}`]])(
    'ignores a fragment that is not a plain anchor: %s',
    (hash) => {
      expect(withBrowserHash('/projects/ABC', hash)).toBe('/projects/ABC')
    },
  )

  it('has nothing to add to when next was refused', () => {
    expect(withBrowserHash(null, '#manage')).toBeNull()
  })
})
