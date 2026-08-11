/*
 * The ingest-presence probe's KQL + parser.
 *
 * Nothing else in CI asserts on the emitted query, so a change that quietly
 * narrowed the window or filtered the wrong events would produce a confidently
 * WRONG verdict (a device blamed for an absence that is really our clamp) with
 * every test still green. That is the failure this file is here to catch.
 */
import { describe, it, expect } from 'vitest'
import {
  buildInstancePresenceKql,
  parseInstancePresenceRow,
  PRESENCE_KQL_PROJECTION,
} from '../../../server/azure/reader'

const ID = '11111111-1111-4111-8111-111111111111'

describe('buildInstancePresenceKql', () => {
  it('queries the table Claude telemetry actually lands in', () => {
    // Named explicitly: querying the wrong table returns zero rows, which reads
    // as "the device sent nothing" — a confident CLIENT verdict produced entirely
    // by our own mistake. The verified landing table is OTelLogs (see the
    // telemetry contract).
    expect(buildInstancePresenceKql(ID, 24).trimStart().startsWith('OTelLogs')).toBe(true)
  })

  it('scopes to the instance and the requested window', () => {
    const kql = buildInstancePresenceKql(ID, 168)
    expect(kql).toContain(`tostring(ResourceAttributes['tokenscope.instance_id']) == '${ID}'`)
    expect(kql).toContain('ago(168h)')
  })

  it('projects exactly the four columns the parser reads, in the fallback order', () => {
    // The positional fallback is only correct if it matches the summarize order.
    // Derived from the query text rather than restated, so the two cannot drift:
    // a misalignment here swaps a record COUNT for a TIMESTAMP and fabricates a
    // verdict out of it.
    const kql = buildInstancePresenceKql(ID, 24)
    const emitted = [...kql.matchAll(/(\w+)\s*=\s*(?:count\(|countif\(|min\(|max\()/g)].map((m) => m[1])
    expect(emitted).toEqual([...PRESENCE_KQL_PROJECTION])
  })

  it('summarises with the aggregates the parser expects', () => {
    const kql = buildInstancePresenceKql(ID, 24)
    expect(kql).toContain('Records = count()')
    expect(kql).toContain('FirstSeen = min(TimeGenerated)')
    expect(kql).toContain('LastSeen = max(TimeGenerated)')
  })

  it('emits the pipeline as an EXACT clause sequence — every clause present and live', () => {
    /*
     * Deliberately an exact-shape assertion, not a set of `toContain` checks.
     * `toContain` cannot tell a live clause from a commented-out one (KQL's line
     * comment is `//`, so a disabled clause still appears in the string) — the
     * mutation sweep proved every clause here was deletable with the suite green.
     * What a dropped clause costs:
     *   - no `ago()`      → scans all retention; the window the operator chose is
     *                       not the window that was measured.
     *   - no instance filter → counts the WHOLE FLEET's records as this device's,
     *                       which renders as a confident "healthy" for a device
     *                       that has sent nothing. The worst output this feature
     *                       has.
     * A change-detector is the correct trade here: this query IS the evidence.
     */
    const lines = buildInstancePresenceKql(ID, 24).split('\n').map((l) => l.trim()).filter(Boolean)
    expect(lines).toEqual([
      'OTelLogs',
      '| where TimeGenerated > ago(24h)',
      `| where tostring(ResourceAttributes['tokenscope.instance_id']) == '${ID}'`,
      '| summarize Records = count(),',
      "UsageRecords = countif(tostring(Attributes['event.name']) == 'api_request' or tostring(Body) == 'api_request'),",
      'FirstSeen = min(TimeGenerated),',
      'LastSeen = max(TimeGenerated)',
    ])
  })

  it('counts EVERYTHING for the instance, not just api_request', () => {
    // "Is this device's telemetry in ingest AT ALL" is the question. Filtering to
    // api_request in the outer count would report a device that is exporting
    // non-usage records as having sent nothing — a client verdict on a device
    // whose transport is demonstrably working.
    const kql = buildInstancePresenceKql(ID, 24)
    const whereLines = kql.split('\n').filter((l) => l.includes('| where'))
    expect(whereLines).toHaveLength(2) // time bound + instance bound. No event filter.
    // …but the usage subset is still counted, separately.
    expect(kql).toContain('UsageRecords = countif')
    expect(kql).toContain('api_request')
  })

  it('applies NO watermark — it must be able to contradict the joiner', () => {
    // A watermark would make the probe agree with the joiner by construction,
    // which is precisely what makes it useless as a discriminator.
    expect(buildInstancePresenceKql(ID, 24)).not.toContain('TimeGenerated > datetime(')
  })

  it('clamps the window to sane whole hours', () => {
    expect(buildInstancePresenceKql(ID, 0)).toContain('ago(1h)')
    expect(buildInstancePresenceKql(ID, -5)).toContain('ago(1h)')
    expect(buildInstancePresenceKql(ID, 1.9)).toContain('ago(1h)')
    expect(buildInstancePresenceKql(ID, 99_999)).toContain(`ago(${24 * 90}h)`)
  })
})

describe('parseInstancePresenceRow', () => {
  const COLS = ['Records', 'UsageRecords', 'FirstSeen', 'LastSeen']

  it('maps the single summarize row', () => {
    const first = new Date('2026-07-16T01:00:00.000Z')
    const last = new Date('2026-07-24T09:30:00.000Z')
    expect(parseInstancePresenceRow(COLS, [[912, 900, first, last]])).toEqual({
      records: 912,
      usageRecords: 900,
      firstSeen: first.toISOString(),
      lastSeen: last.toISOString(),
    })
  })

  it('is column-keyed, so projection order does not matter', () => {
    const reordered = ['LastSeen', 'Records', 'FirstSeen', 'UsageRecords']
    const r = parseInstancePresenceRow(reordered, [[null, 7, null, 3]])
    expect(r.records).toBe(7)
    expect(r.usageRecords).toBe(3)
  })

  it('reads a genuine zero row as zero (KQL scalar aggregation always returns one row)', () => {
    expect(parseInstancePresenceRow(COLS, [[0, 0, null, null]])).toEqual({
      records: 0,
      usageRecords: 0,
      firstSeen: null,
      lastSeen: null,
    })
  })

  it('reads an EMPTY table as zeroes — the caller, not the parser, decides what that means', () => {
    // The parser cannot know whether the query succeeded; the reader throws on a
    // non-success status precisely so this shape never reaches a verdict as
    // "nothing arrived".
    expect(parseInstancePresenceRow(COLS, [])).toEqual({
      records: 0,
      usageRecords: 0,
      firstSeen: null,
      lastSeen: null,
    })
  })

  it('tolerates string timestamps and non-numeric counts without inventing values', () => {
    const r = parseInstancePresenceRow(COLS, [['12', 'not-a-number', '2026-07-24T09:30:00.000Z', 'nonsense']])
    expect(r.records).toBe(12)
    expect(r.usageRecords).toBe(0)
    expect(r.firstSeen).toBe('2026-07-24T09:30:00.000Z')
    expect(r.lastSeen).toBeNull()
  })
})
