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
import { describe, it, expect, vi } from 'vitest'
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

/*
 * lookbackDays / sessionIds — the joiner RECOVERY options.
 *
 * These exist because a recovery run must be able to reach past the reader's
 * 7-day default; without them a "recover the backlog" invocation silently
 * recovered only the last week and reported success. They are strict on purpose,
 * and this parser is fail-soft, so the combination has a sharp edge: a malformed
 * option drops the WHOLE opts object and the run takes its default path with a
 * green result. Pinned so that edge stays visible and the guard rails hold.
 */
describe('parseWorkerOpts — joiner recovery options', () => {
  const ID_A = '11111111-1111-4111-8111-111111111111'
  const ID_B = '22222222-2222-4222-8222-222222222222'

  it('accepts the documented recovery body (all three options together)', async () => {
    const opts = await parseWorkerOpts(
      makeEvent(`{"sessionIds":["${ID_A}","${ID_B}"],"lookbackDays":90,"deepRescan":true}`),
    )
    expect(opts).toEqual({ sessionIds: [ID_A, ID_B], lookbackDays: 90, deepRescan: true })
  })

  it('REJECTS lookbackDays without sessionIds — an unscoped widened read is a self-DoS', async () => {
    // Full selection re-read at 90 days, serially, past the worker gateway
    // ceiling: the handler holds the single-flight lock and every scheduled tick
    // 409s, stopping attribution fleet-wide for the duration.
    await expect(parseWorkerOpts(makeEvent('{"lookbackDays":90,"deepRescan":true}'))).resolves.toBeUndefined()
  })

  it('REJECTS a widened read without deepRescan — the watermark would silently gut it', async () => {
    // Post-deploy the watermark is fresh, so a 90-day scan returns almost
    // nothing while every evidence field reads green. Pairing is enforced.
    await expect(
      parseWorkerOpts(makeEvent(`{"sessionIds":["${ID_A}"],"lookbackDays":90}`)),
    ).resolves.toBeUndefined()
  })

  it('sessionIds alone is fine (scope without widening)', async () => {
    const opts = await parseWorkerOpts(makeEvent(`{"sessionIds":["${ID_A}"]}`))
    expect(opts).toEqual({ sessionIds: [ID_A] })
  })

  it('a STRING lookbackDays is rejected — the shell-template mistake that silently downgrades a recovery', async () => {
    await expect(parseWorkerOpts(makeEvent(`{"sessionIds":["${ID_A}"],"lookbackDays":"90"}`))).resolves.toBeUndefined()
  })

  it('lookbackDays out of range or fractional is rejected (bounded by reader retention)', async () => {
    for (const bad of ['0', '-1', '91', '7.5']) {
      await expect(
        parseWorkerOpts(makeEvent(`{"sessionIds":["${ID_A}"],"lookbackDays":${bad}}`)),
      ).resolves.toBeUndefined()
    }
  })

  it('a non-uuid instance id is rejected (ids are interpolated downstream)', async () => {
    await expect(parseWorkerOpts(makeEvent('{"sessionIds":["not-a-uuid"]}'))).resolves.toBeUndefined()
    await expect(parseWorkerOpts(makeEvent(`{"sessionIds":[" ${ID_A} "]}`))).resolves.toBeUndefined()
  })

  it('an empty or oversized sessionIds array is rejected', async () => {
    await expect(parseWorkerOpts(makeEvent('{"sessionIds":[]}'))).resolves.toBeUndefined()
    const many = Array.from({ length: 501 }, () => ID_A)
    await expect(parseWorkerOpts(makeEvent(JSON.stringify({ sessionIds: many })))).resolves.toBeUndefined()
  })

  it('WARNS when a malformed known option drops the whole body (silent downgrade is the trap)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await parseWorkerOpts(makeEvent(`{"sessionIds":["${ID_A}"],"lookbackDays":"90"}`))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toMatch(/DROPPED/)
    } finally {
      warn.mockRestore()
    }
  })

  it('does NOT warn for an unknown key (stripped by design — forward compatibility)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const opts = await parseWorkerOpts(makeEvent('{"someFutureOption":true,"deepRescan":true}'))
      expect(opts).toEqual({ deepRescan: true })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('parseWorkerOpts — widened recovery batch cap', () => {
  const ID = '11111111-1111-4111-8111-111111111111'
  const ids = (n: number) => Array.from({ length: n }, () => ID)

  it('accepts a widened run at the batch cap (50)', async () => {
    const opts = await parseWorkerOpts(makeEvent(JSON.stringify({ sessionIds: ids(50), lookbackDays: 90, deepRescan: true })))
    expect(opts?.lookbackDays).toBe(90)
    expect(opts?.sessionIds).toHaveLength(50)
  })

  it('REJECTS a widened run above the batch cap — scoping alone does not bound the cost', async () => {
    // 500 ids at 90 days is the same serial round-trip count as the unscoped
    // body the refinement already rejects, and the explicit-ids read path has
    // neither a LIMIT nor a window of its own.
    await expect(
      parseWorkerOpts(makeEvent(JSON.stringify({ sessionIds: ids(51), lookbackDays: 90, deepRescan: true }))),
    ).resolves.toBeUndefined()
  })

  it('an UNWIDENED scoped run keeps the larger cap (no widened window, no per-instance blowup)', async () => {
    const opts = await parseWorkerOpts(makeEvent(JSON.stringify({ sessionIds: ids(200) })))
    expect(opts?.sessionIds).toHaveLength(200)
  })
})

/*
 * The DIAGNOSTIC content of a rejection, not just the fact of it.
 *
 * parseWorkerOpts is fail-soft, so every rejection looks identical at the call
 * site: opts dropped, run degrades to a default tick, HTTP 200. The warn line is
 * therefore the operator's ONLY clue about which field they got wrong during a
 * recovery under a retention deadline. Asserting only "it was rejected" leaves
 * the field name, the path, and the reason free to rot.
 */
describe('parseWorkerOpts — rejection diagnostics name the offending field', () => {
  const ID = '11111111-1111-4111-8111-111111111111'
  const ids = (n: number) => Array.from({ length: n }, () => ID)

  async function warnFor(body: string): Promise<string> {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await parseWorkerOpts(makeEvent(body))
      return warn.mock.calls.map((c) => String(c[0])).join('\n')
    } finally {
      warn.mockRestore()
    }
  }

  it('says lookbackDays needs sessionIds, naming the field via the issue PATH', async () => {
    const out = await warnFor('{"lookbackDays":90}')
    // Assert the "<path>: <message>" form, not just the word: the message text
    // happens to contain "lookbackDays" too, so a looser match cannot tell a
    // missing issue path from a present one (the sweep caught exactly that).
    expect(out).toMatch(/lookbackDays: lookbackDays requires sessionIds/)
  })

  it('says a widened batch is too large, naming sessionIds and the cap', async () => {
    const out = await warnFor(JSON.stringify({ sessionIds: ids(51), lookbackDays: 90, deepRescan: true }))
    expect(out).toMatch(/sessionIds/)
    expect(out).toMatch(/limited to 50 instances/)
  })

  it('formats each issue as "path: message" so multiple faults are all legible', async () => {
    const out = await warnFor('{"lookbackDays":"90","startingAt":"nope"}')
    expect(out).toMatch(/lookbackDays: /)
    expect(out).toMatch(/startingAt: /)
  })
})
