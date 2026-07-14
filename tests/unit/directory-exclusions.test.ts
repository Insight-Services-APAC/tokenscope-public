/*
 * directory-exclusions matcher — the pure policy logic (no DB). Locks in the
 * two load-bearing safety properties: FAIL-OPEN (empty patterns / null upn
 * match nothing → the cleanup worker deactivates nothing) and the MATCH-ALL
 * FOOTGUN guard (a one-char pattern can't empty every picker).
 */
import { describe, it, expect } from 'vitest'
import {
  isExcludedUpn,
  upnGlobToRegExp,
  upnGlobToSqlLike,
  validateExclusionPattern,
} from '../../server/utils/directory-exclusions'

describe('isExcludedUpn', () => {
  it('FAIL-OPEN: empty pattern list matches nothing', () => {
    expect(isExcludedUpn('rtanaka-cld@contoso.onmicrosoft.com', [])).toBe(false)
  })

  it('FAIL-OPEN: null / blank upn matches nothing', () => {
    expect(isExcludedUpn(null, ['*@*.onmicrosoft.com'])).toBe(false)
    expect(isExcludedUpn('', ['*@*.onmicrosoft.com'])).toBe(false)
  })

  it('matches a privileged onmicrosoft account against a tenant pattern', () => {
    expect(isExcludedUpn('rtanaka-cld@contoso.onmicrosoft.com', ['*@contoso.onmicrosoft.com'])).toBe(true)
  })

  it('does NOT match a standard vanity-domain account', () => {
    expect(isExcludedUpn('rob.oconnor3@example.com', ['*@contoso.onmicrosoft.com'])).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isExcludedUpn('RTanaka-CLD@contoso.onmicrosoft.com', ['*@contoso.onmicrosoft.com'])).toBe(true)
  })

  it('matches on ANY pattern in the list', () => {
    const patterns = ['*-cld@*', 'svc-*@*.example.com']
    expect(isExcludedUpn('roconno3-cld@example.com', patterns)).toBe(true)
    expect(isExcludedUpn('svc-billing@app.example.com', patterns)).toBe(true)
    expect(isExcludedUpn('normal.user@example.com', patterns)).toBe(false)
  })
})

describe('upnGlobToRegExp escaping', () => {
  it('treats dots as literal (does not over-match)', () => {
    const re = upnGlobToRegExp('*@*.onmicrosoft.com')
    expect(re.test('x@a.onmicrosoft.com')).toBe(true)
    expect(re.test('x@aXonmicrosoftYcom')).toBe(false) // dots are literal
  })

  it('anchors — a pattern matches the WHOLE upn', () => {
    const re = upnGlobToRegExp('admin@corp.com')
    expect(re.test('admin@corp.com')).toBe(true)
    expect(re.test('admin@corp.com.evil.test')).toBe(false)
    expect(re.test('x.admin@corp.com')).toBe(false)
  })
})

describe('upnGlobToSqlLike (DB-side match count)', () => {
  it('translates * → % and escapes LIKE metacharacters in literals', () => {
    expect(upnGlobToSqlLike('*@contoso.onmicrosoft.com')).toBe('%@contoso.onmicrosoft.com')
    expect(upnGlobToSqlLike('svc_*@app.example.com')).toBe('svc\\_%@app.example.com') // _ escaped
    expect(upnGlobToSqlLike('a*b*c@x.io')).toBe('a%b%c@x.io')
  })
})

describe('validateExclusionPattern — match-all footgun guard', () => {
  it('rejects the catastrophic match-all patterns', () => {
    for (const p of ['', '   ', '*', '**', '***', '*@*', '*@*.*']) {
      expect(validateExclusionPattern(p), `pattern ${JSON.stringify(p)}`).not.toBeNull()
    }
  })

  it('rejects a domain with no literal label', () => {
    expect(validateExclusionPattern('*@*.com')).not.toBeNull() // no real domain label
  })

  it('rejects overly long patterns', () => {
    expect(validateExclusionPattern('a'.repeat(201) + '@x.com')).not.toBeNull()
  })

  it('accepts realistic org patterns', () => {
    for (const p of ['*@contoso.onmicrosoft.com', '*-cld@example.com', 'svc-*@app.example.com', 'admin@corp.io']) {
      expect(validateExclusionPattern(p), `pattern ${JSON.stringify(p)}`).toBeNull()
    }
  })
})
