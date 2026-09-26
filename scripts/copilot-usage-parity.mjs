#!/usr/bin/env node
/*
 * copilot-usage-parity — compare what the file forwarder WOULD send (span file →
 * transcodeChatSpans) with what the usage extension recorded in shadow mode.
 *
 *   node scripts/copilot-usage-parity.mjs --spans <copilot-otel.jsonl> --shadow <dir|file> [--json]
 *
 * Exit 0 when every token-bearing chat span is matched by provider id, no request id
 * is recorded twice, and every session's extension totals EQUAL the forwarder's
 * (input, output, cache-read, cost); cache-write may exceed, since the forwarder
 * under-reads it. Any other difference, higher or lower, exits 1. Design §Parity:
 * docs/design/copilot-usage-extension.md.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { transcodeChatSpans } from '../plugin/scripts/otlp-logs.mjs'

const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'nano_aiu']

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}

/** Every nonblank line must parse: a gate that skipped damaged evidence could pass on half of it. */
export function jsonl(path) {
  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((l, i) => {
      if (!l.trim()) return []
      try {
        return [JSON.parse(l)]
      } catch {
        throw new Error(`${path}:${i + 1}: not valid JSON (damaged or torn evidence; fix or remove the line and rerun)`)
      }
    })
}

const attr = (rec, key) => {
  const v = rec.attributes.find((a) => a.key === key)?.value
  return v ? (v.stringValue ?? v.intValue ?? v.doubleValue ?? null) : null
}

function totals(records) {
  const bySession = new Map()
  for (const r of records) {
    if (attr(r, 'event.name') !== 'api_request') continue
    const sid = attr(r, 'session.id')
    const t = bySession.get(sid) ?? Object.fromEntries([...FIELDS, 'calls'].map((f) => [f, 0]))
    for (const f of FIELDS) t[f] += Number(attr(r, f === 'nano_aiu' ? 'github.copilot.nano_aiu' : f) ?? 0)
    t.calls += 1
    bySession.set(sid, t)
  }
  return bySession
}

const cuId = (raw) => 'cu' + createHash('sha256').update(String(raw)).digest('hex').slice(0, 32)
const hasTokens = (a) =>
  Number(a['gen_ai.usage.input_tokens'] ?? 0) > 0 || Number(a['gen_ai.usage.output_tokens'] ?? 0) > 0

/**
 * ok = every token-bearing forwarder call is found by provider id, no request id is
 * recorded twice (cache-write is exempt from equality below, so totals alone would
 * miss a duplicated cache-write-only call), AND every session's extension totals
 * EQUAL the forwarder's, except
 * cache-write tokens, which the forwarder under-reads (>= there). Totals, not per-call,
 * because the CLI folds a subagent's calls into one span.
 */
export function compare(spans, shadowRecords) {
  const fwd = totals(transcodeChatSpans(spans, { instanceId: 'parity' }))
  const ext = totals(shadowRecords)
  const allIds = shadowRecords.filter((r) => attr(r, 'event.name') === 'api_request').map((r) => attr(r, 'request_id'))
  const extIds = new Set(allIds)
  const duplicateIds = [...new Set(allIds.filter((id, i) => allIds.indexOf(id) !== i))]
  const billed = spans.filter((s) => s?.attributes?.['gen_ai.operation.name'] === 'chat' && hasTokens(s.attributes))
  const unmatched = billed
    .filter((s) => !s.attributes['gen_ai.response.id'] || !extIds.has(cuId(s.attributes['gen_ai.response.id'])))
    .map((s) => s.spanId ?? null)
  const sessions = [...new Set([...fwd.keys(), ...ext.keys()])].map((sid) => {
    const f = fwd.get(sid) ?? null
    const e = ext.get(sid) ?? null
    const ok =
      !!e && FIELDS.every((k) => (k === 'cache_creation_tokens' ? (e[k] ?? 0) >= (f?.[k] ?? 0) : (e[k] ?? 0) === (f?.[k] ?? 0)))
    const exceeds = e ? FIELDS.filter((k) => (e[k] ?? 0) > (f?.[k] ?? 0)) : []
    return { session: sid, forwarder: f, extension: e, ok, exceeds }
  })
  return {
    sessions,
    spanCallsMatchedById: billed.length - unmatched.length,
    unmatchedSpans: unmatched,
    duplicateIds,
    ok: sessions.length > 0 && unmatched.length === 0 && duplicateIds.length === 0 && sessions.every((s) => s.ok),
  }
}

function main() {
  const spansPath = arg('--spans')
  const shadowPath = arg('--shadow')
  if (!spansPath || !shadowPath) {
    process.stderr.write('usage: copilot-usage-parity --spans <file> --shadow <dir|file> [--json]\n')
    process.exit(2)
  }
  const spans = jsonl(spansPath).filter((s) => s.type === 'span')
  const files = fs.statSync(shadowPath).isDirectory()
    ? fs.readdirSync(shadowPath).filter((f) => f.endsWith('.jsonl')).map((f) => join(shadowPath, f))
    : [shadowPath]
  const shadow = files.flatMap(jsonl).map((e) => e.r).filter(Boolean)
  const result = compare(spans, shadow)
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    for (const s of result.sessions) {
      const note = s.exceeds.length ? `  (extension higher on: ${s.exceeds.join(', ')} — explain before cutover)` : ''
      process.stdout.write(`${s.ok ? 'OK  ' : 'FAIL'} session ${s.session}${note}\n`)
      for (const k of ['calls', ...FIELDS]) {
        process.stdout.write(`       ${k.padEnd(22)} forwarder=${s.forwarder?.[k] ?? '-'}  extension=${s.extension?.[k] ?? '-'}\n`)
      }
    }
    process.stdout.write(
      `token-bearing chat spans matched by id: ${result.spanCallsMatchedById}, unmatched: ${result.unmatchedSpans.length}\n`,
    )
  }
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
