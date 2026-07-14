/*
 * UI_TRIGGERABLE_WORKERS safelist + extractRowsAffected.
 *
 * The admin "Run now" button (admin/workers/[name]/run) is gated by this
 * safelist. Two invariants matter and are cheap to pin:
 *   1. Every safelisted name is a REAL registered worker — a typo/drift would
 *      make a button 404 (endpoint) or, worse, 500 in dispatch if the guard
 *      regressed. getWorker(name) must resolve for each.
 *   2. The set stays NARROWER than the full registry (destructive/heavy workers
 *      like soft-purge/session-gc must never be one-click) and MUST NOT contain
 *      known-dangerous names.
 */
import { describe, it, expect } from 'vitest'
import { getWorker, listWorkerNames, UI_TRIGGERABLE_WORKERS } from '../../../server/workers/registry'
import { UI_MONEY_WORKER_NAMES } from '../../../shared/workers/ui-triggerable'
import { extractRowsAffected } from '../../../server/workers/dispatch'

describe('UI_TRIGGERABLE_WORKERS', () => {
  it('every safelisted name resolves to a real registered worker', () => {
    for (const name of UI_TRIGGERABLE_WORKERS) {
      expect(getWorker(name), `"${name}" is safelisted but not a registered worker`).toBeDefined()
    }
  })

  it('is a strict, narrower subset of the full worker registry', () => {
    const all = new Set(listWorkerNames())
    for (const name of UI_TRIGGERABLE_WORKERS) expect(all.has(name)).toBe(true)
    expect(UI_TRIGGERABLE_WORKERS.size).toBeLessThan(all.size)
  })

  it('never exposes destructive / money-settling workers as one-click', () => {
    for (const banned of [
      'soft-purge',
      'session-gc',
      'pending-placement-gc',
      'reconciliation-backfill',
      'copilot-pool-bill',
    ]) {
      expect(UI_TRIGGERABLE_WORKERS.has(banned), `"${banned}" must not be UI-triggerable`).toBe(false)
    }
  })

  it('includes identity-sync (the onboarding "bind unresolved seats" use case)', () => {
    expect(UI_TRIGGERABLE_WORKERS.has('identity-sync')).toBe(true)
  })
})

describe('UI_MONEY_WORKER_NAMES (double-confirm set)', () => {
  it('is a subset of the triggerable set', () => {
    for (const n of UI_MONEY_WORKER_NAMES) expect(UI_TRIGGERABLE_WORKERS.has(n)).toBe(true)
  })

  it('classifies by what each WRITES: ledger-writers in, inbox-only reconciliation out', () => {
    expect(UI_MONEY_WORKER_NAMES.has('reconciliation-sync')).toBe(true) // engine → reconciliation_record
    expect(UI_MONEY_WORKER_NAMES.has('usage-reconciliation')).toBe(true) // upserts unaccounted usage
    // 'reconciliation' only emits info inbox items (no ledger write) — must NOT confirm-gate it.
    expect(UI_MONEY_WORKER_NAMES.has('reconciliation')).toBe(false)
  })
})

describe('extractRowsAffected', () => {
  it('returns the first known numeric count key', () => {
    expect(extractRowsAffected({ attributionRowsWritten: 7 })).toBe(7)
    expect(extractRowsAffected({ rowsWritten: 3 })).toBe(3)
    expect(extractRowsAffected({ itemsEmitted: 0 })).toBe(0)
  })

  it('ignores sessionsProcessed (scanned, not written) and non-objects', () => {
    expect(extractRowsAffected({ sessionsProcessed: 50 })).toBeNull()
    expect(extractRowsAffected(null)).toBeNull()
    expect(extractRowsAffected('nope')).toBeNull()
    expect(extractRowsAffected({ upserts: 5 })).toBeNull() // not a recognised key
  })
})
