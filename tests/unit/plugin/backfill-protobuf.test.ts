/*
 * /tokenscope:backfill — OTLP/protobuf wire-format unit tests (durable emission
 * auth). Proves the hand-rolled encoder produces a valid ExportLogsServiceRequest
 * that decodes back IDENTICALLY to what the joiner (server/azure/reader.ts) reads
 * out of the OTelLogs table: resource attrs as strings, token counts as int64,
 * cost as double, body/event.name as strings, time_unix_nano as fixed64.
 *
 * We use a tiny INLINE protobuf decoder (not @opentelemetry/*, which the plugin
 * must never depend on) so the round-trip is self-contained and the test fails
 * loudly if a field number / wire type drifts from the OTLP schema subset.
 *
 * Pure: no network, no live OTLP endpoint.
 */
import { describe, it, expect } from 'vitest'
import {
  recordFromTranscriptLine,
  buildOtlpLogsPayload,
  encodeExportLogsServiceRequest,
} from '../../../plugin/scripts/backfill.mjs'

// ── tiny inline protobuf decoder (wireType 0/1/2 only) ──────────────────────
type Field = { wireType: number; value: bigint | Buffer }

function readVarint(buf: Buffer, pos: number): { value: bigint; pos: number } {
  let result = 0n
  let shift = 0n
  let p = pos
  for (;;) {
    const byte = buf[p++]
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7n
  }
  return { value: result, pos: p }
}

/** Decode a message into a map of fieldNumber → Field[] (repeated-aware). */
function decodeMessage(buf: Buffer): Map<number, Field[]> {
  const out = new Map<number, Field[]>()
  let pos = 0
  while (pos < buf.length) {
    const t = readVarint(buf, pos)
    pos = t.pos
    const fieldNumber = Number(t.value >> 3n)
    const wireType = Number(t.value & 0x7n)
    let value: bigint | Buffer
    if (wireType === 0) {
      const v = readVarint(buf, pos)
      value = v.value
      pos = v.pos
    } else if (wireType === 1) {
      value = buf.subarray(pos, pos + 8)
      pos += 8
    } else if (wireType === 2) {
      const len = readVarint(buf, pos)
      pos = len.pos
      const end = pos + Number(len.value)
      value = buf.subarray(pos, end)
      pos = end
    } else {
      throw new Error(`unsupported wireType ${wireType}`)
    }
    const list = out.get(fieldNumber) ?? []
    list.push({ wireType, value })
    out.set(fieldNumber, list)
  }
  return out
}

const asBuf = (f: Field) => f.value as Buffer
const str = (b: Buffer) => b.toString('utf8')

/** Decode an AnyValue → { kind, value }. */
function decodeAnyValue(buf: Buffer): { kind: string; value: unknown } {
  const m = decodeMessage(buf)
  if (m.has(1)) return { kind: 'string', value: str(asBuf(m.get(1)![0])) }
  if (m.has(2)) return { kind: 'bool', value: (m.get(2)![0].value as bigint) !== 0n }
  if (m.has(3)) return { kind: 'int', value: m.get(3)![0].value as bigint }
  if (m.has(4)) return { kind: 'double', value: (asBuf(m.get(4)![0])).readDoubleLE(0) }
  throw new Error('AnyValue had no recognised oneof field')
}

/** Decode a KeyValue → [key, AnyValue]. */
function decodeKeyValue(buf: Buffer): { key: string; value: { kind: string; value: unknown } } {
  const m = decodeMessage(buf)
  return { key: str(asBuf(m.get(1)![0])), value: decodeAnyValue(asBuf(m.get(2)![0])) }
}

function decodeAttrs(fields: Field[] | undefined) {
  const out: Record<string, { kind: string; value: unknown }> = {}
  for (const f of fields ?? []) {
    const kv = decodeKeyValue(asBuf(f))
    out[kv.key] = kv.value
  }
  return out
}

