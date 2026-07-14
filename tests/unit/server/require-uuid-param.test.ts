// @vitest-environment node
/*
 * requireUuidParam — the SYS-1 shared router-param validator.
 *
 * The regression this pins down: the legacy /^[0-9a-f-]{36}$/i regex
 * accepted 36 hex-and-dash chars that are NOT a canonical UUID, which then
 * 500'd on the PG ::uuid cast (API-5); bare Schema.parse() threw a raw
 * ZodError → 500 (API-7). The helper must 400 (an H3Error with an RFC-9457
 * body) on every malformed shape and pass canonical UUIDs through.
 */
import { describe, it, expect } from 'vitest'
import { createEvent, isError, type H3Event } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { requireUuidParam } from '../../../server/utils/require-uuid-param'

function makeEvent(params: Record<string, string>): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = '/api/v1/allocations/test'
  const event = createEvent(req, new ServerResponse(req))
  event.context.params = params
  return event
}

function captureError(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (err) {
    return err
  }
}

describe('requireUuidParam', () => {
  it('returns a canonical UUID untouched', () => {
    const id = '7b0c2a4e-1d2f-4a5b-9c8d-0e1f2a3b4c5d'
    expect(requireUuidParam(makeEvent({ id }), 'id')).toBe(id)
  })

  it('rejects the API-5 trap: 36 hex chars with NO dashes (passed the old regex, 22P02 → 500 in PG)', () => {
    const err = captureError(() =>
      requireUuidParam(makeEvent({ id: 'abcdefabcdefabcdefabcdefabcdefabcdef' }), 'id'),
    )
    expect(isError(err)).toBe(true)
    expect((err as { statusCode: number }).statusCode).toBe(400)
  })

  it('rejects a 36-char dash-soup string (also passed the old regex)', () => {
    const err = captureError(() =>
      requireUuidParam(makeEvent({ id: '------------------------------------' }), 'id'),
    )
    expect(isError(err)).toBe(true)
    expect((err as { statusCode: number }).statusCode).toBe(400)
  })

  it('rejects a missing param with 400 (not a raw ZodError → 500, the API-7 trap)', () => {
    const err = captureError(() => requireUuidParam(makeEvent({}), 'id'))
    expect(isError(err)).toBe(true)
    expect((err as { statusCode: number }).statusCode).toBe(400)
  })

  it('carries an RFC-9457 problem body with the custom label', () => {
    const err = captureError(() =>
      requireUuidParam(makeEvent({ id: 'nope' }), 'id', 'allocation id'),
    ) as { statusCode: number; statusMessage: string; data: Record<string, unknown> }
    expect(err.statusCode).toBe(400)
    expect(err.statusMessage).toBe('Invalid allocation id')
    expect(err.data).toMatchObject({
      type: 'https://tokenscope.example.com/errors/invalid-input',
      title: 'Invalid allocation id',
      status: 400,
    })
  })
})
