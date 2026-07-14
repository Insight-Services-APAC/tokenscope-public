/*
 * Reconciliation engine — pure classification logic (classifyDelta).
 * No DB; exercises every disposition branch + the lag-buffer boundary.
 */
import { describe, it, expect } from 'vitest'
import { classifyDelta } from '../../../../server/reconciliation/engine'
import type { ReconcileCategory } from '../../../../server/reconciliation/types'

const NOW = new Date('2026-06-08T12:00:00.000Z')

function classify(over: {
  actualUsd: number
  otelUsd: number
  category?: ReconcileCategory
  periodDate?: string
  hasOtelHistory?: boolean
}) {
  return classifyDelta({
    actualUsd: over.actualUsd,
    otelUsd: over.otelUsd,
    category: over.category ?? 'model_tokens',
    periodDate: over.periodDate ?? '2026-06-08',
    hasOtelHistory: over.hasOtelHistory ?? true,
    now: NOW,
    epsilonUsd: 0.01,
    lagBufferHours: 48,
  })
}

describe('classifyDelta', () => {
  it('matches within the epsilon band (rounding noise) — no record', () => {
    const c = classify({ actualUsd: 10.004, otelUsd: 10.0 })
    expect(c.disposition).toBe('matched')
    expect(c.lagState).toBeNull()
  })

  it('over-attribution with OTel history -> untagged (cross-charges CC, tag is overlay)', () => {
    const c = classify({ actualUsd: 12.5, otelUsd: 10.0, hasOtelHistory: true })
    expect(c.disposition).toBe('untagged')
    expect(c.deltaUsd).toBeCloseTo(2.5, 6)
    expect(c.lagState).toBeNull()
  })

  it('over-attribution with NO OTel history -> no_install (seat present, never emitted)', () => {
    const c = classify({ actualUsd: 8.0, otelUsd: 0, hasOtelHistory: false })
    expect(c.disposition).toBe('no_install')
  })

  it('under-attribution within the lag buffer -> walk_back/within_buffer', () => {
    const c = classify({ actualUsd: 5.0, otelUsd: 9.0, periodDate: '2026-06-08' })
    expect(c.disposition).toBe('walk_back')
    expect(c.lagState).toBe('within_buffer')
    expect(c.deltaUsd).toBeCloseTo(-4.0, 6)
  })

  it('under-attribution past the lag buffer -> walk_back/settled', () => {
    const c = classify({ actualUsd: 5.0, otelUsd: 9.0, periodDate: '2026-06-05' })
    expect(c.disposition).toBe('walk_back')
    expect(c.lagState).toBe('settled')
  })

  it('coding-agent is always ingest_only (OTel-invisible, never a walk-back)', () => {
    const over = classify({ actualUsd: 4.0, otelUsd: 0, category: 'copilot_coding_agent' })
    expect(over.disposition).toBe('ingest_only')
    // Even a (spurious) negative delta never becomes a walk_back for this category.
    const neg = classify({ actualUsd: 0, otelUsd: 3.0, category: 'copilot_coding_agent' })
    expect(neg.disposition).toBe('ingest_only')
    expect(neg.lagState).toBeNull()
  })

  it('OTel-invisible org category (web_search) with no history is untagged, not no_install', () => {
    const c = classify({ actualUsd: 6.0, otelUsd: 0, category: 'web_search', hasOtelHistory: false })
    expect(c.disposition).toBe('untagged')
  })

  it('lag_state is only ever set on walk_back rows (legal-cell guard)', () => {
    for (const c of [
      classify({ actualUsd: 12, otelUsd: 10 }), // untagged
      classify({ actualUsd: 8, otelUsd: 0, hasOtelHistory: false }), // no_install
      classify({ actualUsd: 10.004, otelUsd: 10 }), // matched
      classify({ actualUsd: 4, otelUsd: 0, category: 'copilot_coding_agent' }), // ingest_only
    ]) {
      expect(c.lagState).toBeNull()
    }
  })
})
