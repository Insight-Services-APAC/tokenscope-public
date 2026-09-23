/*
 * classifyDispatchResponse — what the cron trigger reports to Azure Container Apps.
 *
 * The class under test is "a healthy outcome reported as a FAILED execution", which
 * has bitten cron-trigger.mjs twice (the 120s-vs-240s timeout, then #285's 409). The
 * job history is what an operator reads to tell a catch-up from an outage, so a false
 * Failed there is not cosmetic.
 *
 * The drift guard at the bottom reads server/workers/dispatch.ts and compares the
 * type it ACTUALLY declares against the classifier's constant, the way
 * dispatch-budget-lockstep.test.ts compares the three copies of the timeout. An
 * earlier version of this file built its fixture by interpolating the classifier's
 * own constant into a createError, which could never fail and was described in the
 * commit as a drift guard: a test that cannot fail certifies nothing.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALREADY_RUNNING_TYPE,
  classifyDispatchResponse,
} from '../../../scripts/lib/dispatch-outcome.mjs'

const root = resolve(__dirname, '../../..')

/**
 * The ProblemDetails `type` the dispatcher declares on its 409, read from source.
 * Not a copy: if server/workers/dispatch.ts changes it, this changes with it and
 * the lockstep assertion below is what fails.
 */
function declaredDispatcherType(): string {
  const src = readFileSync(resolve(root, 'server/workers/dispatch.ts'), 'utf8')
  const m = src.match(/statusCode:\s*409[\s\S]{0,400}?type:\s*'([^']+)'/)
  expect(m, 'dispatch.ts must declare a ProblemDetails type on its 409').not.toBeNull()
  return m![1]
}

/** A response body shaped like the one the endpoint returns for that error. */
function alreadyRunningBody(type: string = declaredDispatcherType()): string {
  return JSON.stringify({
    statusCode: 409,
    statusMessage: 'Conflict',
    data: {
      type,
      title: 'Worker already running',
      status: 409,
      detail: `Worker 'azure-monitor-read' is already being dispatched; this dispatch is a no-op.`,
    },
  })
}

describe('classifyDispatchResponse', () => {
  it('succeeds on a normal run', () => {
    expect(classifyDispatchResponse(200, '{"ok":true}')).toEqual({ exitCode: 0, skipped: false })
  })

  it('treats the single-flight 409 as a SKIPPED tick, not a failure', () => {
    // #285: the read joiner catching up outlasts its 5-minute cron interval, so the
    // next tick hits the lock. Before the fix this exited 1 and the execution
    // recorded Failed, one per tick, for the whole catch-up.
    expect(classifyDispatchResponse(409, alreadyRunningBody())).toEqual({
      exitCode: 0,
      skipped: true,
    })
  })

  it.each([
    ['server error', 500, '{"statusCode":500}'],
    ['bad gateway', 502, ''],
    ['auth failure', 401, '{"statusCode":401,"statusMessage":"Unauthorized"}'],
    ['front-door rejection', 403, 'Forbidden'],
    ['worker not found', 404, '{"statusCode":404}'],
  ])('still fails on a %s', (_label, status, body) => {
    expect(classifyDispatchResponse(status, body)).toEqual({ exitCode: 1, skipped: false })
  })

  it('fails on a 409 that is NOT the single-flight lock', () => {
    // The dispatcher has one 409 today. Matching the bare status would swallow the
    // next one someone adds for a reason that really is a failure.
    const other = JSON.stringify({
      data: { type: 'https://tokenscope.example.com/errors/worker-disabled', status: 409 },
    })
    expect(classifyDispatchResponse(409, other)).toEqual({ exitCode: 1, skipped: false })
  })

  it.each([
    ['empty', ''],
    ['not JSON', '<html>409</html>'],
    ['JSON without a type', '{"statusCode":409}'],
  ])('fails closed on a 409 whose body is %s', (_label, body) => {
    expect(classifyDispatchResponse(409, body)).toEqual({ exitCode: 1, skipped: false })
  })

  it('reads the type when the body is not wrapped in data', () => {
    const flat = JSON.stringify({ type: `https://example.test/errors/${ALREADY_RUNNING_TYPE}` })
    expect(classifyDispatchResponse(409, flat)).toEqual({ exitCode: 0, skipped: true })
  })

  it('matches the type suffix, so the publish host rewrite cannot break it', () => {
    // tools/publish/substitutions.txt rewrites the internal origin in the public
    // snapshot, so the full URI is not a stable string to compare against.
    const neutral = JSON.stringify({ data: { type: `https://example.com/errors/${ALREADY_RUNNING_TYPE}` } })
    expect(classifyDispatchResponse(409, neutral).skipped).toBe(true)
  })

  it.each([
    ['a longer type that merely ends with the token', 'https://x.test/errors/not-worker-already-running'],
    ['a type that extends the token', 'https://x.test/errors/worker-already-running-v2'],
  ])('fails on %s', (_label, type) => {
    // `endsWith` accepted the first of these, which is the OPPOSITE condition. A
    // final-path-segment match is what closes that fail-open hole.
    expect(classifyDispatchResponse(409, alreadyRunningBody(type))).toEqual({
      exitCode: 1,
      skipped: false,
    })
  })

  it('rejects a decoy token in a non-JSON body', () => {
    expect(classifyDispatchResponse(409, 'upstream said not-worker-already-running').skipped).toBe(false)
  })

  it('stays in lockstep with the type the dispatcher actually declares', () => {
    // The real drift guard: reads server/workers/dispatch.ts rather than restating
    // the constant. Change the type there and this fails, instead of the classifier
    // silently reinstating a Failed-per-tick catch-up.
    const declared = declaredDispatcherType()
    expect(declared.slice(declared.lastIndexOf('/') + 1)).toBe(ALREADY_RUNNING_TYPE)
    expect(classifyDispatchResponse(409, alreadyRunningBody(declared)).skipped).toBe(true)
  })
})