describe('encodeExportLogsServiceRequest — wire-format round trip', () => {
  const TS = '2026-05-15T11:00:00Z'
  const rec = recordFromTranscriptLine(
    JSON.stringify({
      type: 'assistant',
      timestamp: TS,
      requestId: 'req_42',
      sessionId: 'sess-xyz',
      message: {
        model: 'claude-opus-4-8',
        id: 'msg_1',
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cache_read_input_tokens: 33,
          cache_creation_input_tokens: 44,
        },
      },
      costUSD: 0.0123,
    }),
  )!
  const payload = buildOtlpLogsPayload([rec], {
    'tokenscope.instance_id': 'inst-1',
    'project.code_hash': 'h1',
    tool: 'claude-code',
  })
  const bytes = encodeExportLogsServiceRequest(payload)

  it('produces a valid ExportLogsServiceRequest (field 1 = resource_logs)', () => {
    expect(Buffer.isBuffer(bytes)).toBe(true)
    const top = decodeMessage(bytes)
    expect(top.has(1)).toBe(true) // resource_logs
    expect(top.get(1)!.length).toBe(1) // one ResourceLogs
    // No stray top-level fields.
    expect([...top.keys()]).toEqual([1])
  })

  it('round-trips the resource attribute tokenscope.instance_id (+ backfill provenance)', () => {
    const top = decodeMessage(bytes)
    const resourceLogs = decodeMessage(asBuf(top.get(1)![0]))
    const resource = decodeMessage(asBuf(resourceLogs.get(1)![0])) // Resource resource = 1
    const attrs = decodeAttrs(resource.get(1)) // repeated KeyValue attributes = 1
    expect(attrs['tokenscope.instance_id']).toEqual({ kind: 'string', value: 'inst-1' })
    expect(attrs['project.code_hash']).toEqual({ kind: 'string', value: 'h1' })
    // Provenance stamp — non-reconciled / advisory.
    expect(attrs['tokenscope.backfill']).toEqual({ kind: 'string', value: 'true' })
  })

  it('round-trips the log record time_unix_nano (fixed64), int token attr, double cost, and body', () => {
    const top = decodeMessage(bytes)
    const resourceLogs = decodeMessage(asBuf(top.get(1)![0]))
    const scopeLogs = decodeMessage(asBuf(resourceLogs.get(2)![0])) // ScopeLogs scope_logs = 2
    const logRecord = decodeMessage(asBuf(scopeLogs.get(2)![0])) // LogRecord log_records = 2

    // time_unix_nano (fixed64, field 1) = original timestamp in unix nanos.
    const timeField = logRecord.get(1)![0]
    expect(timeField.wireType).toBe(1)
    const nanos = (timeField.value as Buffer).readBigUInt64LE(0)
    expect(nanos).toBe(BigInt(new Date(TS).getTime()) * 1_000_000n)

    // body (AnyValue, field 5) = 'api_request' string.
    const body = decodeAnyValue(asBuf(logRecord.get(5)![0]))
    expect(body).toEqual({ kind: 'string', value: 'api_request' })

    // log-record attributes (field 6).
    const attrs = decodeAttrs(logRecord.get(6))
    // event.name string — the joiner's primary api_request selector.
    expect(attrs['event.name']).toEqual({ kind: 'string', value: 'api_request' })
    // output_tokens encoded as int64 (joiner reads tolong(...)).
    expect(attrs['output_tokens']).toEqual({ kind: 'int', value: 22n })
    expect(attrs['input_tokens']).toEqual({ kind: 'int', value: 11n })
    expect(attrs['cache_read_tokens']).toEqual({ kind: 'int', value: 33n })
    expect(attrs['cache_creation_tokens']).toEqual({ kind: 'int', value: 44n })
    // cost_usd encoded as double (joiner reads todouble(...)).
    expect(attrs['cost_usd'].kind).toBe('double')
    expect(attrs['cost_usd'].value).toBeCloseTo(0.0123, 9)
    // model / request_id / session.id are strings.
    expect(attrs['model']).toEqual({ kind: 'string', value: 'claude-opus-4-8' })
    expect(attrs['request_id']).toEqual({ kind: 'string', value: 'req_42' })
    expect(attrs['session.id']).toEqual({ kind: 'string', value: 'sess-xyz' })
  })

  it('encodes the InstrumentationScope name onto the wire (PLG-10: ScopeLogs field 1)', () => {
    const top = decodeMessage(bytes)
    const resourceLogs = decodeMessage(asBuf(top.get(1)![0]))
    const scopeLogs = decodeMessage(asBuf(resourceLogs.get(2)![0]))
    // ScopeLogs { InstrumentationScope scope = 1; ... }; InstrumentationScope { string name = 1; }
    expect(scopeLogs.has(1)).toBe(true) // was silently dropped pre-fix
    const scope = decodeMessage(asBuf(scopeLogs.get(1)![0]))
    expect(str(asBuf(scope.get(1)![0]))).toBe('com.anthropic.claude_code')
  })

  it('encodes one log record per usage record (field 2 repeated under ScopeLogs)', () => {
    const rec2 = recordFromTranscriptLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-15T11:05:00Z',
        message: { model: 'claude-haiku', usage: { output_tokens: 7 } },
      }),
    )!
    const multi = encodeExportLogsServiceRequest(buildOtlpLogsPayload([rec, rec2], { 'tokenscope.instance_id': 'inst-1' }))
    const top = decodeMessage(multi)
    const resourceLogs = decodeMessage(asBuf(top.get(1)![0]))
    const scopeLogs = decodeMessage(asBuf(resourceLogs.get(2)![0]))
    expect(scopeLogs.get(2)!.length).toBe(2) // two LogRecords
  })
})
