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

let cachedKey: Buffer | null = null

export function getHmacKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.NUXT_HMAC_SESSION_KEY
  if (!raw || raw.length < 32) {
    throw new Error(
      'NUXT_HMAC_SESSION_KEY is missing or too short (need >= 32 chars). ' +
        'Generate via: openssl rand -base64 48',
    )
  }
  // Entropy floor — Shannon entropy across the raw bytes. A 32-char
  // repeated string (e.g. 'a'*32) has near-zero entropy and would pass
  // the length check. Require >= 3.5 bits per byte: random base64
  // output hits ~5.85 bits (well clear); diceware-style passphrases hit
  // ~3.6-4.0; trivially-weak keys (`changeme-changeme-changeme-1234`)
  // fall below 1.0 bit/byte and are rejected.
  const entropy = shannonEntropyBitsPerByte(raw)
  if (entropy < 3.5) {
    throw new Error(
      `NUXT_HMAC_SESSION_KEY has insufficient entropy (${entropy.toFixed(2)} bits/byte; need >= 3.5). ` +
        'Generate via: openssl rand -base64 48',
    )
  }
  cachedKey = Buffer.from(raw, 'utf8')
  return cachedKey
}

function shannonEntropyBitsPerByte(s: string): number {
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
