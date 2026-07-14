/*
 * HMAC hashing round-trip + key behaviour.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 4 EVS: "HMAC-SHA-256 round-trip verified".
 * mintSessionToken was removed in the OAuth/MCP cutover (the legacy 12h session
 * token is gone) — hashSessionToken is now the single HMAC primitive, so these
 * tests hash raw token strings directly.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { hashSessionToken, resetHmacKeyForTests } from '../../../server/auth/hmac'

const STRONG_KEY = 'test-hmac-key-padded-to-thirty-two-chars-or-more'

/** A random base64url token string, mirroring the kind of secret we hash. */
function token(): string {
  return randomBytes(32).toString('base64url')
}

beforeAll(() => {
  process.env.NUXT_HMAC_SESSION_KEY = STRONG_KEY
  resetHmacKeyForTests()
})

describe('hashSessionToken', () => {
  it('produces a 64-hex digest and reproduces it for the same token', () => {
    const t = token()
    const hash = hashSessionToken(t)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSessionToken(t)).toBe(hash)
  })

  it('different tokens hash to different values', () => {
    expect(hashSessionToken(token())).not.toBe(hashSessionToken(token()))
  })

  it('the same token always hashes to the same value (with the same key)', () => {
    const t = token()
    const hash = hashSessionToken(t)
    for (let i = 0; i < 5; i++) {
      expect(hashSessionToken(t)).toBe(hash)
    }
  })

  it('changing the key changes the hash for the same token', () => {
    const t = token()
    const hash = hashSessionToken(t)
    process.env.NUXT_HMAC_SESSION_KEY = 'rotated-key-padded-to-thirty-two-chars-or-more'
    resetHmacKeyForTests()
    expect(hashSessionToken(t)).not.toBe(hash)
    // Restore for other tests in this file.
    process.env.NUXT_HMAC_SESSION_KEY = STRONG_KEY
    resetHmacKeyForTests()
  })

  it('rejects a too-short key', () => {
    process.env.NUXT_HMAC_SESSION_KEY = 'tooshort'
    resetHmacKeyForTests()
    expect(() => hashSessionToken('any')).toThrow(/too short/)
    process.env.NUXT_HMAC_SESSION_KEY = STRONG_KEY
    resetHmacKeyForTests()
  })

  it('rejects a long-but-low-entropy key (32-char repeated string)', () => {
    process.env.NUXT_HMAC_SESSION_KEY = 'a'.repeat(32)
    resetHmacKeyForTests()
    expect(() => hashSessionToken('any')).toThrow(/insufficient entropy/)
    process.env.NUXT_HMAC_SESSION_KEY = STRONG_KEY
    resetHmacKeyForTests()
  })

  it('rejects copy-paste-weak keys like changeme-changeme', () => {
    process.env.NUXT_HMAC_SESSION_KEY = 'changeme-changeme-changeme-changeme'
    resetHmacKeyForTests()
    expect(() => hashSessionToken('any')).toThrow(/insufficient entropy/)
    process.env.NUXT_HMAC_SESSION_KEY = STRONG_KEY
    resetHmacKeyForTests()
  })
})
