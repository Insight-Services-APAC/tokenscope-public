// @vitest-environment node
/*
 * #592: the five device states, decided in one place. The rows here cover the
 * edges a person would notice: a device connected a minute ago is not "not in
 * use", and a fault outranks everything but revocation.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  instanceProjectionWindow,
  projectInstanceRow,
  type InstanceMetricRow,
} from '../../../server/utils/instance-projection'

const NOW = new Date('2026-11-11T12:00:00.000Z')
const window = instanceProjectionWindow(NOW)
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()

function row(over: Partial<InstanceMetricRow>): InstanceMetricRow {
  return {
    instance_id: '9a1e0000-0000-4000-8000-000000000001',
    tool: 'claude-code',
    display_name: null,
    raw_project_code: null,
    ts_start: ago(200),
    ts_actual_end: null,
    last_emission: null,
    spend_usd_mtd: '0',
    cannot_send: false,
    ...over,
  }
}
const stateOf = (over: Partial<InstanceMetricRow>) => projectInstanceRow(row(over), window).state

describe('device state (#592)', () => {
  it('usage in the last 24 hours is sending', () => {
    expect(stateOf({ last_emission: ago(0.5) })).toBe('sending')
  })

  it('usage 3 days ago is idle', () => {
    expect(stateOf({ last_emission: ago(3) })).toBe('idle')
  })

  it('usage 31 days ago is not in use', () => {
    expect(stateOf({ last_emission: ago(31) })).toBe('not-in-use')
  })

  it('never used and connected over 30 days ago is not in use', () => {
    expect(stateOf({ last_emission: null, ts_start: ago(31) })).toBe('not-in-use')
  })

  it('never used and connected recently is idle, so no Revoke beside a new device', () => {
    expect(stateOf({ last_emission: null, ts_start: ago(0.01) })).toBe('idle')
  })

  it('a rejected credential is cannot-send, whatever the usage says', () => {
    expect(stateOf({ last_emission: ago(0.5), cannot_send: true })).toBe('cannot-send')
    expect(stateOf({ last_emission: ago(90), cannot_send: true })).toBe('cannot-send')
  })

  it('revoked outranks a fault', () => {
    expect(stateOf({ ts_actual_end: ago(1), cannot_send: true })).toBe('revoked')
  })
})

describe('the badge and the bell read one signal (#592)', () => {
  const read = (p: string) => readFileSync(p, 'utf8')

  it('the projection and the inbox worker use the same open-failure predicate', () => {
    expect(read('server/utils/instance-projection.ts')).toContain('openBearerFailureExists(')
    expect(read('server/workers/went-silent.ts')).toContain('openBearerFailureExists(')
  })
})
