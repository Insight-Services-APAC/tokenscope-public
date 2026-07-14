/*
 * SessionStart emission-health warning helpers (the proactive cry-wolf-guarded
 * warning surface). warnFor classifies the sentinel HTTP like status.mjs's
 * interpretEmissionProbe; sentinelHttp safely extracts the code. The hook's
 * main()/emissionHealthWarning network path is covered end-to-end (child process)
 * in tag-repo-selfheal.test.ts; these are the pure classification units.
 */
import { describe, it, expect } from 'vitest'
import { warnFor, sentinelHttp, projectBillabilityWarning } from '../../../plugin/hooks/session-start.mjs'

describe('projectBillabilityWarning — wrong-env tag warning (only on not-billable)', () => {
  it('returns null for ok / no-tag / unverifiable / null (NEVER cries wolf)', () => {
    expect(projectBillabilityWarning(null)).toBeNull()
    expect(projectBillabilityWarning({ status: 'ok' })).toBeNull()
    expect(projectBillabilityWarning({ status: 'no-tag' })).toBeNull()
    expect(projectBillabilityWarning({ status: 'unverifiable' })).toBeNull()
  })

  it('not-billable → hedged, actionable warning naming the code + re-tag command', () => {
    const m = projectBillabilityWarning({ status: 'not-billable', code: 'TokenScope-MVP', yourProjects: [{ code: 'tokenscope-public' }] })
    expect(m).toMatch(/TokenScope-MVP/)
    expect(m).toMatch(/UNTAGGED/)
    expect(m).toMatch(/tokenscope:project/)
    expect(m).toMatch(/tokenscope-public/) // the billable budget hint
    expect(m).toMatch(/currently/) // hedged on point-in-time membership
  })

  it('not-billable with no code / no projects → still a safe generic warning', () => {
    const m = projectBillabilityWarning({ status: 'not-billable' })
    expect(m).toMatch(/UNTAGGED/)
    expect(m).toMatch(/tokenscope:project/)
  })
})

describe('warnFor — http classification', () => {
  it('401/403/404 → "NOT emitting" + re-provision steer', () => {
    for (const http of [401, 403, 404]) {
      const m = warnFor(http)
      expect(m).toMatch(/NOT emitting/i)
      expect(m).toMatch(/re-provision|tokenscope-setup/i)
      expect(m).toContain(String(http))
    }
  })

  it('5xx/other → transient server-side, NO re-provision steer (no instance churn over a blip)', () => {
    const m = warnFor(500)
    expect(m).toMatch(/transient/i)
    expect(m).not.toMatch(/re-provision|tokenscope-setup/i)
  })
})

describe('sentinelHttp', () => {
  it('extracts a finite http_status (including 0)', () => {
    expect(sentinelHttp({ http_status: 401 })).toBe(401)
    expect(sentinelHttp({ http_status: 0 })).toBe(0)
  })

  it('returns null for a missing / absent / non-finite status', () => {
    expect(sentinelHttp(null)).toBeNull()
    expect(sentinelHttp({})).toBeNull()
    expect(sentinelHttp({ http_status: 'nope' })).toBeNull()
  })
})
