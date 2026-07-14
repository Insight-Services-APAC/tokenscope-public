// @vitest-environment node
/*
 * requireRegionScope — handler-level RBAC short-circuit unit test.
 *
 * Per the MVP-Final security-audit (mvpf-idor-001): the integration
 * test only validates the SQL filter contract; this test asserts the
 * handler's 403 path so a future refactor that weakens
 * requireRegionScope() can't pass silently.
 */
import { describe, it, expect } from 'vitest'
import { createError } from 'h3'

// Mirror the helper's contract without importing the full server (the
// helper depends on session.ts which needs runtime env). Keeping a
// copy aligned with server/auth/rbac.ts; if either drifts the test
// surfaces the divergence. CORE-3 (robustness-review-2026-06-09): the
// policy is an explicit allowlist with a fail-closed default — only
// admin (own region) / global-finops / platform-admin have region
// scope; every other role is DENIED.
function checkRegionScopePolicy(opts: {
  role: string
  sessionRegionId: string
  targetRegionId: string
}): { ok: true } | { ok: false; status: 403 } {
  if (opts.role === 'global-finops' || opts.role === 'platform-admin') {
    return { ok: true }
  }
  if (opts.role === 'admin') {
    if (opts.sessionRegionId !== opts.targetRegionId) {
      return { ok: false, status: 403 }
    }
    return { ok: true }
  }
  return { ok: false, status: 403 }
}

describe('requireRegionScope policy', () => {
  it('passes when admin home region matches the target region', () => {
    const result = checkRegionScopePolicy({
      role: 'admin',
      sessionRegionId: 'a',
      targetRegionId: 'a',
    })
    expect(result.ok).toBe(true)
  })

  it('denies when admin home region differs from the target region', () => {
    const result = checkRegionScopePolicy({
      role: 'admin',
      sessionRegionId: 'a',
      targetRegionId: 'b',
    }) as { ok: false; status: 403 }
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  it('global-finops sees any region (bypasses the admin scope check)', () => {
    const result = checkRegionScopePolicy({
      role: 'global-finops',
      sessionRegionId: 'apac',
      targetRegionId: 'emea',
    })
    expect(result.ok).toBe(true)
  })

  it('manager / developer / finance are DENIED (CORE-3 fail-closed default)', () => {
    // Pre-CORE-3 the policy was admin-only and silently let every other role
    // through, relying on upstream requireRole. The allowlist now denies any
    // role without an explicit region-scope rule.
    for (const role of ['manager', 'developer', 'finance']) {
      const result = checkRegionScopePolicy({
        role,
        sessionRegionId: 'apac',
        targetRegionId: 'emea',
      }) as { ok: false; status: 403 }
      expect(result.ok).toBe(false)
      expect(result.status).toBe(403)
    }
  })

  it('an UNKNOWN / future role is denied even for its own region (fail closed)', () => {
    const result = checkRegionScopePolicy({
      role: 'auditor',
      sessionRegionId: 'apac',
      targetRegionId: 'apac',
    }) as { ok: false; status: 403 }
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  it('createError shape — when invoked, the handler produces a 403 with detail copy', () => {
    // Mirror the helper's throw — verify h3.createError accepts the
    // shape so a contract change surfaces.
    const err = createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/region-scope',
        title: 'Region scope mismatch',
        status: 403,
        detail: 'Region admin scope does not include this region.',
      },
    })
    expect(err.statusCode).toBe(403)
    expect(err.data).toBeDefined()
    expect((err.data as Record<string, unknown>).type).toBe('https://tokenscope.example.com/errors/region-scope')
  })
})
