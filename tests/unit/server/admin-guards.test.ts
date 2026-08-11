// @vitest-environment node
/*
 * admin-guards — pure decision unit tests.
 *
 * Mirrors the pattern in tests/integration/auth/persona-override.test.ts
 * §"pure-gate decisions": the function is total + DB-free, so we can
 * exhaust the matrix of (caller, target, count, newRole) without booting
 * Nitro or a testcontainer.
 */
import { describe, it, expect, vi } from 'vitest'
import { evaluateRoleChange, evaluateRevokeSessions } from '../../../server/auth/admin-guards'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

// The network probe itself (real DNS/TCP) is exercised elsewhere — mocked
// here so this stays a fast, DB-free RBAC-boundary check, matching the rest
// of this file's philosophy.
vi.mock('../../../server/azure/network-check', () => ({
  runNetworkCheck: vi.fn().mockResolvedValue({
    generatedNote: 'x',
    vnetHint: 'x',
    summary: { total: 0, ok: 0, zoneNotLinked: 0, unreachable: 0, dnsFail: 0 },
    records: [],
    itReport: 'x',
  }),
}))

const CALLER_ADMIN = { role: 'admin' as const, teammateId: 'admin-1' }
const CALLER_FINOPS = { role: 'global-finops' as const, teammateId: 'finops-1' }
const TARGET = (id: string, role: 'admin' | 'developer' | 'manager' | 'finance' | 'global-finops' = 'developer') => ({ id, role })

describe('evaluateRoleChange — pure verdicts', () => {
  it('admin promoting a developer to manager → allowed', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'developer'), 'manager', 1)
    expect(v).toEqual({ allowed: true })
  })

  it('global-finops promoting a developer to admin → allowed (admin count goes to 2)', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'developer'), 'admin', 1)
    expect(v).toEqual({ allowed: true })
  })

  it('admin demoting another admin while 2 admins exist → allowed', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'admin'), 'developer', 2)
    expect(v).toEqual({ allowed: true })
  })

  it('admin demoting themselves → refused 400 self-demote-blocked', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'developer', 5)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('self-role-change-blocked')
    }
  })

  it('admin "demoting" themselves to admin (no-op) → refused 400 same-role-noop (self check only fires on a genuine role-change)', () => {
    // R1 F3: self-role-change predicate is `caller.id === target.id &&
    // caller.role !== newRole`. If newRole equals caller.role the
    // predicate is false and we fall through to same-role-noop.
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'admin', 5)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('same-role-noop')
    }
  })

  it('global-finops self-demote IS blocked (R1 F3 — both privileged roles get self-protection)', () => {
    // Earlier scope blocked only admin self-demote; that left global-
    // finops with the same lock-out vector. The brief was "Both checks
    // (Recommended)" — interpret strictly: any self-role-change by a
    // privileged caller is refused; a peer must perform it.
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('finops-1', 'global-finops'), 'developer', 1)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('self-role-change-blocked')
    }
  })

  it('admin self-promoting (admin → global-finops) is also blocked — same-id changes require a peer', () => {
    // R1 F3: self-promote is a privilege-escalation foot-gun. A peer
    // mutator should grant it, not the caller themselves.
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'global-finops', 3)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.reason).toBe('self-role-change-blocked')
    }
  })

  it('changing target to its current role → refused 400 same-role-noop', () => {
    const v = evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'manager'), 'manager', 2)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(400)
      expect(v.reason).toBe('same-role-noop')
    }
  })

  it('demoting the sole admin (different teammate) → refused 409 last-admin-protected', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'admin'), 'developer', 1)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(409)
      expect(v.reason).toBe('last-admin-protected')
    }
  })

  it('demoting the sole admin with adminCount=0 (corrupt state) → still refused 409', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'admin'), 'developer', 0)
    expect(v.allowed).toBe(false)
    if (!v.allowed) {
      expect(v.status).toBe(409)
    }
  })

  it('promoting a developer → admin when 0 admins exist → allowed (recovery path)', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'developer'), 'admin', 0)
    expect(v).toEqual({ allowed: true })
  })

  // Anchor: see Wave-VII brief Item A — auto-revoke is a CONSEQUENCE of
  // every allowed role change, not a separate verdict. The role-change
  // verdict matrix is unchanged; the handler appends the revocation
  // inside the same tx. These cases re-assert the unchanged shape so a
  // regression that erroneously starts blocking allowed mutations (e.g.
  // a future "don't revoke admins" rule) trips here.
  it('Wave-VII: an allowed role change verdict is unchanged (auto-revoke is a handler concern, not a verdict mode)', () => {
    const v = evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'developer'), 'manager', 3)
    expect(v).toEqual({ allowed: true })
  })

  it('verdict refusals always carry both status + reason (RFC-9457 envelope shape)', () => {
    const refusals = [
      evaluateRoleChange(CALLER_ADMIN, TARGET('admin-1', 'admin'), 'developer', 5),
      evaluateRoleChange(CALLER_ADMIN, TARGET('tm-2', 'manager'), 'manager', 2),
      evaluateRoleChange(CALLER_FINOPS, TARGET('tm-2', 'admin'), 'developer', 1),
    ]
    for (const v of refusals) {
      expect(v.allowed).toBe(false)
      if (!v.allowed) {
        expect(v.status).toBeGreaterThanOrEqual(400)
        expect(v.status).toBeLessThan(500)
        expect(typeof v.reason).toBe('string')
        expect(v.reason.length).toBeGreaterThan(0)
      }
    }
  })
})

