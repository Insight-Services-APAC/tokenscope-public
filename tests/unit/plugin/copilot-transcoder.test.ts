/*
 * Copilot transcoder — two MANDATORY MERGE-BLOCKER tests.
 *
 * ⚠️  BLOCKER TEST 1 — DOUBLE-COUNT GUARD:
 *   A Copilot trace carries BOTH a parent `invoke_agent` span AND a child `chat`
 *   span with IDENTICAL token totals. transcodeChatSpans MUST emit ONLY the `chat`
 *   span. Counting both is a 2× silent overspend (locked decision §3.3, spec §4).
 *   This test is the ONLY machine-enforced guard against that regression.
 *
 * ⚠️  BLOCKER TEST 2 — RE-FORWARD IDEMPOTENCY:
 *   The file-forwarder may forward the same spans more than once (hook lifecycle
 *   guarantees at-least-once, NOT exactly-once). Transcoding + writing the SAME
 *   fixture spans twice MUST produce EXACTLY ONE record set because:
 *     ts_event = span endTime (stable)
 *     session.id = gen_ai.conversation.id (stable)
 *     request_id = spanId (stable)
 *   Together these reproduce the same dedup key, and the joiner's
 *   `ON CONFLICT DO NOTHING` on
 *   `UNIQUE (instance_id, COALESCE(claude_session_id,''), ts_event, token_type, model,
 *            COALESCE(source_run_id,''))` (migration 0017 + Slice 4 extension)
 *   makes the second write a no-op.
 *
 * Tests are pure (no network, no DB, no Azure).
 */
import { describe, it, expect } from 'vitest'
import {
  transcodeChatSpans,
  transcodeSignalSpans,
  buildCopilotOtlpPayload,
  encodeExportLogsServiceRequest,
} from '../../../plugin/scripts/otlp-logs.mjs'
import { SIGNAL_WIRE_COLUMNS } from '../../../server/azure/reader'

// ── fixture helpers ───────────────────────────────────────────────────────────

/** A pair of file-exporter-shape spans (chat + invoke_agent) from fixture s1. */
const FILE_EXPORTER_FIXTURE = [
  // chat span (authoritative per-call token counts — MUST be included)
  {
    type: 'span',
    traceId: '759c21a2e61b5b74dbab70522c76e39d',
    spanId: '6aa338d61c491603',
    parentSpanId: 'e8ecdf0d6299b9bc',
    name: 'chat claude-sonnet-4.6',
    startTime: [1780825134, 888845162],
    endTime: [1780825137, 573805196],
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'claude-sonnet-4.6',
      'gen_ai.conversation.id': 'e4dbfec0-ac93-4dd8-b953-ac8c13a8e2c7',
      'gen_ai.usage.input_tokens': 24278,
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.cache_creation_input_tokens': 24275,
      'github.copilot.nano_aiu': 9111525000,
    },
    resource: {
      attributes: {
        'tokenscope.instance_id': '11111111-2222-3333-4444-555555555555',
        'project.code_hash': 'abc123deadbeef',
        'tool': 'copilot-cli',
      },
    },
  },
  // invoke_agent span (session rollup — carries SAME token totals — MUST be EXCLUDED)
  {
    type: 'span',
    traceId: '759c21a2e61b5b74dbab70522c76e39d',
    spanId: 'e8ecdf0d6299b9bc',
    parentSpanId: '',
    name: 'invoke_agent',
    startTime: [1780825134, 112478593],
    endTime: [1780825137, 575133138],
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.request.model': 'claude-sonnet-4.6',
      'gen_ai.conversation.id': 'e4dbfec0-ac93-4dd8-b953-ac8c13a8e2c7',
      'gen_ai.usage.input_tokens': 24278,   // SAME totals as chat — double-count trap
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.cache_creation_input_tokens': 24275,
      'github.copilot.nano_aiu': 9111525000,
    },
    resource: {
      attributes: {
        'tokenscope.instance_id': '11111111-2222-3333-4444-555555555555',
        'project.code_hash': 'abc123deadbeef',
        'tool': 'copilot-cli',
      },
    },
  },
]

