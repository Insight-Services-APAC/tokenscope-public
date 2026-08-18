// @vitest-environment node
/*
 * scripts/check-handler-rls-context.mjs — the guard that stops a NEW API handler
 * reaching the platform pool without an RLS lane.
 *
 * The source says `callsGetDbDirectly` is "exported for the unit test" and there was
 * no unit test; the export comment was a claim about a file that did not exist. This
 * is that test, and it exists specifically to pin the detector against the bypasses
 * an external review of sprint 3 raised: the original `/\bgetDb\s*\(/` matched the
 * literal call and nothing else, so an aliased import, an optional call or a rebound
 * reference all reached `getDb()` while the check reported "every handler carries an
 * RLS lane".
 *
 * This is a drift guard, not a security boundary — someone determined to route around
 * it still can. The bar is that an ordinary handler written next week does not slip
 * through by accident, and the literal-call-only form did not clear it.
 */
import { describe, it, expect } from 'vitest'
import { callsGetDbDirectly, ALLOWLIST } from '../../../scripts/check-handler-rls-context.mjs'

describe('callsGetDbDirectly — reaches the platform pool', () => {
  it.each([
    ['a plain call', "import { getDb } from '../db'\nconst rows = await getDb().execute(sql`SELECT 1`)"],
    ['an ALIASED import (the review case)', "import { getDb as rawDb } from '../../../db'\nawait rawDb().execute(sql`SELECT 1`)"],
    ['an optional call', "import { getDb } from '../db/index'\nawait getDb?.().execute(sql`SELECT 1`)"],
    ['a rebound reference', "import { getDb } from '../db'\nconst d = getDb\nawait d().execute(sql`SELECT 1`)"],
  ])('detects %s', (_name, source) => {
    expect(callsGetDbDirectly(source)).toBe(true)
  })

  it.each([
    ['a handler on the request lane', "import { withRequestRls } from '../db/request-rls'\nawait withRequestRls(event, async (tx) => tx.execute(sql`SELECT 1`))"],
    ['a handler on the worker lane', "import { getWorkerDb } from '../db/worker-db'\nconst db = await getWorkerDb()"],
    ['a handler on the machine lane', "import { withMachineRls } from '../db/machine-rls'\nawait withMachineRls(event, bearer, async (tx) => tx)"],
    ['prose that merely mentions the name', '// This handler deliberately does not call getDb — see the lane docs.'],
  ])('does not flag %s', (_name, source) => {
    expect(callsGetDbDirectly(source)).toBe(false)
  })
})

describe('ALLOWLIST', () => {
  it('every entry carries a reason — an allowlist without reasons is how this debt came back', () => {
    for (const [path, reason] of ALLOWLIST) {
      expect(typeof path, `${path} must be a path`).toBe('string')
      expect(String(reason).trim().length, `${path} has no reason`).toBeGreaterThan(20)
    }
  })

  it('is far below the 47 it started at, so a silent regrowth is visible in the diff', () => {
    expect(ALLOWLIST.size).toBeLessThanOrEqual(20)
  })
})
