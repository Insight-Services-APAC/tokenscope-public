// Minimal OTLP/HTTP protobuf decoder for ExportLogsServiceRequest, producing
// the same shape as the OTLP/JSON encoding so one normaliser handles both.
// Clients send http/protobuf (the emit bundle pins it), so a JSON-only stub
// never sees real client traffic. Covers the fields ingestOtlpLogs reads:
// resource attributes, log-record attributes and timeUnixNano.

function readVarint(buf, pos) {
  let result = 0n
  let shift = 0n
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint')
    const b = buf[pos++]
    result |= BigInt(b & 0x7f) << shift
    if (!(b & 0x80)) return { value: result, pos }
    shift += 7n
    if (shift > 63n) throw new Error('varint too long')
  }
}

// field number -> array of { wire, value } (value: bigint | Buffer)
function fields(buf) {
  const out = new Map()
  let pos = 0
  while (pos < buf.length) {
    const key = readVarint(buf, pos)
    pos = key.pos
    const num = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    let value
    if (wire === 0) {
      const v = readVarint(buf, pos)
      value = v.value
      pos = v.pos
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error('truncated fixed64')
      value = buf.subarray(pos, pos + 8)
      pos += 8
    } else if (wire === 2) {
      const len = readVarint(buf, pos)
      pos = len.pos
      const end = pos + Number(len.value)
      if (end > buf.length) throw new Error('truncated length-delimited field')
      value = buf.subarray(pos, end)
      pos = end
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error('truncated fixed32')
      value = buf.subarray(pos, pos + 4)
      pos += 4
    } else {
      throw new Error(`unsupported wire type ${wire}`)
    }
    if (!out.has(num)) out.set(num, [])
    out.get(num).push({ wire, value })
  }
  return out
}

const all = (m, n) => (m.get(n) ?? []).map((f) => f.value)
const first = (m, n) => m.get(n)?.[0]?.value

function anyValue(buf) {
  const m = fields(buf)
  if (m.has(1)) return { stringValue: first(m, 1).toString('utf8') }
  if (m.has(2)) return { boolValue: first(m, 2) !== 0n }
  if (m.has(3)) return { intValue: BigInt.asIntN(64, first(m, 3)).toString() }
  if (m.has(4)) return { doubleValue: first(m, 4).readDoubleLE(0) }
  return {}
}

function attributes(bufs) {
  return bufs.map((kv) => {
    const m = fields(kv)
    const value = first(m, 2)
    return { key: (first(m, 1) ?? Buffer.alloc(0)).toString('utf8'), value: value ? anyValue(value) : {} }
  })
}

export function decodeExportLogsServiceRequest(buf) {
  return {
    resourceLogs: all(fields(buf), 1).map((rlBuf) => {
      const rl = fields(rlBuf)
      const resource = first(rl, 1)
      return {
        resource: { attributes: resource ? attributes(all(fields(resource), 1)) : [] },
        scopeLogs: all(rl, 2).map((slBuf) => ({
          logRecords: all(fields(slBuf), 2).map((lrBuf) => {
            const lr = fields(lrBuf)
            const t = first(lr, 1)
            return {
              ...(t ? { timeUnixNano: t.readBigUInt64LE(0).toString() } : {}),
              attributes: attributes(all(lr, 6)),
            }
          }),
        })),
      }
    }),
  }
}
