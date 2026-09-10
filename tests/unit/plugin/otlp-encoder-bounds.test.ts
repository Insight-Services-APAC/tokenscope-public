/*
 * OTLP encoder input bounds (MDASH F127 / F124 / F310).
 *
 * These values come from telemetry ATTRIBUTES, not from us, so the encoder has
 * to treat them as input rather than data it produced. None of this is a
 * credential path — it is unbounded work and a crash surface on the developer's
 * own machine, which is why they are LOW/MEDIUM and cheap.
 */
import { describe, it, expect } from 'vitest'
import {
  safeIntString,
  jsonArrayLength,
  encodeExportLogsServiceRequest,
  transcodeChatSpans,
} from '../../../plugin/scripts/otlp-logs.mjs'

describe('safeIntString bounds the digit string before BigInt', () => {
  it('still converts ordinary values', () => {
    expect(safeIntString('12345')).toBe('12345')
    expect(safeIntString(42)).toBe('42')
    expect(safeIntString('  7 ')).toBe('7')
    expect(safeIntString(null)).toBe('0')
    expect(safeIntString('nope')).toBe('0')
  })

  it('accepts a value far larger than any real token count', () => {
    // 2^128 has 39 digits; a real count never approaches this.
    expect(safeIntString('9'.repeat(39))).toBe('9'.repeat(39))
  })

  it('refuses an absurd digit string rather than doing the work', () => {
    // BigInt() on this is superlinear; the value is meaningless either way.
    expect(safeIntString('9'.repeat(100_000))).toBe('0')
  })
})

describe('jsonArrayLength refuses to parse an oversized string', () => {
  it('still counts a normal array', () => {
    expect(jsonArrayLength('[1,2,3]')).toBe(3)
    expect(jsonArrayLength([1, 2])).toBe(2)
    expect(jsonArrayLength('not json')).toBeNull()
    expect(jsonArrayLength(null)).toBeNull()
  })

  it('does not parse a multi-megabyte attribute to learn a number', () => {
    const huge = `[${'1,'.repeat(2_000_000)}1]`
    expect(huge.length).toBeGreaterThan(64 * 1024)
    expect(jsonArrayLength(huge)).toBeNull()
  })
})

describe('safeIntString keeps the numeric fall-through it needs', () => {
  it('still converts a decimal-shaped attribute — a real Copilot value', () => {
    // This is why the bound is LENGTH-only: "24278.0" fails the digit test and
    // must still reach Number(). An earlier version short-circuited to '0' here
    // and silently zeroed real token counts.
    expect(safeIntString('24278.0')).toBe('24278')
    expect(safeIntString('1e3')).toBe('1000')
  })
})

describe('the outermost encoder never drops a record', () => {
  /*
   * The inverse of a guard that was added and removed inside this PR. A byte
   * budget here counted bytes as records were appended and stopped once the
   * total was exceeded — but both payload builders put an ENTIRE batch in ONE
   * resourceLogs entry, so an over-budget batch produced an EMPTY protobuf that
   * callers POSTed, saw 2xx, and counted as fully delivered. Silent, total loss.
   *
   * This asserts the property that must hold instead: every record offered is
   * encoded. It fails if a truncating budget is reintroduced.
   */
  const record = (bytes: number) => ({
    resource: { attributes: [] },
    scopeLogs: [
      {
        logRecords: [
          {
            timeUnixNano: '1780825137573805196',
            body: { stringValue: 'x'.repeat(bytes) },
            attributes: [],
          },
        ],
      },
    ],
  })

  it('encodes every resourceLogs entry, however large the batch', () => {
    const one = encodeExportLogsServiceRequest({ resourceLogs: [record(5 * 1024 * 1024)] })
    const three = encodeExportLogsServiceRequest({
      resourceLogs: [record(5 * 1024 * 1024), record(5 * 1024 * 1024), record(5 * 1024 * 1024)],
    })
    expect(three.length, 'the encoder dropped records instead of encoding them').toBe(one.length * 3)
  })

  it('a single oversized record is still encoded, never silently emptied', () => {
    const out = encodeExportLogsServiceRequest({ resourceLogs: [record(9 * 1024 * 1024)] })
    expect(out.length, 'an over-large batch encoded to nothing — callers would report it sent').toBeGreaterThan(9 * 1024 * 1024)
  })
})

describe('an out-of-range timestamp does not take the batch down', () => {
  /*
   * The FAILURE is a throw, not a wrong number. timeUnixNano is written with
   * Buffer.writeBigUInt64LE, which throws above 2^64-1, and that exception
   * escapes the whole encode — so one hostile span attribute would discard every
   * record batched with it. Encoding is what this asserts; a fallback value is
   * only how it avoids the throw.
   */
  it('encodes a batch whose span carries a 25-digit endTimeUnixNano', () => {
    const span = {
      name: 'chat',
      endTimeUnixNano: '9'.repeat(25),
      attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }],
    }
    const records = transcodeChatSpans([span], { instanceId: 'inst-1' })
    const payload = {
      resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: records }] }],
    }
    expect(() => encodeExportLogsServiceRequest(payload)).not.toThrow()
  })
})
