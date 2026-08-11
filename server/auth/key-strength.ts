/*
 * server/auth/key-strength.ts — the shared length + entropy floor for
 * environment-sourced secret keys.
 *
 * Extracted from server/auth/hmac.ts + server/auth/internal-request.ts,
 * which each had a VERBATIM copy of `shannonEntropyBitsPerByte` (the
 * project's recurring failure mode: a correct check written twice instead
 * of shared once). Both call sites are behaviour-preserving after the
 * move — same thresholds (>= 32 chars, >= 3.5 bits/byte), same message
 * shape, same "Generate via: openssl rand -base64 48" hint.
 *
 * Why entropy, not just length: a 32-char repeated string (e.g. 'a'*32)
 * has near-zero entropy and would pass a length-only check. Random
 * base64 output hits ~5.85 bits/byte (well clear of the 3.5 floor);
 * diceware-style passphrases hit ~3.6-4.0; trivially-weak keys
 * (`changeme-changeme-changeme-1234`) fall below 1.0 bit/byte and are
 * rejected.
 *
 * `checkEnvKeyStrength` is the single source of truth: it never throws,
 * so both `requireStrongEnvKey` (the throwing wrapper the crypto-key call
 * sites use) and the warn-only boot plugin (server/plugins/secret-strength.ts)
 * build on the exact same scoring logic.
 */

export interface KeyStrengthFloors {
  minLength?: number
  minEntropy?: number
}

export type KeyStrengthFailureReason = 'missing-or-short' | 'low-entropy'

export interface KeyStrengthResult {
  ok: boolean
  reason?: KeyStrengthFailureReason
  message?: string
  entropy?: number
}

const DEFAULT_MIN_LENGTH = 32
const DEFAULT_MIN_ENTROPY = 3.5

/** Shannon entropy in bits/byte across the raw characters of `s`. */
export function shannonEntropyBitsPerByte(s: string): number {
  if (s.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of counts.values()) {
    const p = c / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/**
 * Pure length + entropy check against `process.env[name]` — NEVER throws.
 * Callers decide what "not ok" means: throw (requireStrongEnvKey) or warn
 * (server/plugins/secret-strength.ts).
 */
export function checkEnvKeyStrength(
  name: string,
  { minLength = DEFAULT_MIN_LENGTH, minEntropy = DEFAULT_MIN_ENTROPY }: KeyStrengthFloors = {},
): KeyStrengthResult {
  const raw = process.env[name]
  if (!raw || raw.length < minLength) {
    return {
      ok: false,
      reason: 'missing-or-short',
      message: `${name} is missing or too short (need >= ${minLength} chars). Generate via: openssl rand -base64 48`,
    }
  }
  const entropy = shannonEntropyBitsPerByte(raw)
  if (entropy < minEntropy) {
    return {
      ok: false,
      reason: 'low-entropy',
      entropy,
      message: `${name} has insufficient entropy (${entropy.toFixed(2)} bits/byte; need >= ${minEntropy}). Generate via: openssl rand -base64 48`,
    }
  }
  return { ok: true, entropy }
}

/**
 * Throwing wrapper for call sites that must REFUSE to operate on a weak
 * key (the session + internal-worker HMAC keys). Returns the raw env
 * value on success.
 */
export function requireStrongEnvKey(name: string, floors: KeyStrengthFloors = {}): string {
  const result = checkEnvKeyStrength(name, floors)
  if (!result.ok) {
    throw new Error(result.message)
  }
  // result.ok === true implies checkEnvKeyStrength found process.env[name]
  // truthy and >= minLength — safe to assert non-null here.
  return process.env[name] as string
}
