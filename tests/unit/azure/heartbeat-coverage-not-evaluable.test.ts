// @vitest-environment node
/*
 * S10 (B) — heartbeat-coverage.ts's Claude-only filter (`AND ar.tool =
 * 'claude-code'`) is CORRECT on its merits (Copilot's reactive ~hourly
 * bearer mint would false-quarantine it) — the fix is not to widen it, but
 * to make the exemption it creates COUNTABLE, so a silent gap doesn't read
 * as "nothing to report". This is a lightweight, DB-mocked unit test (no
 * testcontainers) proving the wiring: HeartbeatCoverageResult.notEvaluable
 * is populated from the non-Claude population query, independent of the
 * (mocked, empty here) Claude coverage scan.
 */
import { describe, it, expect, vi } from 'vitest'
import { runHeartbeatCoverage } from '../../../server/workers/heartbeat-coverage'

function makeFakeDb(notEvaluableCount: string) {
  const execute = vi.fn()
  execute.mockResolvedValueOnce([]) // 1st call: the Claude coverage scan (no sessions)
  execute.mockResolvedValueOnce([{ n: notEvaluableCount }]) // 2nd call: the non-Claude count
  return { execute }
}

describe('runHeartbeatCoverage — notEvaluable (S10 B)', () => {
  it('reports the non-Claude population size independent of the (empty) Claude scan', async () => {
    const db = makeFakeDb('7')
    const result = await runHeartbeatCoverage(db as never, { now: new Date('2026-07-15T00:00:00Z') })
    expect(result.sessionsScanned).toBe(0)
    expect(result.quarantined).toBe(0)
    expect(result.resolved).toBe(0)
    expect(result.notEvaluable).toBe(7)
  })

  it('is zero when there is no non-Claude activity in the window', async () => {
    const db = makeFakeDb('0')
    const result = await runHeartbeatCoverage(db as never, { now: new Date('2026-07-15T00:00:00Z') })
    expect(result.notEvaluable).toBe(0)
  })
})