/** OTLP/HTTP wire-shape fixture from s2-wire-traces.json (chat + invoke_agent). */
const WIRE_SHAPE_SPANS = [
  // chat span — OTLP wire shape with [{key, value}] attributes
  {
    traceId: '32c644f027f5e6e6592e2ce210b0f6e4',
    spanId: '74744ebe38f16e43',
    parentSpanId: '55fc618ff6b10149',
    name: 'chat claude-sonnet-4.6',
    startTimeUnixNano: '1780825242668583338',
    endTimeUnixNano: '1780825244874165071',
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4.6' } },
      { key: 'gen_ai.conversation.id', value: { stringValue: '57252745-c54f-42e2-a75c-1bc95c08cb31' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '16924' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: '5' } },
      { key: 'gen_ai.usage.cache_creation_input_tokens', value: { intValue: '16921' } },
      { key: 'github.copilot.nano_aiu', value: { doubleValue: 6353775000 } },
    ],
    resource: { attributes: [
      { key: 'tokenscope.instance_id', value: { stringValue: '11111111-2222-3333-4444-555555555555' } },
    ]},
  },
  // invoke_agent span — MUST be excluded (same totals = double-count trap)
  {
    traceId: '32c644f027f5e6e6592e2ce210b0f6e4',
    spanId: '55fc618ff6b10149',
    parentSpanId: '',
    name: 'invoke_agent',
    startTimeUnixNano: '1780825241624453850',
    endTimeUnixNano: '1780825244876197237',
    attributes: [
      { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
      { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4.6' } },
      { key: 'gen_ai.conversation.id', value: { stringValue: '57252745-c54f-42e2-a75c-1bc95c08cb31' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '16924' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: '5' } },
      { key: 'gen_ai.usage.cache_creation_input_tokens', value: { intValue: '16921' } },
      { key: 'github.copilot.nano_aiu', value: { doubleValue: 6353775000 } },
    ],
    resource: { attributes: [
      { key: 'tokenscope.instance_id', value: { stringValue: '11111111-2222-3333-4444-555555555555' } },
    ]},
  },
]

const TEST_INSTANCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// ── BLOCKER TEST 1 — DOUBLE-COUNT GUARD ──────────────────────────────────────

describe('transcodeChatSpans — double-count guard (MERGE BLOCKER)', () => {
  it('file-exporter shape: emits ONLY the chat span, NOT the invoke_agent parent', () => {
    const records = transcodeChatSpans(FILE_EXPORTER_FIXTURE, { instanceId: TEST_INSTANCE_ID })

    // EXACTLY ONE record from this fixture (the chat span)
    expect(records).toHaveLength(1)

    const rec = records[0]
    // Must carry the chat span's identity
    expect(getAttr(rec.attributes, 'request_id')).toBe('6aa338d61c491603') // chat span id
    expect(getAttr(rec.attributes, 'session.id')).toBe('e4dbfec0-ac93-4dd8-b953-ac8c13a8e2c7')
    expect(getAttr(rec.attributes, 'model')).toBe('claude-sonnet-4.6')

    // Token counts from the chat span
    expect(getIntAttr(rec.attributes, 'input_tokens')).toBe(24278)
    expect(getIntAttr(rec.attributes, 'output_tokens')).toBe(5)
    expect(getIntAttr(rec.attributes, 'cache_creation_tokens')).toBe(24275)

    // event.name must be api_request (the shape the joiner reads)
    expect(getAttr(rec.attributes, 'event.name')).toBe('api_request')
    expect(rec.body?.stringValue).toBe('api_request')

    // AI credits carried for server-side pricing (NOT converted to USD here)
    const nanoAiu = getDoubleAttr(rec.attributes, 'github.copilot.nano_aiu')
    expect(nanoAiu).toBe(9111525000)
    // Verify that nano_aiu → credits = 9.11 (/ 1e9); cost at server = 9.11 × $0.01 ≈ $0.0911
    expect(nanoAiu / 1e9 * 0.01).toBeCloseTo(0.0911, 3)
  })

  it('OTLP/HTTP wire shape: emits ONLY the chat span, NOT the invoke_agent parent', () => {
    const records = transcodeChatSpans(WIRE_SHAPE_SPANS, { instanceId: TEST_INSTANCE_ID })

    expect(records).toHaveLength(1)

    const rec = records[0]
    expect(getAttr(rec.attributes, 'request_id')).toBe('74744ebe38f16e43') // chat span id
    expect(getAttr(rec.attributes, 'session.id')).toBe('57252745-c54f-42e2-a75c-1bc95c08cb31')
    expect(getIntAttr(rec.attributes, 'input_tokens')).toBe(16924)
    expect(getIntAttr(rec.attributes, 'output_tokens')).toBe(5)
    expect(getIntAttr(rec.attributes, 'cache_creation_tokens')).toBe(16921)
  })

  it('span with only execute_tool and plan operations produces zero records', () => {
    const nonChatSpans = [
      { type: 'span', name: 'execute_tool bash', spanId: 'aaa', attributes: { 'gen_ai.operation.name': 'execute_tool' } },
      { type: 'span', name: 'plan', spanId: 'bbb', attributes: { 'gen_ai.operation.name': 'plan' } },
    ]
    const records = transcodeChatSpans(nonChatSpans, { instanceId: TEST_INSTANCE_ID })
    expect(records).toHaveLength(0)
  })

  it('key tolerance: CLI-flat cache_creation_input_tokens (VERIFIED) and VS Code nested form', () => {
    const flatKeySpan = {
      type: 'span', name: 'chat model', spanId: 'flat1',
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.conversation.id': 'conv1',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 20,
        'gen_ai.usage.cache_creation_input_tokens': 80, // CLI FLAT (VERIFIED)
      },
    }
    const nestedKeySpan = {
      type: 'span', name: 'chat model', spanId: 'nest1',
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.conversation.id': 'conv2',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 20,
        'gen_ai.usage.cache_creation.input_tokens': 80, // VS Code nested
      },
    }
    const flatRecs = transcodeChatSpans([flatKeySpan], { instanceId: TEST_INSTANCE_ID })
    const nestedRecs = transcodeChatSpans([nestedKeySpan], { instanceId: TEST_INSTANCE_ID })
    expect(getIntAttr(flatRecs[0].attributes, 'cache_creation_tokens')).toBe(80)
    expect(getIntAttr(nestedRecs[0].attributes, 'cache_creation_tokens')).toBe(80)
  })

  it('throws if instanceId is missing (security invariant)', () => {
    expect(() => transcodeChatSpans(FILE_EXPORTER_FIXTURE, {})).toThrow(/instanceId is required/)
  })
})

