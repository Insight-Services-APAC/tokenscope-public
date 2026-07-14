/*
 * Test helper — inject a resolved Session into an h3 event's context
 * so tryAuth() returns it without going through OIDC + DB.
 *
 * Why: tryAuth's per-event cache (event.context['__tokenscope_session'])
 * is the first thing checked. Pre-populating it lets tests provide an
 * authenticated caller without spinning up nuxt-oidc-auth, decrypting
 * cookies, or hitting the teammate / org_unit tables.
 *
 * Mirrors the previous `setSession(event, session)` ergonomics from the
 * deleted server/auth/session.ts (the test bodies that called that
 * helper switch one-for-one to injectTestSession).
 */
import type { H3Event } from 'h3'
import type { Session } from '../../server/utils/auth'

export function injectTestSession(event: H3Event, session: Session): void {
  event.context = (event.context ?? {}) as H3Event['context']
  event.context['__tokenscope_session'] = session
}
