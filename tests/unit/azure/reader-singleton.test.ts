// @vitest-environment node
/*
 * getTelemetryReader — one reader per resolved config, for the life of the
 * process (docs/design/admin-nav-responsiveness.md D4).
 *
 * The credential/client memo (ING-11) lives on the LogAnalyticsReader
 * INSTANCE. A factory that built a new instance per call discarded it on
 * every request, so the diagnostics page re-ran the managed-identity chain
 * each time it probed the read path. This pins the three properties the
 * memo depends on: same config → same instance; a different lookback (the
 * recovery reader) is a different instance whose applied window is its own;
 * and the test-only reset really forgets.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getTelemetryReader, resetTelemetryReaderCache, LogAnalyticsReader } from '../../../server/azure/reader'
import { snapshotEnv } from '../../helpers/env-snapshot'

const restoreEnv = snapshotEnv()

beforeEach(() => {
  resetTelemetryReaderCache()
  process.env.NUXT_TELEMETRY_READER = 'log-analytics'
  process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID = 'ws-singleton'
  delete process.env.NUXT_AZURE_MI_CLIENT_ID
  delete process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT
})

afterAll(() => {
  restoreEnv()
  resetTelemetryReaderCache()
})

describe('getTelemetryReader memoisation', () => {
  it('returns the SAME instance for the same config on repeated calls', () => {
    const a = getTelemetryReader()
    const b = getTelemetryReader()
    expect(a).toBeInstanceOf(LogAnalyticsReader)
    expect(b).toBe(a)
  })

  it('a different lookback is a different reader, and each keeps its own applied window', () => {
    const steady = getTelemetryReader()
    const recovery = getTelemetryReader({ lookbackDays: 90 })
    expect(recovery).not.toBe(steady)
    expect(recovery.appliedLookbackDays).toBe(90)
    expect(steady.appliedLookbackDays).toBe(7)
    // And asking again for either lands on the memoised one.
    expect(getTelemetryReader({ lookbackDays: 90 })).toBe(recovery)
    expect(getTelemetryReader()).toBe(steady)
  })

  it('a changed env resolves to a new reader rather than the stale one', () => {
    const before = getTelemetryReader()
    process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID = 'ws-other'
    const after = getTelemetryReader()
    expect(after).not.toBe(before)
  })

  it('resetTelemetryReaderCache forgets — the next call builds afresh', () => {
    const before = getTelemetryReader()
    resetTelemetryReaderCache()
    expect(getTelemetryReader()).not.toBe(before)
  })

  it('the local collector reader is memoised the same way', () => {
    process.env.NUXT_TELEMETRY_READER = 'local'
    process.env.NUXT_AZURE_MONITOR_ENDPOINT = 'http://127.0.0.1:4318'
    expect(getTelemetryReader()).toBe(getTelemetryReader())
    expect(getTelemetryReader()).not.toBeInstanceOf(LogAnalyticsReader)
  })
})
