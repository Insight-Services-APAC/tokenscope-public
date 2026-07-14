// @vitest-environment node
/*
 * parseLogAnalyticsRows — the pure Log Analytics result-table → UsageRecord
 * mapper. The KQL itself is verified at sandbox bring-up; this locks the
 * mapping logic (column-name keyed, type coercion, skip rules) now.
 */
import { describe, it, expect } from 'vitest'
import { parseLogAnalyticsRows, parseSignalRows } from '../../../server/azure/reader'

const COLS = ['TokenscopeSessionId', 'Model', 'TokenType', 'Tokens', 'TsEvent', 'SourceRunId']

describe('parseLogAnalyticsRows', () => {
  it('maps a LAW table to UsageRecords (one per token type)', () => {
    const ts = new Date('2026-06-01T00:00:00Z')
    const rows = [
      ['sid-1', 'claude-opus-4-8', 'input', 1856, ts, 'req_1'],
      ['sid-1', 'claude-opus-4-8', 'output', 4, ts, 'req_1'],
      ['sid-1', 'claude-opus-4-8', 'cache-read', 17308, ts, 'req_1'],
    ]
    const out = parseLogAnalyticsRows(COLS, rows)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({
      tokens: 1856,
      tokenType: 'input',
      model: 'claude-opus-4-8',
      tsEvent: '2026-06-01T00:00:00.000Z',
      sourceRunId: 'req_1',
    })
    expect(out[2]!.tokenType).toBe('cache-read')
    expect(out[2]!.tokens).toBe(17308)
  })

  it('is column-order independent (keyed by name)', () => {
    const reordered = ['Tokens', 'TokenType', 'TsEvent', 'Model', 'SourceRunId', 'TokenscopeSessionId']
    const out = parseLogAnalyticsRows(reordered, [[500, 'output', '2026-06-01T00:00:00Z', 'm', 'r', 's']])
    expect(out[0]).toMatchObject({ tokens: 500, tokenType: 'output', model: 'm', sourceRunId: 'r' })
  })

  it('skips rows with zero/empty tokens or missing token type', () => {
    const out = parseLogAnalyticsRows(COLS, [
      ['s', 'm', 'input', 0, '2026-06-01T00:00:00Z', 'r'], // zero → skip
      ['s', 'm', '', 100, '2026-06-01T00:00:00Z', 'r'], // no type → skip
      ['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r'], // keep
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.tokens).toBe(100)
  })

  it('tolerates string-typed token counts + missing SourceRunId', () => {
    const out = parseLogAnalyticsRows(['TokenType', 'Tokens', 'Model', 'TsEvent'], [
      ['input', '442', 'm', '2026-06-01T00:00:00Z'],
    ])
    expect(out[0]!.tokens).toBe(442)
    expect(out[0]!.sourceRunId).toBeUndefined()
  })

  it('ING-9: skips + counts rows with a missing/unparseable TsEvent instead of fabricating now()', () => {
    // Fabricating now() gave the row a DIFFERENT synthetic ts every tick, so the
    // dedup index never matched and the same event double-counted on every read.
    const rows = [
      ['s', 'm', 'input', 100, null, 'r'], // null ts → skip
      ['s', 'm', 'input', 100, 'not-a-date', 'r'], // unparseable → skip
      ['s', 'm', 'input', 100, '', 'r'], // empty → skip
      ['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r'], // keep
    ]
    const counters = { skippedNoTimestamp: 0 }
    const out = parseLogAnalyticsRows(COLS, rows, counters)
    expect(out).toHaveLength(1)
    expect(out[0]!.tsEvent).toBe('2026-06-01T00:00:00Z')
    expect(counters.skippedNoTimestamp).toBe(3)

    // Parsing the SAME table twice yields identical output (no per-call now())
    // and the same skip count — the null-ts row can never double-count.
    const counters2 = { skippedNoTimestamp: 0 }
    const out2 = parseLogAnalyticsRows(COLS, rows, counters2)
    expect(out2).toEqual(out)
    expect(counters2.skippedNoTimestamp).toBe(3)
  })

  it('mig 0045: surfaces QuerySource + LawCostUsd when present, omits them otherwise', () => {
    const cols = [...COLS, 'QuerySource', 'LawCostUsd']
    const out = parseLogAnalyticsRows(cols, [
      ['sid-1', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', 'main', 0.0123],
      ['sid-1', 'm', 'output', 5, '2026-06-01T00:00:00Z', 'r', 'generate_session_title', '0.0004'],
    ])
    expect(out[0]!.querySource).toBe('main')
    expect(out[0]!.lawCostUsd).toBe(0.0123)
    // string-typed cost coerces (LAW dynamic columns can stringify)
    expect(out[1]!.querySource).toBe('generate_session_title')
    expect(out[1]!.lawCostUsd).toBe(0.0004)

    // Absent columns / empty values → undefined (legacy emission shape).
    const legacy = parseLogAnalyticsRows(COLS, [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r']])
    expect(legacy[0]!.querySource).toBeUndefined()
    expect(legacy[0]!.lawCostUsd).toBeUndefined()
    const empty = parseLogAnalyticsRows(cols, [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', '', '']])
    expect(empty[0]!.querySource).toBeUndefined()
    expect(empty[0]!.lawCostUsd).toBeUndefined()
  })

  it('surfaces the emitted ProjectCodeHash (ADR-0004 B′) when present, omits it otherwise', () => {
    const withProj = parseLogAnalyticsRows(
      [...COLS, 'OrganizationId', 'ProjectCodeHash'],
      [['sid-1', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', 'org-x', 'h-repo-a']],
    )
    expect(withProj[0]!.projectCodeHash).toBe('h-repo-a')

    // No ProjectCodeHash column (or empty) → undefined (record stays untagged).
    expect(parseLogAnalyticsRows(COLS, [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r']])[0]!.projectCodeHash)
      .toBeUndefined()
    expect(parseLogAnalyticsRows([...COLS, 'ProjectCodeHash'],
      [['s', 'm', 'input', 100, '2026-06-01T00:00:00Z', 'r', '']])[0]!.projectCodeHash)
      .toBeUndefined()
  })
})

// parseSignalRows — the pure usage_signal table → SignalRecord mapper (mig 0065).
// One row (span) fans out to one SignalRecord per PRESENT signal column.
const SIG_COLS = ['_ts', '_req', 'tool_count', 'mcp_count', 'ctx_pct', 'turn_count']

describe('parseSignalRows', () => {
  it('fans a chat-signal row out to one record per present signal (tool_count + ctx_pct)', () => {
    const ts = new Date('2026-06-01T00:00:00Z')
    // chat span: tool_count + ctx_pct present; mcp_count + turn_count null
    const out = parseSignalRows(SIG_COLS, [[ts, 'span-chat', 38, null, 12, null]])
    expect(out).toHaveLength(2)
    expect(out).toContainEqual({ signalName: 'tool_count', value: 38, tsEvent: ts.toISOString(), sourceRunId: 'span-chat' })
    expect(out).toContainEqual({ signalName: 'ctx_pct', value: 12, tsEvent: ts.toISOString(), sourceRunId: 'span-chat' })
  })

  it('fans an invoke_agent-signal row out to mcp_count + turn_count', () => {
    const out = parseSignalRows(SIG_COLS, [['2026-06-01T00:00:00Z', 'span-inv', null, 4, null, 7]])
    expect(out.map((r) => r.signalName).sort()).toEqual(['mcp_count', 'turn_count'])
    expect(out.find((r) => r.signalName === 'turn_count')!.value).toBe(7)
  })

  it('is column-order independent (keyed by name) and tolerates string values', () => {
    const reordered = ['turn_count', '_req', 'ctx_pct', '_ts', 'tool_count', 'mcp_count']
    const out = parseSignalRows(reordered, [['9', 'r', '85', '2026-06-01T00:00:00Z', '20', '']])
    // turn_count=9, ctx_pct=85, tool_count=20; mcp_count empty → omitted
    expect(out.map((r) => r.signalName).sort()).toEqual(['ctx_pct', 'tool_count', 'turn_count'])
    expect(out.find((r) => r.signalName === 'ctx_pct')!.value).toBe(85)
  })

  it('skips null/empty/NaN/negative signal values (a chat span has no mcp_count)', () => {
    const out = parseSignalRows(SIG_COLS, [['2026-06-01T00:00:00Z', 'r', 'NaN', -3, '', 5]])
    // tool_count NaN → skip; mcp_count -3 → skip; ctx_pct '' → skip; turn_count 5 → keep
    expect(out).toEqual([{ signalName: 'turn_count', value: 5, tsEvent: '2026-06-01T00:00:00Z', sourceRunId: 'r' }])
  })

  it('ING-9: skips + counts rows with no parseable timestamp (never fabricates)', () => {
    const rows = [
      [null, 'r', 38, null, null, null], // null ts → skip
      ['not-a-date', 'r', 38, null, null, null], // unparseable → skip
      ['2026-06-01T00:00:00Z', 'r', 38, null, null, null], // keep
    ]
    const counters = { skippedNoTimestamp: 0 }
    const out = parseSignalRows(SIG_COLS, rows, counters)
    expect(out).toHaveLength(1)
    expect(counters.skippedNoTimestamp).toBe(2)
    // idempotent: re-parsing yields identical output (no per-call now())
    expect(parseSignalRows(SIG_COLS, rows, { skippedNoTimestamp: 0 })).toEqual(out)
  })

  it('omits sourceRunId when _req is absent/empty', () => {
    const out = parseSignalRows(['_ts', 'tool_count'], [['2026-06-01T00:00:00Z', 30]])
    expect(out[0]!.sourceRunId).toBeUndefined()
  })
})
