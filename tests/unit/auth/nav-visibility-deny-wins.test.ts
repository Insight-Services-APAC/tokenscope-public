// @vitest-environment node
/*
 * GUARD — the revoke is read LAST, so deny wins.
 *
 * `resolveReportingNav` issues three separate statements. Under READ COMMITTED
 * each sees its own snapshot, so their ORDER decides what a concurrent revoke
 * does:
 *
 *   permissions@T1 (grant visible) → revoke@T2 (revoke committed after T1 is
 *   visible) ⇒ denied. Correct, and what `resolveReportGrants` already does
 *   (server/auth/report-scope.ts:185-187).
 *
 *   revoke@T1 (nothing yet) → permissions@T2 (grant still visible) ⇒ GRANTED,
 *   with a committed revoke in force. That was the first version of this file
 *   and it is the bug this test exists to prevent coming back.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It pins the ORDER, with the primitives
 * mocked. It does NOT prove that a concurrent revoke denies — that needs two
 * real transactions interleaved, which this does not do. The order is pinned
 * because a pure behavioural test cannot see the defect at all: with no
 * concurrency both orders return the same answer, which is exactly why the bug
 * survived a green suite AND a mutation sweep.
 *
 * A RESIDUAL WINDOW REMAINS, and it is not this file's to close. Reading
 * positive permissions at T1 and using them at T2 means a grant soft-revoked in
 * between is still honoured for this one resolution. That is a property of the
 * canonical sequence (`resolveReportGrants`, report-scope.ts:185-187) shared by
 * /reports/meta and every other consumer — not something the nav introduced.
 * Closing it means one snapshot-consistent read in report-scope.ts, which
 * changes six-plus consumers and belongs in its own change. Marked here rather
 * than left silent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[] = []

let ownsResult = false

vi.mock('../../../server/auth/report-scope', () => ({
  computeOwnsCostCentre: vi.fn(async () => {
    calls.push('ownership')
    return ownsResult
  }),
  resolveReportPermissions: vi.fn(async () => {
    calls.push('permissions')
    return ['operational']
  }),
  resolveReportAccessRevoked: vi.fn(async () => {
    calls.push('revoke')
    return false
  }),
}))

const { resolveReportingNav } = await import('../../../server/auth/nav-visibility')

const event = { context: {} } as never
const tx = {} as never

beforeEach(() => {
  calls.length = 0
  ownsResult = false
})

describe('resolveReportingNav read order', () => {
  it('reads the revoke AFTER permissions — the canonical order', async () => {
    await resolveReportingNav(event, tx, '9a1e0000-0000-4000-8000-0000000000a1', 'developer')

    expect(calls).toEqual(['ownership', 'permissions', 'revoke'])
    // Stated as its own assertion so the failure message names the invariant
    // rather than just showing two arrays that differ.
    expect(
      calls.indexOf('revoke') > calls.indexOf('permissions'),
      'the revoke must be read AFTER permissions — reversing them lets a revoke ' +
        'committed between the two statements go unseen while its positive grant ' +
        'is still visible, and the caller keeps access',
    ).toBe(true)
  })

  it('stops after ownership — the later reads cannot change an owner\'s verdict', async () => {
    /*
     * Ownership alone fixes BOTH outputs, so permissions and revoke are dead
     * work on this path. Pinned because the saving is invisible in the RESULT:
     * reading them returns the same verdict, so only the call list can tell
     * whether they ran.
     *
     * This is NOT a shortcut past the revoke. A revoke-all zeroes the grant arm
     * only and never ownership, so reading it could not deny this caller — the
     * behaviour a route test above pins independently.
     */
    ownsResult = true
    const verdict = await resolveReportingNav(
      event,
      tx,
      '9a1e0000-0000-4000-8000-0000000000a3',
      'developer',
    )
    expect(verdict).toEqual({ visible: true, scope: 'cost-centre' })
    expect(calls).toEqual(['ownership'])
  })

  it('does not read either when the ROLE alone settles it', async () => {
    const verdict = await resolveReportingNav(
      event,
      tx,
      '9a1e0000-0000-4000-8000-0000000000a2',
      'platform-admin',
    )
    expect(verdict).toEqual({ visible: true, scope: null })
    expect(calls).toEqual([])
  })
})
