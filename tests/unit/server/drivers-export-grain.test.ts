// @vitest-environment node
/*
 * The chargeback export GRAIN, as pure functions.
 *
 * `tests/integration/reports/billed-drivers.test.ts` proves the coverage
 * property end to end against a real database. The assertion here does not need
 * one and cannot cheaply have one: an arm with NO rows still gets a line, and
 * reaching that state through the endpoint means a window the transform has not
 * covered for exactly one provider — arrangeable, but the property is about the
 * serialiser.
 */
import { describe, it, expect } from 'vitest'
import { driverArmCsvLines } from '../../../server/reporting/params'
import type { BilledAxisArm, BilledLaneMeta, DriverRow } from '../../../shared/reports/types'

const row = (label: string, usd: number, spendClass: DriverRow['spendClass'] = 'billed'): DriverRow => ({
  key: label,
  label,
  usd,
  sharePct: 0,
  spendClass,
})

const armOf = (over: Partial<BilledAxisArm>): BilledAxisArm => ({
  id: 'anthropic:billed',
  provider: 'anthropic',
  measure: 'billed',
  source: 'provider_usage_fact',
  availability: 'present',
  totalUsd: 0,
  rows: [],
  ...over,
})

const laneOf = (arms: BilledAxisArm[]): BilledLaneMeta => ({
  availability: 'present',
  billedUsd: 0,
  consumptionUsd: 0,
  arms,
})

describe('the arm block names every arm, including the empty one', () => {
  it('emits one line per (arm, driver), with the measure and the relation', () => {
    const lines = driverArmCsvLines(
      laneOf([
        armOf({ totalUsd: 100, rows: [row('Alice', 60), row('Bob', 40)] }),
        armOf({
          id: 'github:pooled-chargeback',
          provider: 'github',
          measure: 'pooled-chargeback',
          source: 'v_finance_copilot_pool_chargeback',
          totalUsd: 25,
          rows: [row('Platform', 25)],
        }),
      ]),
    )
    expect(lines).toContain('provider,measure,source,availability,arm_total_usd,driver,spend_usd')
    expect(lines).toContain('anthropic,billed,provider_usage_fact,present,100.00,Alice,60.00')
    expect(lines).toContain('anthropic,billed,provider_usage_fact,present,100.00,Bob,40.00')
    expect(lines).toContain(
      'github,pooled-chargeback,v_finance_copilot_pool_chargeback,present,25.00,Platform,25.00',
    )
  })

  it('gives a row-less arm a line of its own — "not derived yet" is information', () => {
    const lines = driverArmCsvLines(
      laneOf([armOf({ provider: 'github', measure: 'consumption', id: 'github:consumption', availability: 'no-data-yet' })]),
    )
    expect(lines).toContain('github,consumption,provider_usage_fact,no-data-yet,0.00,,')
  })

  it('adds nothing at all when the answer is not a billed one', () => {
    // The attributed export stays byte-for-byte what it was.
    expect(driverArmCsvLines(undefined)).toEqual([])
  })

  it('carries the coverage statement, gaps included', () => {
    const lines = driverArmCsvLines(undefined, {
      providers: ['anthropic'],
      gaps: [{ provider: 'github', reason: 'Copilot bills pooled per cost centre.' }],
    })
    expect(lines).toContain('# chargeback_providers=anthropic')
    expect(lines).toContain('# gap · github · Copilot bills pooled per cost centre.')
  })

  it('says `none` rather than nothing when no provider answers the axis', () => {
    // The budget axis. An empty field would read as "not computed"; `none` is the
    // measured answer.
    const lines = driverArmCsvLines(undefined, {
      providers: [],
      gaps: [{ provider: null, reason: 'No provider bills at project grain.' }],
    })
    expect(lines).toContain('# chargeback_providers=none')
    expect(lines).toContain('# gap · all providers · No provider bills at project grain.')
  })
})
