/*
 * server/auth/key-strength.ts — the shared length + entropy floor.
 *
 * MEASURED (per the story): all 13 in-repo test secrets score 3.61-3.87
 * bits/byte and pass the default 3.5 floor; `changeme-changeme-changeme-1234!`
 * scores 3.48 and fails — zero test churn from adding the entropy arm.
 * This file pins that measurement plus the pure scorer's contract.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  shannonEntropyBitsPerByte,
  checkEnvKeyStrength,
  requireStrongEnvKey,
} from '../../../server/auth/key-strength'

const ENV_KEY = 'TEST_KEY_STRENGTH_PROBE'

afterEach(() => {
  Reflect.deleteProperty(process.env, ENV_KEY)
})

describe('shannonEntropyBitsPerByte', () => {
  it('is 0 for an empty string', () => {
    expect(shannonEntropyBitsPerByte('')).toBe(0)
  })

  it('is near-zero for a repeated character', () => {
    expect(shannonEntropyBitsPerByte('a'.repeat(32))).toBeCloseTo(0, 5)
  })

  it('scores random base64 output well above the 3.5 floor', () => {
    // A real `openssl rand -base64 48`-shaped value.
    const random = 'xK9mQ2vN8pL4wR7tY1zA5bC3dE6fG0hJiUoPsXcVnBmLkJhGfDsA=='
    expect(shannonEntropyBitsPerByte(random)).toBeGreaterThan(3.5)
  })

  it('scores a trivially-weak passphrase below the floor', () => {
    expect(shannonEntropyBitsPerByte('changeme-changeme-changeme-1234!')).toBeLessThan(3.5)
  })
})

describe('checkEnvKeyStrength — never throws', () => {
  it('fails with reason missing-or-short when unset', () => {
    Reflect.deleteProperty(process.env, ENV_KEY)
    const result = checkEnvKeyStrength(ENV_KEY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing-or-short')
  })

  it('fails with reason missing-or-short when set but under minLength', () => {
    process.env[ENV_KEY] = 'a'.repeat(10)
    const result = checkEnvKeyStrength(ENV_KEY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('missing-or-short')
  })

  it('fails with reason low-entropy when long enough but low-entropy ("a".repeat(32) — the length check alone would pass this)', () => {
    process.env[ENV_KEY] = 'a'.repeat(32)
    const result = checkEnvKeyStrength(ENV_KEY)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('low-entropy')
  })

  it('passes a strong random key', () => {
    process.env[ENV_KEY] = 'xK9mQ2vN8pL4wR7tY1zA5bC3dE6fG0hJiUoPsXcVnBmLkJhGfDsA=='
    const result = checkEnvKeyStrength(ENV_KEY)
    expect(result.ok).toBe(true)
  })

  it('respects custom floors (minLength, minEntropy)', () => {
    process.env[ENV_KEY] = 'short-but-random-ish!'
    expect(checkEnvKeyStrength(ENV_KEY, { minLength: 100 }).ok).toBe(false)
    expect(checkEnvKeyStrength(ENV_KEY, { minLength: 8, minEntropy: 0 }).ok).toBe(true)
  })

  it('message includes the "Generate via" hint on every failure mode', () => {
    Reflect.deleteProperty(process.env, ENV_KEY)
    expect(checkEnvKeyStrength(ENV_KEY).message).toContain('openssl rand -base64 48')
    process.env[ENV_KEY] = 'a'.repeat(32)
    expect(checkEnvKeyStrength(ENV_KEY).message).toContain('openssl rand -base64 48')
  })
})

describe('requireStrongEnvKey — throws on failure, returns the raw value on success', () => {
  it('throws when missing', () => {
    Reflect.deleteProperty(process.env, ENV_KEY)
    expect(() => requireStrongEnvKey(ENV_KEY)).toThrow(/missing or too short/)
  })

  it('throws when too short', () => {
    process.env[ENV_KEY] = 'short'
    expect(() => requireStrongEnvKey(ENV_KEY)).toThrow(/missing or too short/)
  })

  it('throws when low-entropy', () => {
    process.env[ENV_KEY] = 'a'.repeat(32)
    expect(() => requireStrongEnvKey(ENV_KEY)).toThrow(/insufficient entropy/)
  })

  it('returns the raw value on success', () => {
    const strong = 'xK9mQ2vN8pL4wR7tY1zA5bC3dE6fG0hJiUoPsXcVnBmLkJhGfDsA=='
    process.env[ENV_KEY] = strong
    expect(requireStrongEnvKey(ENV_KEY)).toBe(strong)
  })
})
