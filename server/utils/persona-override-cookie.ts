/*
 * server/utils/persona-override-cookie.ts — sandbox-only sidecar
 * cookie carrying the persona-override state.
 *
 * Set by /api/v1/auth/dev-login (admin clicks "Switch to Lena Park").
 * Read by tryAuth() when NUXT_ALLOW_PERSONA_OVERRIDE=true. Cleared
 * by /api/v1/auth/stop-impersonating and /api/v1/auth/logout.
 *
 * Production binary never reads this cookie — the env-flag check in
 * tryAuth short-circuits before reaching readPersonaOverrideCookie.
 *
 * Why a separate cookie (not ts_session): see
 * docs/design/auth-session-cookie-architecture.md. The override is
 * a sandbox feature that should be isolated behind a flag, not
 * bundled into the primary identity cookie.
 *
 * Wire format: base64url(JSON.stringify(payload)) + '.' + hex(HMAC-SHA-256(payload))
 * Same shape as the legacy ts_session cookie — easy to migrate, and
 * the existing NUXT_SESSION_SECRET is reused.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { deleteCookie, getCookie, setCookie, type H3Event } from 'h3'

export const PERSONA_OVERRIDE_COOKIE_NAME = 'ts_persona_override'

export interface PersonaOverridePayload {
  /** teammate.id of the persona being acted as. */
  targetTeammateId: string
  /** ISO timestamp when the override was minted (used for revocation). */
  issuedAt: string
  /** Real admin's Entra OID — empty/absent in pure dev-mode. */
  impersonatorOid?: string
  /** Real admin's email — shown in the header as "Acting as …". */
  impersonatorEmail?: string
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  // secure=true on every deployed environment (HTTPS). Disabled only
  // in local dev where the worker speaks HTTP. The NODE_ENV check
  // here mirrors the OIDC module's own cookie defaults.
  secure: process.env.NODE_ENV === 'production',
}

function getSecret(): string {
  const secret = process.env.NUXT_SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('NUXT_SESSION_SECRET is missing or too short (need >= 32 chars)')
  }
  return secret
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

function verify(payload: string, signature: string, secret: string): boolean {
  const expected = sign(payload, secret)
  try {
    const a = Buffer.from(signature, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function encode(payload: PersonaOverridePayload): string {
  const secret = getSecret()
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${sign(body, secret)}`
}

function decode(raw: string): PersonaOverridePayload | null {
  const secret = getSecret()
  const dot = raw.indexOf('.')
  if (dot < 1 || dot === raw.length - 1) return null
  const body = raw.slice(0, dot)
  const signature = raw.slice(dot + 1)
  if (!verify(body, signature, secret)) return null
  try {
    const json = Buffer.from(body, 'base64url').toString('utf8')
    return JSON.parse(json) as PersonaOverridePayload
  } catch {
    return null
  }
}

export function setPersonaOverrideCookie(
  event: H3Event,
  payload: PersonaOverridePayload,
): void {
  setCookie(event, PERSONA_OVERRIDE_COOKIE_NAME, encode(payload), COOKIE_OPTIONS)
}

export function readPersonaOverrideCookie(event: H3Event): PersonaOverridePayload | null {
  const raw = getCookie(event, PERSONA_OVERRIDE_COOKIE_NAME)
  if (!raw) return null
  return decode(raw)
}

export function clearPersonaOverrideCookie(event: H3Event): void {
  deleteCookie(event, PERSONA_OVERRIDE_COOKIE_NAME, { path: '/' })
}
