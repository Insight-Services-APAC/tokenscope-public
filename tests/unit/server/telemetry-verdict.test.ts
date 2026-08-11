/*
 * The client-vs-server discriminator.
 *
 * The rule is small enough to state in one line and consequential enough that
 * getting it backwards sends an incident down the wrong half of the system. The
 * case that matters most is the one that is NOT a verdict: an unreadable ingest
 * side must never be reported as "the client sent nothing", because a failed
 * probe and an empty workspace produce identical numbers and opposite diagnoses.
 */
import { describe, it, expect } from 'vitest'
import { classifyTelemetry } from '../../../server/utils/telemetry-verdict'

describe('classifyTelemetry', () => {
  it('ingest has records, ledger has none → OUR side (the joiner)', () => {
    const r = classifyTelemetry({ ingest: { records: 900, usageRecords: 900 }, attributedRecords: 0 })
    expect(r.verdict).toBe('ingested-not-attributed')
    expect(r.side).toBe('server')
  })

  it('ingest has nothing, ledger has nothing → the CLIENT side', () => {
    const r = classifyTelemetry({ ingest: { records: 0, usageRecords: 0 }, attributedRecords: 0 })
    expect(r.verdict).toBe('absent-from-ingest')
    expect(r.side).toBe('client')
  })

  it('both sides have records → the window is healthy, not an outage', () => {
    const r = classifyTelemetry({ ingest: { records: 900, usageRecords: 900 }, attributedRecords: 850 })
    expect(r.verdict).toBe('attributed')
    expect(r.side).toBe('none')
  })

  it('ingest unreadable → UNANSWERABLE, never "the client sent nothing"', () => {
    // The whole point. `null` (could not read) and `{records: 0}` (read, found
    // nothing) look the same in a count and mean opposite things. Collapsing them
    // would blame the device for our own broken probe.
    const r = classifyTelemetry({ ingest: null, attributedRecords: 0 })
    expect(r.verdict).toBe('unanswerable')
    expect(r.side).toBeNull()
    const absent = classifyTelemetry({ ingest: { records: 0, usageRecords: 0 }, attributedRecords: 0 })
    expect(r.verdict).not.toBe(absent.verdict)
  })

  it('unreadable ingest stays unanswerable even when the ledger HAS rows', () => {
    // A tempting shortcut is "ledger rows exist, so things are fine" — but the
    // question asked was about ingest, and it still was not answered.
    const r = classifyTelemetry({ ingest: null, attributedRecords: 500 })
    expect(r.verdict).toBe('unanswerable')
  })

  it('ledger rows with no ingest rows → flagged as a window problem, not a fault', () => {
    // Real and common: attribution_record is permanent, the workspace has a
    // retention horizon, so a wide window reaches past what ingest still holds.
    const r = classifyTelemetry({ ingest: { records: 0, usageRecords: 0 }, attributedRecords: 42 })
    expect(r.verdict).toBe('attributed-beyond-ingest-window')
    expect(r.side).toBeNull()
    expect(r.interpretation).toMatch(/shorter window/i)
  })

  it('records present but NONE carrying usage → the CLIENT side, and NOT the joiner', () => {
    // The dangerous misread: "records are in ingest, so the joiner must have
    // dropped them". There is nothing to join — the transport works, the usage
    // events do not exist. Routing this to a widened re-read would spend real
    // query budget hunting a backlog that was never ingested.
    const r = classifyTelemetry({ ingest: { records: 12, usageRecords: 0 }, attributedRecords: 0 })
    expect(r.verdict).toBe('ingested-without-usage')
    expect(r.side).toBe('client')
    expect(r.interpretation).toMatch(/re-read will not help/i)
  })

  it('usage records present → the joiner, not the client', () => {
    // The mirror of the case above; the two differ ONLY in usageRecords, which is
    // the whole reason that field is carried into the decision rather than merely
    // reported alongside it.
    const r = classifyTelemetry({ ingest: { records: 12, usageRecords: 12 }, attributedRecords: 0 })
    expect(r.verdict).toBe('ingested-not-attributed')
    expect(r.side).toBe('server')
  })

  it('every verdict carries a non-empty, actionable interpretation', () => {
    // The interpretation is the product surface — an operator reads it, not the
    // enum. A verdict that renders as a bare slug helps nobody.
    const inputs = [
      { ingest: null, attributedRecords: 0 },
      { ingest: { records: 0, usageRecords: 0 }, attributedRecords: 0 },
      { ingest: { records: 0, usageRecords: 0 }, attributedRecords: 5 },
      { ingest: { records: 5, usageRecords: 0 }, attributedRecords: 0 },
      { ingest: { records: 5, usageRecords: 5 }, attributedRecords: 0 },
      { ingest: { records: 5, usageRecords: 5 }, attributedRecords: 5 },
    ]
    for (const input of inputs) {
      const r = classifyTelemetry(input)
      expect(r.interpretation.length).toBeGreaterThan(40)
    }
    // …and the set above reaches EVERY declared verdict, so a future verdict added
    // without an interpretation cannot slip through this check. Named rather than
    // counted: a bare count would be satisfied by the wrong five.
    expect([...new Set(inputs.map((i) => classifyTelemetry(i).verdict))].sort()).toEqual([
      'absent-from-ingest',
      'attributed',
      'attributed-beyond-ingest-window',
      'ingested-not-attributed',
      'ingested-without-usage',
      'unanswerable',
    ])
  })
})
