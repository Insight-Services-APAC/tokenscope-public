/*
 * sanitizeCallbackRedirectUrl — the anonymous post-authentication open
 * redirect (server-edge-auth:mitm:0001/0002/0004).
 *
 * nuxt-oidc-auth 1.0.0-beta.11 pattern-matched instead of parsing: it
 * rejected a leading `//` but ACCEPTED `/\evil`, which WHATWG URL
 * normalisation turns into a cross-origin URL in a real browser (`\` is
 * treated as `/` for special schemes during parsing). We carried a local
 * patch for that, plus the `session.data.callbackRedirectUrl` read that had
 * to move BEFORE `session.clear()` to revive this path at all.
 *
 * Both fixes are UPSTREAM as of 1.0.0-beta.12, so the patch is gone
 * (dropped in the dep catch-up). Upstream closes the hole by denylisting
 * `\`, TAB, LF and CR rather than by parsing, which passes every case
 * below — that equivalence is exactly what this file exists to keep proving.
 *
 * This test imports the INSTALLED module via the same deep-import style as
 * server/utils/auth.ts:36 — deliberately, so a future version that weakens
 * the sanitiser fails THIS test, not just a manual code read.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeCallbackRedirectUrl } from 'nuxt-oidc-auth/runtime/server/utils/redirect.js'

describe('sanitizeCallbackRedirectUrl (patched: parses, does not pattern-match)', () => {
  it.each([
    ['/app', '/app'],
    ['/app?x=1#f', '/app?x=1#f'],
    // The MCP login-resume shape (authorize.get.ts:78) — query string MUST
    // survive verbatim or the consent-resume dead-ends with no error.
    [
      '/api/v1/oauth/authorize?client_id=x&state=y',
      '/api/v1/oauth/authorize?client_id=x&state=y',
    ],
  ])('preserves a same-origin path verbatim: %s', (input, expected) => {
    expect(sanitizeCallbackRedirectUrl(input)).toBe(expected)
  })

  it.each([
    ['//evil', 'protocol-relative — already rejected pre-patch'],
    ['/\\evil', 'THE defect: backslash normalises to `/` for special schemes'],
    ['/\\/evil', 'backslash + slash — same normalisation'],
    ['\\\\evil', 'double-backslash, no leading slash at all'],
    ['https://evil.example', 'fully-qualified absolute URL'],
  ])('rejects a cross-origin redirect vector: %s (%s)', (input) => {
    expect(sanitizeCallbackRedirectUrl(input)).toBeUndefined()
  })

  it('rejects control-character variants that browsers may still normalise', () => {
    const TAB = String.fromCharCode(9)
    const NEWLINE = String.fromCharCode(10)
    expect(sanitizeCallbackRedirectUrl(`/${TAB}\\evil`)).toBeUndefined()
    expect(sanitizeCallbackRedirectUrl(`/${NEWLINE}\\evil`)).toBeUndefined()
  })

  it('rejects non-string input', () => {
    expect(sanitizeCallbackRedirectUrl(123 as unknown as string)).toBeUndefined()
    expect(sanitizeCallbackRedirectUrl(undefined as unknown as string)).toBeUndefined()
    expect(sanitizeCallbackRedirectUrl(null as unknown as string)).toBeUndefined()
  })
})
