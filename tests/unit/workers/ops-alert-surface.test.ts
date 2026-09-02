// @vitest-environment node
/*
 * EVERY ALERT CONDITION MUST HAVE A PAGE THAT ANSWERS IT.
 *
 * The cardinal rule of this project's alerting, and one the first release broke:
 * `attribution-stall` and `inbox-aging` both paged a phone while no admin or
 * diagnostic surface carried the evidence for either. The workers card selected
 * status/duration/failures but not `rows_affected`, and no page exposed
 * `last_bearer_at` — so the two numbers that decide whether a stall was real
 * were, between them, nowhere. An operator woken at 03:00 had nothing to open.
 *
 * This is a STRUCTURAL guard rather than a reminder, because the failure is
 * mechanically detectable and remembering has already failed once: a new
 * condition key with no entry here fails the suite, and an entry naming a route
 * that does not exist fails too. It cannot prove the surface is USEFUL — only
 * that one was named and exists. Judging usefulness is what review is for.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { OPS_ALERT_CONDITION } from '../../../shared/ops-alert/conditions'

/**
 * Condition key → the route whose output answers "why did this fire?", as a
 * repo path so the assertion breaks when the file moves or is deleted.
 */
const ANSWERING_SURFACE: Record<string, { route: string; shows: string }> = {
  'telemetry-read': {
    route: 'server/api/v1/admin/diagnostics/otel-logs.get.ts',
    shows: 'what the reader can actually see in Azure Monitor over a window',
  },
  'attribution-stall': {
    route: 'server/api/v1/admin/diagnostics/index.get.ts',
    shows: "the reader's rowsAffected and sessionsProcessed — zero rows with zero sessions is idle, zero rows WITH sessions is the fault",
  },
  'probe-network': {
    route: 'server/api/v1/admin/diagnostics/network.get.ts',
    shows: 'per-host DNS/TCP verdicts for every expectPrivate endpoint',
  },
  'worker-fleet': {
    route: 'server/api/v1/admin/diagnostics/index.get.ts',
    shows: 'per-worker last run, RAG and consecutive-failure streak',
  },
  'channel-test': {
    route: 'server/api/v1/admin/diagnostics/probes.get.ts',
    shows: 'the probe results a channel validation ping is asserting against',
  },
}

/** Per-worker keys are `worker:<name>` and share the fleet surface. */
const WORKER_KEY_SURFACE = ANSWERING_SURFACE['worker-fleet']!

describe('every ops-alert condition has an answering surface', () => {
  const keys = Object.values(OPS_ALERT_CONDITION)

  it('names a surface for every fixed condition key', () => {
    const missing = keys.filter((k) => !ANSWERING_SURFACE[k])
    expect(
      missing,
      `condition(s) with no page to answer them: ${missing.join(', ')}. ` +
        'Add the diagnostic route BEFORE the condition ships — an alert with ' +
        'nowhere to look is worse than no alert.',
    ).toEqual([])
  })

  it('every named surface actually exists', () => {
    const root = resolve(__dirname, '../../..')
    for (const [key, { route }] of Object.entries(ANSWERING_SURFACE)) {
      expect(existsSync(resolve(root, route)), `${key} names a route that does not exist: ${route}`).toBe(true)
    }
    expect(existsSync(resolve(root, WORKER_KEY_SURFACE.route))).toBe(true)
  })

  it('names no surface for a condition that no longer exists', () => {
    // The other direction: a retired condition leaving a stale entry here would
    // make the map read as coverage for something nothing can raise.
    const orphans = Object.keys(ANSWERING_SURFACE).filter((k) => !keys.includes(k as never))
    expect(orphans, `surface entries for retired conditions: ${orphans.join(', ')}`).toEqual([])
  })
})