// ── BLOCKER TEST 2 — RE-FORWARD IDEMPOTENCY ───────────────────────────────────

describe('transcodeChatSpans — re-forward idempotency (MERGE BLOCKER)', () => {
  it('transcoding + encoding the SAME fixture twice produces IDENTICAL protobuf bytes', () => {
    // The dedup key is: (instance_id, COALESCE(claude_session_id,''), ts_event,
    //   token_type, model, COALESCE(source_run_id,''))
    // ts_event = span endTime (stable across re-forwards)
    // session.id = gen_ai.conversation.id (stable)
    // request_id / source_run_id = spanId (stable)
    // → identical bytes → ON CONFLICT DO NOTHING → exactly one row
    const spans = FILE_EXPORTER_FIXTURE.filter((s) => s.attributes['gen_ai.operation.name'] === 'chat')

    const records1 = transcodeChatSpans(spans, { instanceId: TEST_INSTANCE_ID, projectCodeHash: 'abc' })
    const records2 = transcodeChatSpans(spans, { instanceId: TEST_INSTANCE_ID, projectCodeHash: 'abc' })

    const payload1 = buildCopilotOtlpPayload(records1, TEST_INSTANCE_ID, 'abc')
    const payload2 = buildCopilotOtlpPayload(records2, TEST_INSTANCE_ID, 'abc')

    const proto1 = encodeExportLogsServiceRequest(payload1)
    const proto2 = encodeExportLogsServiceRequest(payload2)

    // Byte-identical protobuf → identical dedup tuple → DB dedup = exactly one row
    expect(proto1).toEqual(proto2)
  })

  it('timeUnixNano is derived from span endTime (not wall clock) — stable across re-forwards', () => {
    const chatSpan = FILE_EXPORTER_FIXTURE[0]
    const records = transcodeChatSpans([chatSpan], { instanceId: TEST_INSTANCE_ID })

    // endTime = [1780825137, 573805196] → nanos = 1780825137 * 1e9 + 573805196
    const expectedNs = BigInt(1780825137) * 1000000000n + BigInt(573805196)
    expect(BigInt(records[0].timeUnixNano)).toBe(expectedNs)
  })

  it('wire-shape span: timeUnixNano from endTimeUnixNano string', () => {
    const chatSpan = WIRE_SHAPE_SPANS[0]
    const records = transcodeChatSpans([chatSpan], { instanceId: TEST_INSTANCE_ID })
    expect(BigInt(records[0].timeUnixNano)).toBe(BigInt('1780825244874165071'))
  })

  it('resource attributes carry the server-attested instanceId, NOT the span value', () => {
    const ATTESTED = 'ffff0000-0000-0000-0000-000000000001'
    const records = transcodeChatSpans(FILE_EXPORTER_FIXTURE, { instanceId: ATTESTED })
    const payload = buildCopilotOtlpPayload(records, ATTESTED, null)

    // Resource attrs must carry our attested ID, not the fixture's span value
    const resAttrs = payload.resourceLogs[0].resource.attributes
    const instId = resAttrs.find((a: { key: string }) => a.key === 'tokenscope.instance_id')
    expect(instId?.value?.stringValue).toBe(ATTESTED)
    // The fixture spans carry '11111111-...' — must NOT appear in resource attrs
    expect(instId?.value?.stringValue).not.toBe('11111111-2222-3333-4444-555555555555')
  })

  it('untagged: no project.code_hash → project.code_hash absent from resource attrs', () => {
    const records = transcodeChatSpans(FILE_EXPORTER_FIXTURE.slice(0, 1), { instanceId: TEST_INSTANCE_ID })
    const payload = buildCopilotOtlpPayload(records, TEST_INSTANCE_ID, null)
    const resAttrs = payload.resourceLogs[0].resource.attributes
    const projAttr = resAttrs.find((a: { key: string }) => a.key === 'project.code_hash')
    expect(projAttr).toBeUndefined()
  })

  it('tagged: project.code_hash in resource attrs when projectCodeHash is set', () => {
    const records = transcodeChatSpans(FILE_EXPORTER_FIXTURE.slice(0, 1), { instanceId: TEST_INSTANCE_ID })
    const payload = buildCopilotOtlpPayload(records, TEST_INSTANCE_ID, 'deadbeef12345678')
    const resAttrs = payload.resourceLogs[0].resource.attributes
    const projAttr = resAttrs.find((a: { key: string }) => a.key === 'project.code_hash')
    expect(projAttr?.value?.stringValue).toBe('deadbeef12345678')
  })

  it('tool attribute is always copilot-cli', () => {
    const records = transcodeChatSpans(FILE_EXPORTER_FIXTURE.slice(0, 1), { instanceId: TEST_INSTANCE_ID })
    const payload = buildCopilotOtlpPayload(records, TEST_INSTANCE_ID, null)
    const resAttrs = payload.resourceLogs[0].resource.attributes
    const toolAttr = resAttrs.find((a: { key: string }) => a.key === 'tool')
    expect(toolAttr?.value?.stringValue).toBe('copilot-cli')
  })

  it('org stamp: github.org + github.repository in resource attrs when githubOrg is set (F2 keying)', () => {
    const records = transcodeChatSpans(FILE_EXPORTER_FIXTURE.slice(0, 1), { instanceId: TEST_INSTANCE_ID })
    const payload = buildCopilotOtlpPayload(records, TEST_INSTANCE_ID, null, { githubOrg: 'insight-services-apac' })
    const resAttrs = payload.resourceLogs[0].resource.attributes
    const org = resAttrs.find((a: { key: string }) => a.key === 'github.org')
    const repo = resAttrs.find((a: { key: string }) => a.key === 'github.repository')
    expect(org?.value?.stringValue).toBe('insight-services-apac')
    expect(repo?.value?.stringValue).toBe('insight-services-apac')
  })

  it('org stamp: omitted when githubOrg is null/absent (untagged-enterprise is acceptable)', () => {
    const records = transcodeChatSpans(FILE_EXPORTER_FIXTURE.slice(0, 1), { instanceId: TEST_INSTANCE_ID })
    // No opts at all (back-compat) and explicit null both omit the org attrs.
    for (const payload of [
      buildCopilotOtlpPayload(records, TEST_INSTANCE_ID, null),
      buildCopilotOtlpPayload(records, TEST_INSTANCE_ID, null, { githubOrg: null }),
    ]) {
      const resAttrs = payload.resourceLogs[0].resource.attributes
      expect(resAttrs.find((a: { key: string }) => a.key === 'github.org')).toBeUndefined()
      expect(resAttrs.find((a: { key: string }) => a.key === 'github.repository')).toBeUndefined()
    }
  })
})