// ── evaluateRevokeSessions (Wave VII) ─────────────────────────────────
//
// Pure decision for POST /api/v1/admin/users/:id/revoke-sessions. Per
// brief Item B: no last-admin-protection (revocation doesn't change
// role); self-revoke IS allowed; the function currently returns
// { allowed: true } unconditionally. The tests pin that surface so a
// future tightening (rate-limit, anti-griefing guard) lands here
// explicitly instead of silently widening the contract.
describe('evaluateRevokeSessions — pure verdicts (Wave VII)', () => {
  const TARGET_R = (id: string, regionId = 'region-a') => ({ id, regionId })

  it('admin revoking a peer in the same region → allowed', () => {
    const v = evaluateRevokeSessions(CALLER_ADMIN, TARGET_R('tm-2'))
    expect(v).toEqual({ allowed: true })
  })

  it('global-finops revoking any teammate → allowed', () => {
    const v = evaluateRevokeSessions(CALLER_FINOPS, TARGET_R('tm-2', 'region-b'))
    expect(v).toEqual({ allowed: true })
  })

  it('admin revoking the sole admin in their region → allowed (revocation does NOT change role)', () => {
    // R1-style anti-regression: the role-change "last-admin-protected"
    // gate must NOT bleed into revoke-sessions. The revoked user can
    // sign back in; the role column is untouched.
    const v = evaluateRevokeSessions(CALLER_ADMIN, TARGET_R('only-admin'))
    expect(v).toEqual({ allowed: true })
  })

  it('admin revoking themselves → allowed (legitimate "force sign-out from another device")', () => {
    const v = evaluateRevokeSessions(CALLER_ADMIN, TARGET_R('admin-1'))
    expect(v).toEqual({ allowed: true })
  })

  it('global-finops revoking themselves → allowed (mirror of admin self-revoke)', () => {
    const v = evaluateRevokeSessions(CALLER_FINOPS, TARGET_R('finops-1', 'region-a'))
    expect(v).toEqual({ allowed: true })
  })
})

// ── GET /api/v1/admin/diagnostics/network — tier matrix ────────────────────
//
// This route used to accept admin/global-finops; it now matches
// otel-logs.get.ts's platform-admin-only tier (it exposes the same class of
// infrastructure-topology detail: private IPs, internal host:port pairs).
// injectTestSession is DB-free (it pre-populates tryAuth's per-event cache
// directly — see tests/helpers/auth.ts), so this exercises the REAL
// requireRole gate without a testcontainer.
function fakeEvent(session: Session) {
  const event = { context: {} } as Parameters<typeof injectTestSession>[0]
  injectTestSession(event, session)
  return event
}

const REGION_ID = '00000000-0000-0000-0000-0000000000aa'
const platformAdminSession = (): Session =>
  ({ teammateId: 'pa-1', email: 'pa@x.test', displayName: 'PA', role: 'platform-admin', regionId: REGION_ID, orgPath: 'x' }) as Session
const adminSession = (): Session =>
  ({ teammateId: 'ad-1', email: 'ad@x.test', displayName: 'Admin', role: 'admin', regionId: REGION_ID, orgPath: 'x' }) as Session
const globalFinopsSession = (): Session =>
  ({ teammateId: 'gf-1', email: 'gf@x.test', displayName: 'GF', role: 'global-finops', regionId: REGION_ID, orgPath: 'x' }) as Session

describe('GET /api/v1/admin/diagnostics/network — tier matrix', () => {
  it('a region-scoped admin is REJECTED (403) — network topology is platform-admin only now', async () => {
    const handler = (await import('../../../server/api/v1/admin/diagnostics/network.get')).default
    await expect(handler(fakeEvent(adminSession()) as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('global-finops is ALSO rejected (403) — this tier is narrower than the rest of diagnostics', async () => {
    const handler = (await import('../../../server/api/v1/admin/diagnostics/network.get')).default
    await expect(handler(fakeEvent(globalFinopsSession()) as never)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('platform-admin is allowed (200-shaped response)', async () => {
    const handler = (await import('../../../server/api/v1/admin/diagnostics/network.get')).default
    const res = (await handler(fakeEvent(platformAdminSession()) as never)) as { records: unknown[] }
    expect(res.records).toEqual([])
  })
})
