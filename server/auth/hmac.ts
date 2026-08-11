/*
 * HMAC-SHA-256 — secret hashing for at-rest credential material.
 *
 * `hashSessionToken` is the single HMAC primitive used across the OAuth +
 * emit-handoff surface (oauth refresh/access tokens, the emit-handoff code,
 * the internal emit client secret). Despite the historical name, it no longer
 * hashes a "session token" — the legacy 12h session token and its minter
 * (mintSessionToken) were removed in the OAuth/MCP cutover.
 *
 * Per data-model.md Q-DM-1: secrets are HMAC'd with a Key-Vault-stored service
 * key, NOT raw SHA-256. Stolen-DB attacks can't brute-force the hash without the
 * key; rotating the key invalidates every hashed secret in one shot.
 *
 * Local dev: key in NUXT_HMAC_SESSION_KEY env var (32+ chars).
 * Sandbox / prod (Epic 10): pulled at boot from Azure Key Vault and
 * cached in memory.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { requireStrongEnvKey } from './key-strength'

let cachedKey: Buffer | null = null

export function getHmacKey(): Buffer {
  if (cachedKey) return cachedKey
  // Length + entropy floor (>= 32 chars, >= 3.5 bits/byte) — see
  // server/auth/key-strength.ts for the rationale and the shared
  // implementation (this used to be a verbatim-duplicated local copy).
  const raw = requireStrongEnvKey('NUXT_HMAC_SESSION_KEY')
  cachedKey = Buffer.from(raw, 'utf8')
  return cachedKey
}

export function resetHmacKeyForTests(): void {
  cachedKey = null
}

export function hashSessionToken(token: string): string {
  return createHmac('sha256', getHmacKey()).update(token).digest('hex')
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}