// ── L4 — M2 regression: string + garbage token counts (L3/L4 guard) ───────────
// Ensures resolveTokenCount never throws — a throw propagates through
// transcodeChatSpans and, since readNewSpans advances the file offset BEFORE
// transcoding, the whole batch would be permanently lost (the M2 batch-loss bug).
// Tests use adversarial token-count strings that were previously missing coverage.

describe('resolveTokenCount — batch-loss prevention (L3/L4 regression)', () => {
  const makeSpan = (overrides: Record<string, unknown>) => ({
    type: 'span',
    name: 'chat model',
    spanId: 'aaaa1111',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'copilot/claude-sonnet-4-6',
      'gen_ai.conversation.id': 'conv-string-tokens',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 5,
      'github.copilot.nano_aiu': 1000000000,
      ...overrides,
    },
  })

  it('float-string token count ("24278.0") — transcodes without throwing, rounds to integer', () => {
    const span = makeSpan({ 'gen_ai.usage.input_tokens': '24278.0' })
    // Must not throw — the key invariant: batch survives one bad attribute
    expect(() => transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })).not.toThrow()
    const records = transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })
    expect(records).toHaveLength(1)
    expect(getIntAttr(records[0].attributes, 'input_tokens')).toBe(24278)
  })

  it('garbage-string token count ("abc") — degrades to 0, batch survives (no throw)', () => {
    const span = makeSpan({ 'gen_ai.usage.input_tokens': 'abc' })
    expect(() => transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })).not.toThrow()
    const records = transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })
    expect(records).toHaveLength(1)
    // Graceful degradation: bad count → 0 (not throw)
    expect(getIntAttr(records[0].attributes, 'input_tokens')).toBe(0)
  })

  it('"NaN" token count — degrades to 0, batch survives (BigInt(NaN) would throw)', () => {
    const span = makeSpan({ 'gen_ai.usage.output_tokens': 'NaN' })
    expect(() => transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })).not.toThrow()
    const records = transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })
    expect(records).toHaveLength(1)
    expect(getIntAttr(records[0].attributes, 'output_tokens')).toBe(0)
  })

  it('negative token count ("-5") — degrades to 0 (invalid; positive counts only)', () => {
    const span = makeSpan({ 'gen_ai.usage.input_tokens': '-5' })
    expect(() => transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })).not.toThrow()
    const records = transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })
    expect(records).toHaveLength(1)
    expect(getIntAttr(records[0].attributes, 'input_tokens')).toBe(0)
  })

  it('integer-string token count ("16924") — still uses BigInt precision path', () => {
    // Pure integer strings must continue to use the BigInt precision path
    // (avoids Number() rounding above 2^53).
    const span = makeSpan({ 'gen_ai.usage.input_tokens': '16924' })
    const records = transcodeChatSpans([span], { instanceId: TEST_INSTANCE_ID })
    expect(records).toHaveLength(1)
    expect(getIntAttr(records[0].attributes, 'input_tokens')).toBe(16924)
  })
})

