/*
 * HMAC verification for internal machine-to-machine endpoints
 * (worker scheduler trigger). Separate from the session HMAC so
 * compromising one key does not surrender the other.
 *
 * Request shape:
 *   X-Internal-Signature: hex(HMAC-SHA-256(key, `${timestamp}\n${method}\n${path}\n${bodySha256Hex}`))
 *   X-Internal-Timestamp: unix seconds (string)
 *
 * Verification rules:
 *   1. Timestamp within +/- 300 seconds of server clock (replay window)
 *   2. Signature constant-time-equal to expected
 *
 * Key source:
 *   - Dev: NUXT_INTERNAL_WORKER_HMAC_KEY env var (>= 32 chars, >= 3.5 bits/byte entropy)
 *   - Prod (post-Epic 10): Azure Key Vault, cached at boot
 *
 * Why a separate key from the session HMAC: blast-radius separation.
 * The session HMAC protects user tokens; this key protects worker
 * triggers. A leaked worker key cannot replay user sessions, and
 * vice-versa.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { createError, getHeader, readRawBody } from 'h3'

const REPLAY_WINDOW_SECONDS = 300
const KEY_MIN_LENGTH = 32
const KEY_MIN_ENTROPY = 3.5

let cachedKey: Buffer | null = null

export function getInternalHmacKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.NUXT_INTERNAL_WORKER_HMAC_KEY
  if (!raw || raw.length < KEY_MIN_LENGTH) {
    throw new Error(
      `NUXT_INTERNAL_WORKER_HMAC_KEY is missing or too short (need >= ${KEY_MIN_LENGTH} chars). ` +
        'Generate via: openssl rand -base64 48',
    )
  }
  const entropy = shannonEntropyBitsPerByte(raw)
  if (entropy < KEY_MIN_ENTROPY) {
    throw new Error(
      `NUXT_INTERNAL_WORKER_HMAC_KEY has insufficient entropy (${entropy.toFixed(2)} bits/byte; need >= ${KEY_MIN_ENTROPY}). ` +
        'Generate via: openssl rand -base64 48',
    )
  }
  cachedKey = Buffer.from(raw, 'utf8')
  return cachedKey
}

export function resetInternalHmacKeyForTests(): void {
  cachedKey = null
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

export function signInternalRequest(opts: {
  timestamp: number
  method: string
  path: string
  body: string
  key?: Buffer
}): string {
  const bodySha = createHash('sha256').update(opts.body).digest('hex')
  const payload = `${opts.timestamp}\n${opts.method.toUpperCase()}\n${opts.path}\n${bodySha}`
  return createHmac('sha256', opts.key ?? getInternalHmacKey()).update(payload).digest('hex')
}

export async function verifyInternalRequest(event: H3Event): Promise<void> {
  /*
   * Uniform 401 surface. An attacker probing the endpoint should not
   * be able to distinguish "I sent no headers" from "I sent wrong
   * headers" from "my timestamp is stale" — each branch gives the same
   * surface. Internal diagnostics (header presence, timestamp validity)
   * are server-side only.
   */
  const sigHeader = getHeader(event, 'x-internal-signature')
  const tsHeader = getHeader(event, 'x-internal-timestamp')
  if (!sigHeader || !tsHeader) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const ts = Number.parseInt(tsHeader, 10)
  if (!Number.isFinite(ts)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const rawBody = await readRawBody(event)
  const body =
    rawBody === undefined
      ? ''
      : typeof rawBody === 'string'
        ? rawBody
        : Buffer.from(rawBody as unknown as ArrayBufferLike).toString('utf8')
  const method = event.node.req.method ?? 'POST'
  const path = event.node.req.url ?? ''
  const expected = signInternalRequest({ timestamp: ts, method, path, body })
  if (sigHeader.length !== expected.length) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  let ok = false
  try {
    ok = timingSafeEqual(Buffer.from(sigHeader, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    ok = false
  }
  if (!ok) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}
