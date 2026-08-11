// @vitest-environment node
/*
 * The two behaviour CSVs — the columns 04-prototype-delta.md §7 asks for, and
 * the two places a CSV can lie by writing a number where there is none.
 */
import { describe, it, expect } from 'vitest'
import { tierExposureToCsv, perDeveloperToCsv } from '../../../../server/reporting/behaviour-csv'
import { buildTierExposure } from '../../../../server/reporting/engine/tier-exposure'
import { buildPerDeveloperSeries } from '../../../../shared/reports/per-developer'
import type { CatalogEntry } from '../../../../server/usage/insights'

const CATALOG: CatalogEntry[] = [
  { model_pattern: 'opus', tier: 'frontier', sort_order: 20 },
  { model_pattern: 'gpt-5-mini', tier: 'lightweight', sort_order: 50 },
  { model_pattern: 'gpt-5', tier: 'frontier', sort_order: 70 },
]
const WINDOW = { from: '2026-06-01', to: '2026-06-02' }
const META = { scopeLabel: 'the whole company', asOfDate: '2026-06-02' }

const fact = (over: Record<string, unknown>) => ({
  provider: 'anthropic',
  model: null as string | null,
  context_window: null as string | null,
  day: '2026-06-01',
  spend: '0',
  tokens: '0',
  token_rows: 0,
  interactions: '0',
  interaction_rows: 0,
  ...over,
})

describe('tierExposureToCsv', () => {
  const exposure = buildTierExposure(
    [
      fact({ model: 'claude-opus-5', spend: '90.00' }),
      fact({ model: 'claude-opus-5', tokens: '300', token_rows: 1 }),
      fact({ model: 'gpt-5-mini', spend: '10.00' }),
    ],
    CATALOG,
    new Set(['anthropic']),
    WINDOW,
  )
  const csv = tierExposureToCsv(exposure, META)
  const lines = csv.trim().split('\n')
  const header = lines.find((l) => l.startsWith('band,'))!

  it('publishes the columns the design asks for, in order', () => {
    expect(header).toBe('band,provider,spend_usd,consumption,unit,period_start')
  })

  it('leaves consumption EMPTY, never 0, for a band nothing counted', () => {
    // gpt-5-mini has money and no token row. `0` would put it in the volume
    // column and assert the work moved no tokens.
    const row = lines.find((l) => l.startsWith('Economy,anthropic,10.00'))!
    expect(row).toBe('Economy,anthropic,10.00,,tokens,2026-06-01')
    // The counted band writes its real figure.
    expect(lines).toContain('Frontier,anthropic,90.00,300,tokens,2026-06-01')
  })

  it('names a `no-data-yet` provider rather than emitting zero rows for it', () => {
    // Six $0.00 rows would read as "Copilot spent nothing", which is a claim
    // about spending rather than about an adapter that has not been written.
    const github = lines.filter((l) => l.includes(',github,'))
    expect(github).toEqual(['(no data yet),github,,,interactions,2026-06-01'])
  })

  it('carries a mix-only provider’s credits on their own unbanded row', () => {
    const mixed = buildTierExposure(
      [fact({ provider: 'github', model: 'gpt-5-mini', spend: '250.00' })],
      CATALOG,
      new Set(['anthropic', 'github']),
      WINDOW,
    )
    const out = tierExposureToCsv(mixed, META).trim().split('\n')
    expect(out).toContain('(unbanded — day grain),github,250.00,,interactions,2026-06-01')
    // …and never inside a band.
    expect(out.filter((l) => /^(Frontier|Mid|Economy),github,(?!0\.00)/.test(l))).toEqual([])
  })
})

describe('perDeveloperToCsv', () => {
  it('publishes the columns the design asks for, and a gap stays empty', () => {
    const series = buildPerDeveloperSeries(
      [
        { day: '2026-06-01', genuineUsd: 300, activeUsers: 12 },
        { day: '2026-06-02', genuineUsd: 0, activeUsers: 0 },
      ],
      { from: '2026-06-01', to: '2026-06-02' },
    )
    const lines = perDeveloperToCsv(series, META).trim().split('\n')
    expect(lines).toContain('day,spend_usd,active_developers,per_developer_usd')
    expect(lines).toContain('2026-06-01,300.00,12,25.00')
    // The gap the line draws — NOT `0.00`, which would assert a per-head figure
    // for a day that had no heads.
    expect(lines).toContain('2026-06-02,0.00,0,')
  })

  it('says the deltas were withheld rather than omitting the fact', () => {
    const series = buildPerDeveloperSeries(
      [{ day: '2026-06-01', genuineUsd: 10, activeUsers: 1 }],
      { from: '2026-06-01', to: '2026-06-01' },
    )
    expect(perDeveloperToCsv(series, META)).toContain('# deltas withheld')
  })

  it('states the three deltas in the header, over one window', () => {
    const half = (spend: number, devs: number, off: number) =>
      Array.from({ length: 30 }, (_, i) => ({
        day: `2026-0${off}-${String(i + 1).padStart(2, '0')}`,
        genuineUsd: spend,
        activeUsers: devs,
      }))
    const series = buildPerDeveloperSeries([...half(100, 10, 5), ...half(200, 20, 6)], {
      from: '2026-05-01',
      to: '2026-06-30',
    })
    const csv = perDeveloperToCsv(series, META)
    expect(csv).toContain('per head +0.0%')
    expect(csv).toContain('active developers +100.0%')
    expect(csv).toContain('total spend +100.0%')
  })

  it('carries the daily-mean caveat with the figures it qualifies', () => {
    const series = buildPerDeveloperSeries([{ day: '2026-06-01', genuineUsd: 1, activeUsers: 1 }], {
      from: '2026-06-01',
      to: '2026-06-01',
    })
    expect(perDeveloperToCsv(series, META)).toMatch(/not the number of distinct people/)
  })
})