// ── R1/R2 — sibling numeric paths: nano_aiu (double) + timestamps ──────────────
// The token-count guard above is one of THREE numeric emit paths. A garbage
// nano_aiu was shipped as a NaN double (silent server-side cost loss); a garbage
// timestamp threw in BigInt() (whole-batch loss, same class as the token bug). The
// single numeric chokepoint (safeNonNegNumber + garbage-safe resolveTimeUnixNano)
// closes both; these pin it so neither regresses.

describe('nano_aiu — garbage drops the attr, never ships a NaN double (R2)', () => {
  const makeSpan = (nano: unknown) => ({
    type: 'span', name: 'chat model', spanId: 'bbbb2222',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'copilot/claude-sonnet-4-6',
      'gen_ai.conversation.id': 'conv-nano',
      'gen_ai.usage.input_tokens': 100,
      'github.copilot.nano_aiu': nano,
    },
  })
  const nanoAttr = (recs: { attributes: KVAttr[] }[]) =>
    recs[0].attributes.find((a) => a.key === 'github.copilot.nano_aiu')

  it('valid nano_aiu is carried as a double', () => {
    const recs = transcodeChatSpans([makeSpan(1_000_000_000)], { instanceId: TEST_INSTANCE_ID })
    expect(getDoubleAttr(recs[0].attributes, 'github.copilot.nano_aiu')).toBe(1_000_000_000)
  })

  it.each(['NaN', 'abc', '-5', 'Infinity'])(
    'garbage nano_aiu (%s) → attr OMITTED, not shipped as a NaN double',
    (bad) => {
      const recs = transcodeChatSpans([makeSpan(bad)], { instanceId: TEST_INSTANCE_ID })
      expect(recs).toHaveLength(1)
      expect(nanoAttr(recs)).toBeUndefined()
    },
  )
})

describe('resolveTimeUnixNano — garbage timestamp never throws (R1 batch-loss)', () => {
  const makeSpan = (endTime: unknown) => ({
    type: 'span', name: 'chat model', spanId: 'cccc3333', endTime,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'copilot/claude-sonnet-4-6',
      'gen_ai.conversation.id': 'conv-ts',
      'gen_ai.usage.input_tokens': 100,
    },
  })

  it.each(['abc', 'NaN', '-100', 'Infinity', '12.5e3'])(
    'garbage endTime (%s) → no throw, batch survives, time is a positive nanos string',
    (bad) => {
      expect(() => transcodeChatSpans([makeSpan(bad)], { instanceId: TEST_INSTANCE_ID })).not.toThrow()
      const recs = transcodeChatSpans([makeSpan(bad)], { instanceId: TEST_INSTANCE_ID })
      expect(recs).toHaveLength(1)
      expect(BigInt(recs[0].timeUnixNano)).toBeGreaterThan(0n)
    },
  )

  it('valid nanosecond-string endTime is preserved exactly', () => {
    const recs = transcodeChatSpans([makeSpan('1780825137573805196')], { instanceId: TEST_INSTANCE_ID })
    expect(recs[0].timeUnixNano).toBe('1780825137573805196')
  })
})

// ── query_source — main-vs-aux lane (aux-overhead detector activation) ─────────
// The reader parses `Attributes['query_source']` (reader.ts:~293 `_qsrc`) and the
// aux-overhead detector (insights.ts:353) splits 'main' vs any other non-NULL
// value (NULL excluded). Before this fix the Copilot transcoder never emitted the
// attr → every Copilot record's query_source was NULL → the detector silently
// never fired for Copilot users. The Copilot signal is `github.copilot.initiator`
// on the `chat` span ('user' → main; otherwise → aux). Default 'main' when absent.

