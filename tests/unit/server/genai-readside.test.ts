// @vitest-environment node
/*
 * Native Copilot GenAI read-side (flag-gated, dormant until SPK-COPILOT-OTEL).
 * Locks the token-unit mapping contract and the KQL projection so the mapping
 * can't drift, and proves the reused parseLogAnalyticsRows contract against the
 * GenAI-derived column set. The LIVE-LAW landing shape (table + attribute
 * columns) is SPIKE-CONFIRM and NOT covered here — only the mapping logic is.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  GENAI_TOKEN_UNIT_MAP,
  buildSessionUsageKqlGenAI,
  copilotNativeOtelEnabled,
  parseLogAnalyticsRows,
} from '../../../server/azure/reader'

describe('GENAI_TOKEN_UNIT_MAP (mapping contract)', () => {
  it('maps exactly the four non-overlapping rate_line units', () => {
    expect(GENAI_TOKEN_UNIT_MAP.map((m) => m.unit)).toEqual(['input', 'output', 'cache-read', 'cache-write'])
  })

  it('binds each unit to its GenAI-convention attribute', () => {
    const byUnit = Object.fromEntries(GENAI_TOKEN_UNIT_MAP.map((m) => [m.unit, m.attr]))
    expect(byUnit['input']).toBe('gen_ai.usage.input_tokens')
    expect(byUnit['output']).toBe('gen_ai.usage.output_tokens')
    expect(byUnit['cache-read']).toBe('gen_ai.usage.cache_read.input_tokens')
    expect(byUnit['cache-write']).toBe('gen_ai.usage.cache_creation.input_tokens')
  })

  it('DELIBERATELY excludes reasoning tokens (subset of output → would double-count)', () => {
    expect(GENAI_TOKEN_UNIT_MAP.some((m) => /reasoning/.test(m.attr))).toBe(false)
  })
})

describe('buildSessionUsageKqlGenAI', () => {
  const SID = '11111111-1111-1111-1111-111111111111'

  it('joins on OUR tokenscope.instance_id resource attribute (same key as Claude)', () => {
    const kql = buildSessionUsageKqlGenAI(SID)
    expect(kql).toContain(`ResourceAttributes['tokenscope.instance_id']) == '${SID}'`)
  })

  it('reads every mapped GenAI token attribute and the model', () => {
    const kql = buildSessionUsageKqlGenAI(SID)
    for (const { attr } of GENAI_TOKEN_UNIT_MAP) expect(kql).toContain(attr)
    expect(kql).toContain('gen_ai.response.model')
    expect(kql).toContain('gen_ai.request.model')
  })

  it('filters to the chat operation (no agent/tool double-count) and never reads reasoning as a token', () => {
    const kql = buildSessionUsageKqlGenAI(SID)
    expect(kql).toContain(`Attributes['gen_ai.operation.name']) == 'chat'`)
    expect(kql).not.toContain('reasoning')
  })

  it('projects the SAME final columns as the Claude query (so parseLogAnalyticsRows is reused)', () => {
    const kql = buildSessionUsageKqlGenAI(SID)
    for (const col of ['TokenType', 'Tokens', 'Model', 'TsEvent']) expect(kql).toContain(col)
  })

  it('adds a watermark bound only when a since-timestamp is supplied', () => {
    expect(buildSessionUsageKqlGenAI(SID)).not.toContain('TimeGenerated > datetime(')
    expect(buildSessionUsageKqlGenAI(SID, new Date('2026-07-10T00:00:00Z'))).toContain('TimeGenerated > datetime(')
  })

  it('is structurally sane (balanced quotes + brackets, has the mv-expand + project stages)', () => {
    const kql = buildSessionUsageKqlGenAI(SID)
    // Substring checks are shallow; catch gross generation breakage too.
    expect((kql.match(/'/g) ?? []).length % 2).toBe(0) // balanced single-quotes
    expect((kql.match(/\[/g) ?? []).length).toBe((kql.match(/\]/g) ?? []).length)
    expect(kql).toContain('mv-expand')
    expect(kql).toContain('| project')
  })

  it('self-guards against an unsafe session id (defense-in-depth, ING-10)', () => {
    expect(() => buildSessionUsageKqlGenAI("x'; drop")).toThrow(/UUID-shaped/)
  })
})

describe('reused parser over GenAI-derived rows (column contract)', () => {
  // What the GenAI KQL emits post-mv-expand: identical columns to the Claude
  // query, with GenAI-absent fields empty (no nano_aiu, org, cost).
  const COLS = [
    'TokenscopeSessionId', 'Model', 'TokenType', 'Tokens', 'TsEvent', 'SourceRunId',
    'OrganizationId', 'ProjectCodeHash', 'ClaudeSessionId', 'Backfill', 'NanoAiu', 'QuerySource', 'LawCostUsd',
  ]
  const ts = new Date('2026-07-10T00:00:00Z')
  const row = (type: string, tokens: number) =>
    ['sid', 'gpt-4o', type, tokens, ts, 'resp_1', '', 'projhash', 'conv-9', '', todoubleEmpty(), '', todoubleEmpty()]
  // GenAI projects todouble('') → the SDK returns null for an empty real column.
  function todoubleEmpty() { return null }

  it('maps GenAI token rows to UsageRecords with model + conversation id, and NO nano_aiu', () => {
    const out = parseLogAnalyticsRows(COLS, [row('input', 1200), row('output', 340), row('cache-read', 5000)])
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ tokens: 1200, tokenType: 'input', model: 'gpt-4o', claudeSessionId: 'conv-9', projectCodeHash: 'projhash' })
    // Native GenAI carries no AI credits — cost stays §B, never invented here.
    expect(out.every((r) => r.nanoAiu === undefined)).toBe(true)
    expect(out.every((r) => r.organizationId === undefined)).toBe(true)
  })

  it('drops zero-token rows (a turn with no cache-write emits no cache-write row)', () => {
    const out = parseLogAnalyticsRows(COLS, [row('input', 900), row('cache-write', 0)])
    expect(out.map((r) => r.tokenType)).toEqual(['input'])
  })
})

describe('copilotNativeOtelEnabled flag', () => {
  const prev = process.env.NUXT_COPILOT_NATIVE_OTEL
  afterEach(() => {
    if (prev === undefined) delete process.env.NUXT_COPILOT_NATIVE_OTEL
    else process.env.NUXT_COPILOT_NATIVE_OTEL = prev
  })

  it('is OFF by default and only true for the exact "true" string', () => {
    delete process.env.NUXT_COPILOT_NATIVE_OTEL
    expect(copilotNativeOtelEnabled()).toBe(false)
    process.env.NUXT_COPILOT_NATIVE_OTEL = 'false'
    expect(copilotNativeOtelEnabled()).toBe(false)
    process.env.NUXT_COPILOT_NATIVE_OTEL = 'true'
    expect(copilotNativeOtelEnabled()).toBe(true)
  })
})
