/*
 * parseWorkerOpts — the run-worker endpoint's per-dispatch body parser.
 *
 * The endpoint (server/api/v1/internal/run-worker/[name].post.ts) threads the
 * parsed opts into `entry.run(db, { runId, opts })`. This unit test pins the
 * PARSE contract directly (no Nitro boot, no DB), mirroring the event-construction
 * style of internal-request.test.ts:
 *   - `{deepRescan:true}` parses to { deepRescan: true } → forced deep-rescan.
 *   - empty / absent / whitespace / `{}` body → undefined (auto path).
 *   - malformed body (non-JSON, wrong type, array) → undefined, NEVER throws.
 *   - unknown keys are stripped (forward-compatible).
 *
 * The last point matters: a malformed body must degrade to no-opts rather than
 * 500ing a scheduled dispatch — the whole point is that the operator lever is
 * safe to mis-use.
 */
import { describe, it, expect } from 'vitest'
import { createEvent } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { parseWorkerOpts } from '../../../server/workers/run-worker-opts'

// Build an h3 event whose cached raw body is `body`. We seed the SAME cache slot
// h3's readRawBody reads (event._requestBody), which is how the endpoint sees the
// body already-read by verifyInternalRequest.
function makeEvent(body: string | undefined) {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'POST'
  req.url = '/api/v1/internal/run-worker/azure-monitor-read'
  const res = new ServerResponse(req)
  const event = createEvent(req, res)
  if (body !== undefined) {
    ;(event as unknown as { _requestBody?: Buffer })._requestBody = Buffer.from(body, 'utf8')
    Object.defineProperty(event.node.req, 'rawBody', {
      value: Buffer.from(body, 'utf8'),
      writable: true,
    })
  }
  return event
}

describe('parseWorkerOpts', () => {
  it('parses {deepRescan:true} → { deepRescan: true } (operator forces a deep-rescan)', async () => {
    const opts = await parseWorkerOpts(makeEvent('{"deepRescan":true}'))
    expect(opts).toEqual({ deepRescan: true })
  })

  it('parses {deepRescan:false} → { deepRescan: false } (explicit off is honoured, not dropped)', async () => {
    const opts = await parseWorkerOpts(makeEvent('{"deepRescan":false}'))
    expect(opts).toEqual({ deepRescan: false })
  })

  it('an empty {} body → undefined (no opts → worker takes its auto path)', async () => {
    const opts = await parseWorkerOpts(makeEvent('{}'))
    expect(opts).toBeUndefined()
  })

  it('an empty-string body → undefined', async () => {
    const opts = await parseWorkerOpts(makeEvent(''))
    expect(opts).toBeUndefined()
  })

  it('a whitespace-only body → undefined', async () => {
    const opts = await parseWorkerOpts(makeEvent('   \n  '))
    expect(opts).toBeUndefined()
  })

  it('an absent body → undefined (no throw)', async () => {
    const opts = await parseWorkerOpts(makeEvent(undefined))
    expect(opts).toBeUndefined()
  })

  it('a non-JSON body → undefined, never throws', async () => {
    await expect(parseWorkerOpts(makeEvent('not json at all'))).resolves.toBeUndefined()
  })

  it('a JSON array (wrong shape) → undefined, never throws', async () => {
    await expect(parseWorkerOpts(makeEvent('[1,2,3]'))).resolves.toBeUndefined()
  })

  it('a wrong-typed deepRescan (string) → undefined (schema rejects, fail-soft)', async () => {
    await expect(parseWorkerOpts(makeEvent('{"deepRescan":"yes"}'))).resolves.toBeUndefined()
  })

  it('unknown keys are stripped; deepRescan is preserved', async () => {
    const opts = await parseWorkerOpts(makeEvent('{"deepRescan":true,"nope":123,"x":"y"}'))
    expect(opts).toEqual({ deepRescan: true })
  })

  it('a body with ONLY unknown keys → undefined (nothing honoured → auto path)', async () => {
    const opts = await parseWorkerOpts(makeEvent('{"nope":123}'))
    expect(opts).toBeUndefined()
  })
})

/*
 * startingAt / endingAt (#142) — the analytics-poll window override. The parser
 * enforces the YYYY-MM-DD SHAPE plus CALENDAR validity (2026-13-40 must fail
 * here with a clean validation path, not later as a Postgres ::date cast
 * error); pairing + span validity ("both set, startingAt <= endingAt") is the
 * registry's job, so a lone startingAt is KEPT
 * here and dropped there. Any shape violation fails the whole safeParse →
 * undefined → auto window (the fail-soft HTTP semantics: an operator typo must
 * never 500 a scheduled dispatch).
 */