describe('transcodeChatSpans — query_source (aux-overhead activation)', () => {
  const makeChatSpan = (overrides: Record<string, unknown>) => ({
    type: 'span',
    name: 'chat claude-sonnet-4.6',
    spanId: 'qsrc-span-1',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'claude-sonnet-4.6',
      'gen_ai.conversation.id': 'conv-qsrc',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      ...overrides,
    },
  })

  it("user-initiated chat → query_source 'main'", () => {
    // Evidence: docs/background/copilot-otel-spike/s1-file-exporter.jsonl line 1
    // carries "github.copilot.initiator":"user" on the chat span.
    const recs = transcodeChatSpans([makeChatSpan({ 'github.copilot.initiator': 'user' })], {
      instanceId: TEST_INSTANCE_ID,
    })
    expect(recs).toHaveLength(1)
    expect(getAttr(recs[0].attributes, 'query_source')).toBe('main')
  })

  it("auto-initiated chat → query_source 'auto' (the aux lane the detector counts)", () => {
    // 'auto' is the Copilot analogue of Claude's aux lanes (e.g.
    // side_question): a system/background call, not the user's
    // conversation. The detector keys only on '== main' vs not.
    const recs = transcodeChatSpans([makeChatSpan({ 'github.copilot.initiator': 'auto' })], {
      instanceId: TEST_INSTANCE_ID,
    })
    expect(recs).toHaveLength(1)
    const qs = getAttr(recs[0].attributes, 'query_source')
    expect(qs).toBe('auto')
    // Contract with the detector: a non-'main', non-null value counts as aux.
    expect(qs).not.toBe('main')
    expect(qs).not.toBeUndefined()
  })

  it("initiator absent → defaults to 'main' (tolerant; schema matches Claude)", () => {
    // The wire attr MUST always be present so the joiner never stores NULL for a
    // Copilot record solely because the signal was missing (the original bug was
    // a MISSING field, distinct from a legitimately unknown lane).
    const recs = transcodeChatSpans([makeChatSpan({})], { instanceId: TEST_INSTANCE_ID })
    expect(recs).toHaveLength(1)
    expect(getAttr(recs[0].attributes, 'query_source')).toBe('main')
  })

  it('query_source is emitted on EVERY chat record (never silently absent)', () => {
    // Regression guard for the latent bug: the attr must be present regardless of
    // the initiator signal, so the reader's `_qsrc` is never NULL-by-omission.
    const recs = transcodeChatSpans(
      [
        makeChatSpan({ 'github.copilot.initiator': 'user', 'gen_ai.conversation.id': 'c1' }),
        makeChatSpan({ 'github.copilot.initiator': 'auto', 'gen_ai.conversation.id': 'c2' }),
        makeChatSpan({ 'gen_ai.conversation.id': 'c3' }),
      ].map((s, i) => ({ ...s, spanId: `qsrc-emit-${i}` })),
      { instanceId: TEST_INSTANCE_ID },
    )
    expect(recs).toHaveLength(3)
    for (const r of recs) {
      expect(getAttr(r.attributes, 'query_source')).toBeDefined()
    }
  })

  it('wire-shape chat span: derives query_source from the [{key,value}] attr form', () => {
    const wireSpan = {
      name: 'chat claude-sonnet-4.6',
      spanId: 'wire-qsrc-1',
      endTimeUnixNano: '1780825244874165071',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4.6' } },
        { key: 'gen_ai.conversation.id', value: { stringValue: 'wire-conv' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
        { key: 'github.copilot.initiator', value: { stringValue: 'auto' } },
      ],
    }
    const recs = transcodeChatSpans([wireSpan], { instanceId: TEST_INSTANCE_ID })
    expect(recs).toHaveLength(1)
    expect(getAttr(recs[0].attributes, 'query_source')).toBe('auto')
  })
})

// ── transcodeSignalSpans — behavioural usage signals (NON-billing lane) ────────
// Copilot spans carry behavioural signals (tool/MCP surface, context saturation,
// turn churn) that drive the MS token-efficiency nudges. transcodeSignalSpans
// emits them as a SEPARATE event.name='usage_signal' stream with NO token attrs,
// so the token reader never sees them and billing carries zero risk.
// Source mapping is 1:1 (design: docs/design/copilot-usage-signals.md):
//   chat → tool_count (gen_ai.tool.definitions len) + ctx_pct (usage_info event)
//   invoke_agent → mcp_count (mcp_server_names len) + turn_count

const TOOL_DEFS = (n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ type: 'function', name: `t${i}` })))

const makeSignalChatSpan = (overrides: Record<string, unknown> = {}, events?: unknown) => ({
  type: 'span',
  name: 'chat claude-sonnet-4.6',
  spanId: 'sig-chat-1',
  endTime: [1780825137, 573805196],
  attributes: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.conversation.id': 'sig-conv',
    'gen_ai.tool.definitions': TOOL_DEFS(38),
    ...overrides,
  },
  events: events ?? [
    {
      name: 'github.copilot.session.usage_info',
      attributes: {
        'github.copilot.token_limit': 200000,
        'github.copilot.current_tokens': 24273,
        'github.copilot.messages_length': 2,
      },
    },
  ],
})

const makeSignalInvokeSpan = (overrides: Record<string, unknown> = {}) => ({
  type: 'span',
  name: 'invoke_agent',
  spanId: 'sig-invoke-1',
  endTime: [1780825137, 575133138],
  attributes: {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.conversation.id': 'sig-conv',
    'gen_ai.tool.definitions': TOOL_DEFS(38),
    'github.copilot.context.mcp_server_names': JSON.stringify(['a', 'b', 'c', 'd']),
    'github.copilot.turn_count': 7,
    ...overrides,
  },
})

