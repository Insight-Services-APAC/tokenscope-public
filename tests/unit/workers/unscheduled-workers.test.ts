/*
 * The UNSCHEDULED_WORKERS contract.
 *
 * A registered worker with no cron job never runs. Before this existed, the admin
 * worker-controls card rendered `recommendedCron` for every worker in the registry
 * — including archive-ledger, which has no Container Apps job at all. An operator
 * reading that card would conclude it runs monthly. It does not run, ever. That is
 * the silent-no-op illusion the scheduling epic exists to kill, reproduced in the
 * UI built to expose it.
 *
 * worker-schedule-lockstep enforces this list against the bicep. These tests pin
 * the RUNTIME half: the shape the enablement API relies on to suppress a cron.
 */
import { describe, it, expect } from 'vitest'
import { UNSCHEDULED_WORKERS, isWorkerScheduled, unscheduledReason } from '../../../shared/workers/unscheduled'
import { WORKERS } from '../../../server/workers/registry'

describe('UNSCHEDULED_WORKERS', () => {
  it('every entry names a REGISTERED worker (no ghosts)', () => {
    const registered = new Set(WORKERS.map((w) => w.name))
    const ghosts = Object.keys(UNSCHEDULED_WORKERS).filter((n) => !registered.has(n))
    expect(ghosts, `unscheduled list references workers that do not exist: ${ghosts.join(', ')}`).toEqual([])
  })

  it('every entry carries a non-empty REASON, not a bare marker', () => {
    // The list is only trustworthy if each entry states its blocker; an empty
    // reason is how a "we know about this" list decays into a mute allowlist.
    for (const [name, reason] of Object.entries(UNSCHEDULED_WORKERS)) {
      expect(reason.trim().length, `${name} has no recorded reason for being unscheduled`).toBeGreaterThan(10)
    }
  })

  it('isWorkerScheduled is false for listed workers and true otherwise', () => {
    for (const name of Object.keys(UNSCHEDULED_WORKERS)) {
      expect(isWorkerScheduled(name), `${name} is listed as unscheduled`).toBe(false)
    }
    const listed = new Set(Object.keys(UNSCHEDULED_WORKERS))
    for (const w of WORKERS.filter((w) => !listed.has(w.name))) {
      expect(isWorkerScheduled(w.name), `${w.name} is not listed, so it must read as scheduled`).toBe(true)
    }
  })

  it('is a MEMBERSHIP test, not a validity check — an unknown name reads as scheduled', () => {
    // Pins the documented caveat: callers must establish the name is a registered
    // worker first (enablement.put.ts rejects unknown names before reaching this).
    // Used alone on unvalidated input, a typo would wave through as "scheduled".
    expect(isWorkerScheduled('not-a-worker-at-all')).toBe(true)
    expect(unscheduledReason('not-a-worker-at-all')).toBeNull()
  })

  it('does not inherit prototype keys (a plain-object lookup guard)', () => {
    // Regression pin, not a live hazard: the map is null-prototype and the helpers
    // use Object.hasOwn, so this already holds. It is asserted because the FIRST
    // implementation used `name in {...}` against a normal object literal, where a
    // worker named 'constructor' resolved through the prototype chain — reported as
    // unscheduled, and its indexed read returned a FUNCTION where the card renders a
    // reason string. Reverting either detail silently reintroduces that.
    expect(isWorkerScheduled('constructor')).toBe(true)
    expect(isWorkerScheduled('toString')).toBe(true)
    expect(unscheduledReason('constructor')).toBeNull()
  })
})
