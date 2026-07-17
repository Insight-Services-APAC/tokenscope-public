/*
 * registry analytics-poll — window-override threading (#142).
 *
 * The registry entry decides the poll window: a signed { startingAt, endingAt }
 * body (the historical re-split lever) is honoured ONLY as a pair forming a
 * valid span; anything else falls back to the auto trailing revision window
 * (analyticsPollWindow). This pins that decision at the single convergence
 * point — the window object threaded into runAnalyticsPollReconciledOrgs —
 * mirroring registry-deep-rescan.test.ts (poller + Azure reader stubbed; pure
 * unit test of the registry glue, no DB).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted above imports, so the mock fns must be created inside
// vi.hoisted() — a plain top-level const would be in the temporal dead zone.
const { runAnalyticsPollReconciledOrgs } = vi.hoisted(() => ({
  runAnalyticsPollReconciledOrgs: vi.fn(async () => ({
    orgsConsidered: 0,
    orgsPolled: 0,
    orgsSkippedNoCredential: 0,
    perOrg: [],
  })),
}))

vi.mock('../../../server/workers/analytics-poller', () => ({
  runAnalyticsPollReconciledOrgs,
}))
vi.mock('../../../server/azure/reader', () => ({
  getTelemetryReader: () => ({ getSessionUsage: async () => [] }),
}))

// vi.mock is hoisted above this import, so it must follow.
/* eslint-disable import/first */
import { getWorker, analyticsPollWindow } from '../../../server/workers/registry'
/* eslint-enable import/first */

const fakeDb = {} as never

function analyticsPoll() {
  const entry = getWorker('analytics-poll')
  if (!entry) throw new Error('analytics-poll not registered')
  return entry
}

/** The window threaded into the (mocked) multi-org poller. */
function threadedWindow(): { startingAt: string; endingAt: string } {
  expect(runAnalyticsPollReconciledOrgs).toHaveBeenCalledTimes(1)
  return runAnalyticsPollReconciledOrgs.mock.calls[0]![1] as { startingAt: string; endingAt: string }
}

/** The org scope threaded as the poller's THIRD arg (#142 org scoping). */
function threadedScope(): { onlyExternalOrgId?: string } {
  expect(runAnalyticsPollReconciledOrgs).toHaveBeenCalledTimes(1)
  return runAnalyticsPollReconciledOrgs.mock.calls[0]![2] as { onlyExternalOrgId?: string }
}

/** Run the entry and assert it fell back to the AUTO trailing window. The auto
 * window is computed from `new Date()` inside the entry, so bracket it with two
 * reference computations to stay midnight-safe. */
async function expectAutoWindow(ctx?: Parameters<ReturnType<typeof analyticsPoll>['run']>[1]): Promise<void> {
  const before = analyticsPollWindow(new Date())
  await analyticsPoll().run(fakeDb, ctx)
  const after = analyticsPollWindow(new Date())
  const w = threadedWindow()
  expect([before, after]).toContainEqual(w)
}

describe('registry analytics-poll — window override threading (#142)', () => {
  beforeEach(() => {
    runAnalyticsPollReconciledOrgs.mockClear()
  })

  it('honours a valid { startingAt, endingAt } pair verbatim (the historical re-split lever)', async () => {
    await analyticsPoll().run(fakeDb, { runId: null, opts: { startingAt: '2026-01-01', endingAt: '2026-06-30' } })
    expect(threadedWindow()).toEqual({ startingAt: '2026-01-01', endingAt: '2026-06-30' })
    // No externalOrgId in the opts → an UNSCOPED poll (all reconciled orgs).
    expect(threadedScope()).toEqual({ onlyExternalOrgId: undefined })
  })

  it('threads { startingAt, endingAt, externalOrgId } as window + org scope (the recommended scoped re-pull)', async () => {
    await analyticsPoll().run(fakeDb, {
      runId: null,
      opts: { startingAt: '2026-01-01', endingAt: '2026-06-30', externalOrgId: 'org-acme' },
    })
    expect(threadedWindow()).toEqual({ startingAt: '2026-01-01', endingAt: '2026-06-30' })
    expect(threadedScope()).toEqual({ onlyExternalOrgId: 'org-acme' })
  })

  it('externalOrgId scopes the poll even WITHOUT a window override (auto window + one org)', async () => {
    await expectAutoWindow({ runId: null, opts: { externalOrgId: 'org-acme' } })
    expect(threadedScope()).toEqual({ onlyExternalOrgId: 'org-acme' })
  })

  it('honours a single-day span (startingAt == endingAt)', async () => {
    await analyticsPoll().run(fakeDb, { runId: null, opts: { startingAt: '2026-03-15', endingAt: '2026-03-15' } })
    expect(threadedWindow()).toEqual({ startingAt: '2026-03-15', endingAt: '2026-03-15' })
  })

  it('an INVERTED span (startingAt > endingAt) falls back to the auto window (fail-soft)', async () => {
    await expectAutoWindow({ runId: null, opts: { startingAt: '2026-06-30', endingAt: '2026-01-01' } })
  })

  it('a lone startingAt (no endingAt) falls back to the auto window — the pair is required', async () => {
    await expectAutoWindow({ runId: null, opts: { startingAt: '2026-01-01' } })
  })

  it('a lone endingAt falls back to the auto window', async () => {
    await expectAutoWindow({ runId: null, opts: { endingAt: '2026-06-30' } })
  })

  it('no opts → auto trailing revision window, unscoped', async () => {
    await expectAutoWindow({ runId: null })
    expect(threadedScope()).toEqual({ onlyExternalOrgId: undefined })
  })

  it('no ctx at all → auto trailing revision window, unscoped', async () => {
    await expectAutoWindow()
    expect(threadedScope()).toEqual({ onlyExternalOrgId: undefined })
  })
})