describe('transcodeSignalSpans — chat-span signals (tool_count + ctx_pct)', () => {
  it('emits tool_count (array length) and ctx_pct (current/limit) on a usage_signal record', () => {
    const recs = transcodeSignalSpans([makeSignalChatSpan()], { instanceId: TEST_INSTANCE_ID })
    expect(recs).toHaveLength(1)
    const rec = recs[0]
    expect(getAttr(rec.attributes, 'event.name')).toBe('usage_signal')
    expect(rec.body?.stringValue).toBe('usage_signal')
    expect(getIntAttr(rec.attributes, 'sig.tool_count')).toBe(38)
    // 24273 / 200000 = 12.1% → round → 12
    expect(getIntAttr(rec.attributes, 'sig.ctx_pct')).toBe(12)
    // dedup identity carried
    expect(getAttr(rec.attributes, 'request_id')).toBe('sig-chat-1')
    expect(getAttr(rec.attributes, 'session.id')).toBe('sig-conv')
  })

  it('carries NO token attributes (token reader must never pick up a signal record)', () => {
    const recs = transcodeSignalSpans([makeSignalChatSpan()], { instanceId: TEST_INSTANCE_ID })
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
      expect(recs[0].attributes.find((a) => a.key === key)).toBeUndefined()
    }
    // and is not an api_request
    expect(getAttr(recs[0].attributes, 'event.name')).not.toBe('api_request')
  })

  it('ctx_pct caps at 100 when current exceeds limit', () => {
    const recs = transcodeSignalSpans(
      [
        makeSignalChatSpan({}, [
          {
            name: 'github.copilot.session.usage_info',
            attributes: { 'github.copilot.token_limit': 200000, 'github.copilot.current_tokens': 210000 },
          },
        ]),
      ],
      { instanceId: TEST_INSTANCE_ID },
    )
    expect(getIntAttr(recs[0].attributes, 'sig.ctx_pct')).toBe(100)
  })

  it('omits ctx_pct when usage_info event is absent (still emits tool_count)', () => {
    const recs = transcodeSignalSpans([makeSignalChatSpan({}, [])], { instanceId: TEST_INSTANCE_ID })
    expect(recs).toHaveLength(1)
    expect(getIntAttr(recs[0].attributes, 'sig.tool_count')).toBe(38)
    expect(recs[0].attributes.find((a) => a.key === 'sig.ctx_pct')).toBeUndefined()
  })

  it('omits ctx_pct when token_limit is 0 (no divide-by-zero)', () => {
    const recs = transcodeSignalSpans(
      [
        makeSignalChatSpan({}, [
          {
            name: 'github.copilot.session.usage_info',
            attributes: { 'github.copilot.token_limit': 0, 'github.copilot.current_tokens': 100 },
          },
        ]),
      ],
      { instanceId: TEST_INSTANCE_ID },
    )
    expect(recs[0].attributes.find((a) => a.key === 'sig.ctx_pct')).toBeUndefined()
  })

  it('garbage tool.definitions (not a JSON array) → tool_count omitted, never throws', () => {
    expect(() =>
      transcodeSignalSpans([makeSignalChatSpan({ 'gen_ai.tool.definitions': 'not-json' }, [])], {
        instanceId: TEST_INSTANCE_ID,
      }),
    ).not.toThrow()
    const recs = transcodeSignalSpans(
      [makeSignalChatSpan({ 'gen_ai.tool.definitions': 'not-json' }, [])],
      { instanceId: TEST_INSTANCE_ID },
    )
    // no tool_count and no ctx_pct → no signals → no record at all
    expect(recs).toHaveLength(0)
  })
})

describe('transcodeSignalSpans — invoke_agent signals (mcp_count + turn_count)', () => {
  it('emits mcp_count and turn_count from the invoke_agent span', () => {
    const recs = transcodeSignalSpans([makeSignalInvokeSpan()], { instanceId: TEST_INSTANCE_ID })
    expect(recs).toHaveLength(1)
    expect(getIntAttr(recs[0].attributes, 'sig.mcp_count')).toBe(4)
    expect(getIntAttr(recs[0].attributes, 'sig.turn_count')).toBe(7)
    expect(getAttr(recs[0].attributes, 'request_id')).toBe('sig-invoke-1')
  })

  it('does NOT emit tool_count from invoke_agent (chat is the sole source — no double-count)', () => {
    const recs = transcodeSignalSpans([makeSignalInvokeSpan()], { instanceId: TEST_INSTANCE_ID })
    expect(recs[0].attributes.find((a) => a.key === 'sig.tool_count')).toBeUndefined()
  })

  it('garbage turn_count → omitted, never throws', () => {
    expect(() =>
      transcodeSignalSpans([makeSignalInvokeSpan({ 'github.copilot.turn_count': 'NaN' })], {
        instanceId: TEST_INSTANCE_ID,
      }),
    ).not.toThrow()
    const recs = transcodeSignalSpans(
      [makeSignalInvokeSpan({ 'github.copilot.turn_count': 'NaN' })],
      { instanceId: TEST_INSTANCE_ID },
    )
    // mcp_count still present
    expect(getIntAttr(recs[0].attributes, 'sig.mcp_count')).toBe(4)
    expect(recs[0].attributes.find((a) => a.key === 'sig.turn_count')).toBeUndefined()
  })
})

