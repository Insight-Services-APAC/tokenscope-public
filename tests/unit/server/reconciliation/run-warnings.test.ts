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

  /*
   * These three fields were added with doc comments claiming they make a condition
   * "visible in operator surfaces, not silent". That claim is only true if THIS
   * prober dispatches on them: the runs-list warning badge is the operator surface
   * the claim refers to, and an admin is never prompted to open a specific run's raw
   * result dump. A field written but never probed is a control asserted in prose.
   */
  it('surfaces a silent GitHub App -> PAT credential downgrade', () => {
    const w = deriveRunWarnings({ scopesRun: 3, githubCredentialMirrorWarnings: 2 })
    expect(w).toContain('2 enterprise(s) silently using PAT mode despite an App key')
    // Zero must stay quiet: a warning that always fires is noise, and noise is why
    // operators stop reading badges.
    expect(deriveRunWarnings({ githubCredentialMirrorWarnings: 0 })).toEqual([])
  })

  it('surfaces a truncated Copilot seat roster from the AGGREGATED counts', () => {
    expect(deriveRunWarnings({ copilotSeatPagesCapped: 1 })).toContain(
      '1 enterprise(s) hit the seat pagination cap — roster truncated, seat counts understated',
    )
    expect(deriveRunWarnings({ copilotSeatPageShort: 2 })).toContain(
      '2 enterprise(s) ended the seat pull on a short page — roster may be incomplete',
    )
    // Zero is the healthy steady state and must stay quiet.
    expect(deriveRunWarnings({ copilotSeatPagesCapped: 0, copilotSeatPageShort: 0 })).toEqual([])
    /*
     * REGRESSION PIN — the per-enterprise BOOLEANS must not be probed here.
     * copilot-bill is not its own registry worker, so CopilotBillResult never becomes
     * a worker_run.result; only ReconcileSyncResult is persisted. An earlier version
     * of this file probed `seatPagesCapped`/`seatPageShort` directly and was dead
     * code, and this very test hid it by hand-building an object with those keys
     * already present. Asserting the raw booleans produce NOTHING is what keeps the
     * probe pointed at the shape that actually reaches the database.
     */
    expect(deriveRunWarnings({ seatPagesCapped: true, seatPageShort: true })).toEqual([])
  })

  /*
   * The §B pooled-chargeback silence. copilot-pool-bill isolates a failing
   * (enterprise, month) and still returns 'success', so these counters are the ONLY
   * operator-visible signal: worker logs are NSP-locked and the GitHub Verify probe
   * ladder (credential -> roster -> appAuth -> licenses -> metrics) has no billing
   * stage. Without these probes an empty copilot_pool_bill caused by a 403 on the
   * billing read is indistinguishable from "nothing was chargeable".
   */
  it('surfaces a failed pooled billing read rather than a green, empty run', () => {
    expect(deriveRunWarnings({ enterprisesRun: 0, enterprisesErrored: 1 })).toContain(
      '1 pooled billing read failure(s) — pooled chargeback under-books until re-run',
    )
    expect(deriveRunWarnings({ enterprisesSkippedNoCredential: 2 })).toContain(
      '2 enterprise(s) skipped with no wired credential — pooled bill not read',
    )
    expect(deriveRunWarnings({ unsettledOrgMonths: 3 })).toContain(
      '3 org-month(s) unsettled (usage present but no licence charge read) — licence cost missing from pooled chargeback',
    )
    expect(deriveRunWarnings({ unclassifiedOrgMonths: 4 })).toContain(
      '4 org-month(s) carry unclassified Copilot spend — unclassified money is NEVER charged',
    )
    // A fully-exempt run is the healthy dev steady state (every org matches the
    // demo/NFR heuristic, so nothing is written) and must NOT raise a warning.
    expect(
      deriveRunWarnings({
        enterprisesRun: 1,
        enterprisesErrored: 0,
        enterprisesSkippedNoCredential: 0,
        orgsExemptSkipped: 1,
        orgRowsWritten: 0,
        unsettledOrgMonths: 0,
        unclassifiedOrgMonths: 0,
      }),
    ).toEqual([])
  })
})