describe('parseWorkerOpts — startingAt / endingAt (#142 window override)', () => {
  it('a valid YYYY-MM-DD pair is kept verbatim', async () => {
    const opts = await parseWorkerOpts(makeEvent('{"startingAt":"2026-01-01","endingAt":"2026-06-30"}'))
    expect(opts).toEqual({ startingAt: '2026-01-01', endingAt: '2026-06-30' })
  })

  it('a lone startingAt is kept by the PARSER (the registry enforces the pair)', async () => {
    const opts = await parseWorkerOpts(makeEvent('{"startingAt":"2026-01-01"}'))
    expect(opts).toEqual({ startingAt: '2026-01-01' })
  })

  it('a non-YYYY-MM-DD startingAt → undefined (whole opts rejected, fail-soft)', async () => {
    await expect(parseWorkerOpts(makeEvent('{"startingAt":"2026-1-1","endingAt":"2026-06-30"}'))).resolves.toBeUndefined()
  })

  it('a shape-valid but CALENDAR-INVALID date (2026-13-40) → undefined — the .refine() catches it before Postgres ::date would', async () => {
    await expect(parseWorkerOpts(makeEvent('{"startingAt":"2026-13-40","endingAt":"2026-12-31"}'))).resolves.toBeUndefined()
  })

  it('a real-month impossible day (2026-02-30) → undefined (fail-soft, auto window)', async () => {
    await expect(parseWorkerOpts(makeEvent('{"startingAt":"2026-02-01","endingAt":"2026-02-30"}'))).resolves.toBeUndefined()
  })

  it('an RFC-3339 timestamp (not a bare date) → undefined — the regex is anchored', async () => {
    await expect(
      parseWorkerOpts(makeEvent('{"startingAt":"2026-01-01T00:00:00Z","endingAt":"2026-06-30"}')),
    ).resolves.toBeUndefined()
  })

  it('a US-style date → undefined', async () => {
    await expect(parseWorkerOpts(makeEvent('{"startingAt":"01-01-2026","endingAt":"2026-06-30"}'))).resolves.toBeUndefined()
  })

  it('a non-string endingAt (number) → undefined', async () => {
    await expect(parseWorkerOpts(makeEvent('{"startingAt":"2026-01-01","endingAt":20260630}'))).resolves.toBeUndefined()
  })

  it('the window pair coexists with other opts; unknown keys still stripped', async () => {
    const opts = await parseWorkerOpts(
      makeEvent('{"startingAt":"2026-01-01","endingAt":"2026-01-31","deepRescan":true,"nope":1}'),
    )
    expect(opts).toEqual({ startingAt: '2026-01-01', endingAt: '2026-01-31', deepRescan: true })
  })
})

/*
 * externalOrgId (#142) — the analytics-poll org-scoping companion to the window
 * override. The parser only requires a non-empty string; whether the id matches
 * a reconciled org is the poller's concern (unknown id → clean no-op there).
 */
describe('parseWorkerOpts — externalOrgId (#142 org scoping)', () => {
  it('a non-empty externalOrgId is kept verbatim', async () => {
    const opts = await parseWorkerOpts(makeEvent('{"externalOrgId":"org-acme"}'))
    expect(opts).toEqual({ externalOrgId: 'org-acme' })
  })

  it('an EMPTY-string externalOrgId → undefined (min(1) rejects; fail-soft, never 500)', async () => {
    await expect(parseWorkerOpts(makeEvent('{"externalOrgId":""}'))).resolves.toBeUndefined()
  })

  it('a non-string externalOrgId (number) → undefined', async () => {
    await expect(parseWorkerOpts(makeEvent('{"externalOrgId":42}'))).resolves.toBeUndefined()
  })

  it('externalOrgId coexists with a window pair (the recommended scoped re-pull shape)', async () => {
    const opts = await parseWorkerOpts(
      makeEvent('{"startingAt":"2026-01-01","endingAt":"2026-06-30","externalOrgId":"org-acme"}'),
    )
    expect(opts).toEqual({ startingAt: '2026-01-01', endingAt: '2026-06-30', externalOrgId: 'org-acme' })
  })
})