describe('transcodeSignalSpans — wire-contract drift guard (emit ↔ parse)', () => {
  // The transcoder hardcodes 'sig.*' keys; the reader maps them via SIGNAL_WIRE_COLUMNS.
  // No shared constant crosses the .mjs/.ts boundary, so pin them here: every key the
  // transcoder emits MUST be a value the reader knows how to parse, and every signal the
  // reader expects MUST be emitted by at least one span type. A rename on either side
  // fails THIS test instead of silently emptying the lane in production.
  it('every emitted sig.* key is a known SIGNAL_WIRE_COLUMNS value, and all are covered', () => {
    const emitted = new Set<string>()
    for (const rec of transcodeSignalSpans([makeSignalChatSpan(), makeSignalInvokeSpan()], {
      instanceId: TEST_INSTANCE_ID,
    })) {
      for (const a of rec.attributes) if (a.key.startsWith('sig.')) emitted.add(a.key)
    }
    const known = new Set(Object.values(SIGNAL_WIRE_COLUMNS))
    // 1) no emitted key the reader can't parse
    for (const k of emitted) expect(known.has(k), `reader has no column for emitted key ${k}`).toBe(true)
    // 2) every reader-known signal is emitted by the fixtures (full coverage)
    for (const k of known) expect(emitted.has(k), `no span emits reader-known key ${k}`).toBe(true)
  })
})

describe('transcodeSignalSpans — stream separation + idempotency', () => {
  it('a chat + invoke_agent pair yields ONE token record and TWO signal records', () => {
    const spans = [makeSignalChatSpan(), makeSignalInvokeSpan()]
    const tokenRecs = transcodeChatSpans(spans, { instanceId: TEST_INSTANCE_ID })
    const signalRecs = transcodeSignalSpans(spans, { instanceId: TEST_INSTANCE_ID })
    // token path: only the chat span (invoke_agent dropped — §3.3)
    expect(tokenRecs).toHaveLength(1)
    expect(getAttr(tokenRecs[0].attributes, 'event.name')).toBe('api_request')
    // signal path: one record per source span (chat + invoke_agent)
    expect(signalRecs).toHaveLength(2)
    for (const r of signalRecs) expect(getAttr(r.attributes, 'event.name')).toBe('usage_signal')
  })

  it('non-chat/non-invoke spans (execute_tool, plan) produce zero signal records', () => {
    const recs = transcodeSignalSpans(
      [
        { type: 'span', name: 'execute_tool bash', spanId: 'x', attributes: { 'gen_ai.operation.name': 'execute_tool' } },
        { type: 'span', name: 'plan', spanId: 'y', attributes: { 'gen_ai.operation.name': 'plan' } },
      ],
      { instanceId: TEST_INSTANCE_ID },
    )
    expect(recs).toHaveLength(0)
  })

  it('re-forward idempotency: same spans twice → identical records (stable spanId + endTime)', () => {
    const spans = [makeSignalChatSpan(), makeSignalInvokeSpan()]
    const a = transcodeSignalSpans(spans, { instanceId: TEST_INSTANCE_ID })
    const b = transcodeSignalSpans(spans, { instanceId: TEST_INSTANCE_ID })
    expect(a).toEqual(b)
  })

  it('wire-shape invoke_agent span: derives mcp_count + turn_count from [{key,value}] attrs', () => {
    const wireInvoke = {
      name: 'invoke_agent',
      spanId: 'wire-invoke-1',
      endTimeUnixNano: '1780825244876197237',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
        { key: 'github.copilot.context.mcp_server_names', value: { stringValue: '["x","y"]' } },
        { key: 'github.copilot.turn_count', value: { intValue: '3' } },
      ],
    }
    const recs = transcodeSignalSpans([wireInvoke], { instanceId: TEST_INSTANCE_ID })
    expect(recs).toHaveLength(1)
    expect(getIntAttr(recs[0].attributes, 'sig.mcp_count')).toBe(2)
    expect(getIntAttr(recs[0].attributes, 'sig.turn_count')).toBe(3)
  })

  it('throws if instanceId is missing (security invariant, mirrors token path)', () => {
    expect(() => transcodeSignalSpans([makeSignalChatSpan()], {})).toThrow(/instanceId is required/)
  })
})

// ── attribute helpers ─────────────────────────────────────────────────────────

type KVAttr = { key: string; value: { stringValue?: string; intValue?: string | number; doubleValue?: number } }

function getAttr(attrs: KVAttr[], key: string): string | undefined {
  return attrs.find((a) => a.key === key)?.value?.stringValue
}

function getIntAttr(attrs: KVAttr[], key: string): number | undefined {
  const a = attrs.find((a) => a.key === key)
  if (!a) return undefined
  const v = a.value.intValue
  return v !== undefined ? Number(v) : undefined
}

function getDoubleAttr(attrs: KVAttr[], key: string): number | undefined {
  const a = attrs.find((a) => a.key === key)
  if (!a) return undefined
  const v = a.value.doubleValue
  return v !== undefined ? Number(v) : undefined
}
