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
