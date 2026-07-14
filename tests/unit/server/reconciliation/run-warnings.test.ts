import { describe, it, expect } from 'vitest'
import { deriveRunWarnings } from '../../../../server/reconciliation/run-warnings'

describe('deriveRunWarnings', () => {
  it('returns [] for null / non-object (legacy rows, pre-0042)', () => {
    expect(deriveRunWarnings(null)).toEqual([])
    expect(deriveRunWarnings(undefined)).toEqual([])
    expect(deriveRunWarnings('nope')).toEqual([])
    expect(deriveRunWarnings(42)).toEqual([])
  })

  it('returns [] for a clean reconciliation-sync result', () => {
    expect(
      deriveRunWarnings({
        scopesConsidered: 2,
        scopesRun: 2,
        scopesSkippedNoAdapter: 0,
        scopesSkippedNoCredential: 0,
        scopesErrored: 0,
        rowsWritten: 5,
      }),
    ).toEqual([])
  })

  it('surfaces reconciliation-sync scope problems', () => {
    const w = deriveRunWarnings({
      scopesErrored: 1,
      scopesSkippedNoCredential: 2,
      scopesSkippedNoAdapter: 1,
      rowsWritten: 0,
    })
    expect(w).toContain('1 scope(s) errored')
    expect(w).toContain('2 scope(s) missing credentials')
    expect(w).toContain('1 scope(s) without a registered adapter')
  })

  it('surfaces identity-sync + engine problems', () => {
    expect(deriveRunWarnings({ resolversRun: 1, resolversErrored: 1, upserts: 0 })).toContain(
      '1 identity resolver(s) errored',
    )
    expect(deriveRunWarnings({ skippedInvalid: 3, skippedUnresolved: 2 })).toEqual([
      '3 line(s) skipped as invalid',
      '2 line(s) skipped (teammate unresolved)',
    ])
  })

  it('ignores non-finite / unknown keys without throwing', () => {
    expect(deriveRunWarnings({ scopesErrored: NaN, other: 'x' })).toEqual([])
  })
})
