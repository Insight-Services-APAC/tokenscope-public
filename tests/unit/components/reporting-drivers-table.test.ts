// @vitest-environment happy-dom
/*
 * DriversTable — the spend-class-aware breakdown. The load-bearing invariants:
 *  - the sum-back check row goes RED when Σ(rows) ≠ headline (drivers must
 *    reconcile in the same lane);
 *  - any `pooled-usage` row FORCES the informational footer (Copilot per-seat
 *    share is never a charge, owner-decisions D-Q6);
 *  - `drill` / `update:axis` emit contracts.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DriversTable from '../../../app/components/reporting/DriversTable.vue'
import type { DriverRow } from '#shared/reports/types'

const AXES = [
  { value: 'teammate', label: 'By teammate' },
  { value: 'model', label: 'By model' },
]

function rows(): DriverRow[] {
  return [
    { key: 'a', label: 'Ada', usd: 60, sharePct: 0.6, spendClass: 'estimated' },
    { key: 'b', label: 'Grace', usd: 40, sharePct: 0.4, spendClass: 'estimated' },
  ]
}

function mountTable(overrides = {}) {
  return mount(DriversTable, {
    props: {
      rows: rows(),
      headlineUsd: 100,
      axis: 'teammate',
      axisOptions: AXES,
      denominatorLabel: 'region usage',
      ...overrides,
    },
  })
}

describe('DriversTable sum-back check row', () => {
  it('reconciles (not red) when Σ(rows) equals the headline', () => {
    const w = mountTable({ headlineUsd: 100 })
    const sumback = w.find('[data-testid="drivers-sumback"]')
    expect(sumback.attributes('data-mismatch')).toBe('false')
    expect(sumback.classes()).not.toContain('text-rag-red')
    expect(sumback.text()).toContain('reconciles to headline')
  })

  it('goes RED when Σ(rows) ≠ the headline', () => {
    const w = mountTable({ headlineUsd: 90 })
    const sumback = w.find('[data-testid="drivers-sumback"]')
    expect(sumback.attributes('data-mismatch')).toBe('true')
    expect(sumback.classes()).toContain('text-rag-red')
    expect(sumback.text()).toContain('does not reconcile')
  })
})

describe('DriversTable pooled-usage footer', () => {
  it('is absent when no pooled-usage row and no pooledFooter', () => {
    const w = mountTable()
    expect(w.find('[data-testid="drivers-pooled-footer"]').exists()).toBe(false)
  })

  it('is FORCED with the exact copy on any pooled-usage row', () => {
    const pooled: DriverRow[] = [
      { key: 'a', label: 'Ada', usd: 60, sharePct: 0.6, spendClass: 'pooled-usage' },
      { key: 'b', label: 'Grace', usd: 40, sharePct: 0.4, spendClass: 'estimated' },
    ]
    const w = mountTable({ rows: pooled })
    const footer = w.find('[data-testid="drivers-pooled-footer"]')
    expect(footer.exists()).toBe(true)
    expect(footer.text()).toBe('per-seat share is informational — billing is pooled')
  })

  it('renders pooledFooter override when supplied and no pooled row', () => {
    const w = mountTable({ pooledFooter: 'chargeable only' })
    expect(w.find('[data-testid="drivers-pooled-footer"]').text()).toBe('chargeable only')
  })
})

describe('DriversTable estimated spend-class treatment', () => {
  it('mutes + badges estimated rows (advisory, not a billed charge — shared/reports/types)', () => {
    // The default rows are both spendClass 'estimated'.
    const w = mountTable()
    // Each estimated spend cell is muted (italic / carbon-3) and titled as informational —
    // it must NOT render identical to a hard billed charge.
    const informational = w.findAll('td[title="informational — not a charge"]')
    expect(informational.length).toBe(2)
    for (const c of informational) {
      expect(c.classes()).toContain('italic')
      expect(c.classes()).toContain('text-carbon-3')
    }
    // Each estimated row carries an "estimated" badge.
    expect(w.find('tbody').text()).toContain('estimated')
  })

  it('does NOT force the pooled footer for estimated rows (only pooled-usage does)', () => {
    const w = mountTable() // estimated rows, no pooledFooter
    expect(w.find('[data-testid="drivers-pooled-footer"]').exists()).toBe(false)
  })
})

describe('DriversTable emits', () => {
  /*
   * THE DRILL CONTRACT (developer pages D29, fix 7): a row is a LINK, an
   * in-page ACTION, or PLAIN TEXT — never a button that does nothing. The
   * `drill` emit survives only for the `action` kind (the regional practice
   * pivot), and only when the caller says so.
   */
  it('emits drill only for a row the caller declares an ACTION', async () => {
    const w = mountTable({ drillable: () => ({ kind: 'action' as const }) })
    await w.findAll('[data-testid="drivers-drill"]')[0]!.trigger('click')
    expect(w.emitted('drill')?.[0]?.[0]).toMatchObject({ key: 'a', label: 'Ada' })
  })

  it('with NO drillable prop every row is plain text — no button, no link', () => {
    const w = mountTable()
    expect(w.find('[data-testid="drivers-drill"]').exists()).toBe(false)
    expect(w.find('[data-testid="drivers-drill-link"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="drivers-plain"]').length).toBe(2)
    expect(w.emitted('drill')).toBeUndefined()
  })

  /*
   * The pivot is CHIPS, not a dropdown (prototype.html lines 783-785): every axis
   * a reader may ask for is on screen, so switching is one click. Asserted as a
   * BUTTON press — `setValue` on the old <select> is exactly what stops working
   * if the control regresses to one.
   */
  it('emits update:axis when a pivot chip is pressed', async () => {
    const w = mountTable()
    await w.find('[data-testid="drivers-axis-model"]').trigger('click')
    expect(w.emitted('update:axis')?.[0]).toEqual(['model'])
  })

  it('renders one chip per axis, with the active one pressed and no <select>', () => {
    const w = mountTable()
    const chips = w.findAll('[data-testid="drivers-axis"] button')
    expect(chips.map((c) => c.text())).toEqual(['By teammate', 'By model'])
    expect(w.find('[data-testid="drivers-axis"] select').exists()).toBe(false)
    expect(w.find('[data-testid="drivers-axis-teammate"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="drivers-axis-model"]').attributes('aria-pressed')).toBe('false')
  })

  it('re-pressing the ACTIVE chip emits nothing', () => {
    const w = mountTable()
    w.find('[data-testid="drivers-axis-teammate"]').trigger('click')
    expect(w.emitted('update:axis')).toBeUndefined()
  })
})

// ── Surface mix (requirement 3 — "teammate drivers discard client/tool") ─────
describe('DriversTable surface mix column', () => {
  function rowsWithBreakdown(): DriverRow[] {
    return [
      {
        key: 'a',
        label: 'Ada',
        usd: 60,
        sharePct: 0.6,
        spendClass: 'indicative',
        surfaceBreakdown: [
          { lane: 'claude', label: 'Claude Code', usd: 40 },
          { lane: 'copilot', label: 'Copilot', usd: 20 },
        ],
      },
      { key: 'b', label: 'Grace', usd: 40, sharePct: 0.4, spendClass: 'indicative' }, // no breakdown
    ]
  }

  it('is ABSENT when no row carries a surfaceBreakdown (practice/model axes, unchanged layout)', () => {
    const w = mountTable()
    expect(w.text()).not.toContain('Surface mix')
    // Base layout: label + share-of-spend bar + value + one right-hand column, so
    // the sum-back row's label cell spans the two non-numeric ones.
    const sumbackFirstCell = w.find('[data-testid="drivers-sumback"] td')
    expect(sumbackFirstCell.attributes('colspan')).toBe('2')
  })

  it('renders a per-lane stacked indicator whose segments sum to the row usd, with a muted placeholder for rows without one', () => {
    const w = mountTable({ rows: rowsWithBreakdown() })
    expect(w.text()).toContain('Surface mix')
    const adaMix = w.find('[data-testid="drivers-surface-mix-a"]')
    expect(adaMix.exists()).toBe(true)
    expect(adaMix.attributes('aria-label')).toContain('Claude Code')
    expect(adaMix.attributes('aria-label')).toContain('Copilot')
    expect(adaMix.findAll('div[title]')).toHaveLength(2)
    // Grace (no breakdown) gets the muted em-dash placeholder, not a fabricated bar.
    expect(w.find('[data-testid="drivers-surface-mix-b"]').exists()).toBe(false)
  })

  it('shows the shared LaneLegend above the table when any row has a breakdown', () => {
    const w = mountTable({ rows: rowsWithBreakdown() })
    expect(w.find('[data-testid="lane-legend"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend-claude"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-legend-copilot"]').exists()).toBe(true)
  })
})

// ── Usage provenance (requirement 4) ──────────────────────────────────────────
describe('DriversTable usage provenance tooltip', () => {
  it('a single-provenance row names it plainly', () => {
    const single: DriverRow[] = [
      {
        key: 'a',
        label: 'Ada',
        usd: 40,
        sharePct: 1,
        spendClass: 'indicative',
        provenanceBreakdown: [{ provenance: 'otel-emitted', usd: 40 }],
      },
    ]
    const w = mountTable({ rows: single, headlineUsd: 40 })
    // The tooltip rides the NAME in whichever state the drill contract renders
    // it; with no drillable prop that is the plain-text span.
    const btn = w.find('[data-testid="drivers-plain"]')
    expect(btn.attributes('title')).toContain('OTel-emitted')
  })

  it('a BLENDED row (requirement 4 — "a blended row may carry per-provenance breakdown") states the split', () => {
    const blended: DriverRow[] = [
      {
        key: 'a',
        label: 'Ada',
        usd: 48,
        sharePct: 1,
        spendClass: 'indicative',
        provenanceBreakdown: [
          { provenance: 'otel-emitted', usd: 40 },
          { provenance: 'provider-usage', usd: 8 },
        ],
      },
    ]
    const w = mountTable({ rows: blended, headlineUsd: 48 })
    const btn = w.find('[data-testid="drivers-plain"]')
    expect(btn.attributes('title')).toContain('blended')
    expect(btn.attributes('title')).toContain('OTel-emitted')
    expect(btn.attributes('title')).toContain('provider usage')
  })

  it('a row with no provenanceBreakdown carries no tooltip (region/practice axes, unaffected)', () => {
    const w = mountTable()
    const btn = w.find('[data-testid="drivers-plain"]')
    expect(btn.attributes('title')).toBeUndefined()
  })
})

// ── Against budget (04-prototype-delta.md §5b — the cost-centre Budgets hero) ─
describe('DriversTable against-budget column', () => {
  function budgetRows(): DriverRow[] {
    return [
      // 87% of $6,024 — the shape the design names verbatim.
      { key: 'p1', label: 'Apollo', usd: 5240.88, sharePct: 0.7, spendClass: 'indicative', budgetUsd: 6024 },
      // A real budget row with NO allocation set: a missing decision, not $0 spent.
      { key: 'p2', label: 'Borealis', usd: 2246.09, sharePct: 0.3, spendClass: 'indicative', budgetUsd: null },
    ]
  }

  /** The header cells, in order — the columns a reader is told they are reading. */
  const headers = (w: ReturnType<typeof mountTable>) =>
    w.findAll('thead th').map((th) => th.text())

  it('is ABSENT on an axis with no budget concept — the % column stands in its place', () => {
    const w = mountTable()
    expect(w.text()).not.toContain('Against budget')
    expect(headers(w).at(-1)).toBe('%')
    expect(w.find('[data-testid="drivers-budget-a"]').exists()).toBe(false)
  })

  it('renders CONSUMPTION against the row’s own budget, not a share of the scope', () => {
    const w = mountTable({ rows: budgetRows(), headlineUsd: 7486.97 })
    expect(w.find('thead').text()).toContain('Against budget')
    const apollo = w.find('[data-testid="drivers-budget-p1"]').text().replace(/\s+/g, ' ')
    expect(apollo).toContain('87%')
    expect(apollo).toContain('$6,024.00')
    // The % column is REPLACED, not joined: two competing right-hand numbers is
    // exactly what the budget column exists to remove. Asserted on the LAST header
    // cell rather than on the whole header's text, because the magnitude bar's own
    // column is legitimately called "Share of spend" and is not a second number.
    expect(headers(w).at(-1)).toBe('Against budget')
    expect(headers(w)).not.toContain('%')
  })

  it('says "no budget set" for a null allocation — never 0% and never $0', () => {
    const w = mountTable({ rows: budgetRows(), headlineUsd: 7486.97 })
    const cell = w.find('[data-testid="drivers-budget-p2"]')
    expect(cell.text()).toContain('no budget set')
    expect(cell.text()).not.toContain('%')
    expect(cell.text()).not.toContain('$0')
  })

  it('a ZERO allocation reads as no budget, never as an infinite consumption', () => {
    // usd / 0 is Infinity; "∞% of $0.00" is noise where "no budget set" is true.
    const w = mountTable({
      rows: [{ key: 'z', label: 'Zed', usd: 40, sharePct: 1, spendClass: 'indicative', budgetUsd: 0 }],
      headlineUsd: 40,
    })
    const cell = w.find('[data-testid="drivers-budget-z"]').text()
    expect(cell).toContain('no budget set')
    expect(cell).not.toContain('Infinity')
    expect(cell).not.toContain('NaN')
  })

  it('the column appears even when EVERY row is unbudgeted — that is the finding', () => {
    // Presence is keyed on the field EXISTING, not on it being truthy: a cost
    // centre whose every budget is unset must look like unset budgets, not like
    // an axis that has no budgets at all.
    const w = mountTable({
      rows: [
        { key: 'p1', label: 'Apollo', usd: 60, sharePct: 0.6, spendClass: 'indicative', budgetUsd: null },
        { key: 'p2', label: 'Borealis', usd: 40, sharePct: 0.4, spendClass: 'indicative', budgetUsd: null },
      ],
    })
    expect(w.find('thead').text()).toContain('Against budget')
    expect(w.find('[data-testid="drivers-budget-p1"]').text()).toContain('no budget set')
  })
})

// ── Model tier mix — Track D's banding, rendered here (04-prototype-delta §5) ─
describe('DriversTable model-tier column (the fetchTierExposure seam)', () => {
  function tierRows(): DriverRow[] {
    return [
      {
        key: 'vm',
        label: 'ada.lovelace',
        usd: 100,
        sharePct: 0.625,
        spendClass: 'indicative',
        tierBreakdown: [
          { band: 'frontier', label: 'Frontier', usd: 81 },
          { band: 'workhorse', label: 'Mid', usd: 14 },
          { band: 'lightweight', label: 'Economy', usd: 5 },
        ],
      },
      { key: 'ah', label: 'Ahmed', usd: 60, sharePct: 0.375, spendClass: 'indicative' },
    ]
  }

  it('is ABSENT until the banding primitive populates it — absence is "not available"', () => {
    // The seam ships unwired. A column rendering empty bars would read as "no
    // frontier usage", which is a claim the data does not make.
    const w = mountTable()
    expect(w.text()).not.toContain('Model tier')
    expect(w.find('[data-testid="drivers-tier-legend"]').exists()).toBe(false)
  })

  it('renders a per-band stacked indicator when a row carries tierBreakdown', () => {
    const w = mountTable({ rows: tierRows(), headlineUsd: 160 })
    expect(w.find('thead').text()).toContain('Model tier')
    const mix = w.find('[data-testid="drivers-tier-mix-vm"]')
    expect(mix.exists()).toBe(true)
    expect(mix.findAll('div[title]')).toHaveLength(3)
    expect(mix.attributes('aria-label')).toContain('Frontier')
    expect(mix.attributes('aria-label')).toContain('Economy')
    // A row without the field gets the muted placeholder, never a fabricated bar.
    expect(w.find('[data-testid="drivers-tier-mix-ah"]').exists()).toBe(false)
  })

  it('legends the bands in the shared cost order, never the order the data arrived in', () => {
    const w = mountTable({
      rows: [
        {
          key: 'x',
          label: 'X',
          usd: 100,
          sharePct: 1,
          spendClass: 'indicative',
          // Deliberately economy-first on the wire.
          tierBreakdown: [
            { band: 'lightweight', label: 'Economy', usd: 50 },
            { band: 'frontier', label: 'Frontier', usd: 50 },
          ],
        },
      ],
      headlineUsd: 100,
    })
    const legend = w.find('[data-testid="drivers-tier-legend"]')
    expect(legend.exists()).toBe(true)
    const order = legend.findAll('[role="listitem"]').map((e) => e.text())
    expect(order).toEqual(['Frontier', 'Economy'])
  })

  it('the sum-back row still spans every non-numeric column with the mix present', () => {
    // A colspan that forgot a new column silently misaligns the reconciliation
    // figures under the wrong headers — the one row a reader trusts to add up.
    const w = mountTable({ rows: tierRows(), headlineUsd: 160 })
    expect(w.find('[data-testid="drivers-sumback"] td').attributes('colspan')).toBe('3')
    const headerCells = w.findAll('thead th').length
    const sumbackCells = w.findAll('[data-testid="drivers-sumback"] td')
    const spanned = sumbackCells.reduce((a, c) => a + Number(c.attributes('colspan') ?? 1), 0)
    expect(spanned).toBe(headerCells)
  })
})

// ── No selector: the cost-centre heroes render two fixed lists ────────────────
describe('DriversTable with no axis options', () => {
  it('renders no pivot control at all', () => {
    const w = mountTable({ axisOptions: [] })
    expect(w.find('[data-testid="drivers-axis"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Break down by')
    // …and the rest of the table is untouched.
    expect(w.find('[data-testid="drivers-sumback"]').attributes('data-mismatch')).toBe('false')
    expect(w.find('tbody').text()).toContain('Ada')
  })
})

/*
 * prototype.html lines 812-817: "Two bars on one row read as two data series
 * unless the columns are named. They were not, and the second one was
 * unreadable."
 *
 * So every column carries a word, and two of those words are NOT this component's
 * to choose: the label column is the ACTIVE PIVOT's word (a chip reading
 * "Teammate" over a column headed "Driver" makes the reader do the join), and the
 * value column is the CALLER's, because only the caller knows which period its
 * rows cover.
 */
describe('DriversTable names every column', () => {
  const headers = (w: ReturnType<typeof mountTable>) =>
    w.findAll('thead th').map((th) => th.text())

  it('heads the label column with the ACTIVE axis’s own word', () => {
    expect(headers(mountTable()).at(0)).toBe('By teammate')
    expect(headers(mountTable({ axis: 'model' })).at(0)).toBe('By model')
  })

  it('falls back to the caller’s word when there is no axis to name it', () => {
    // The heroes: one fixed axis each, no chips, so the column word is a prop.
    expect(headers(mountTable({ axisOptions: [], axis: '' })).at(0)).toBe('Driver')
    expect(
      headers(mountTable({ axisOptions: [], axis: '', labelColumnLabel: 'Budget' })).at(0),
    ).toBe('Budget')
  })

  it('heads the value column with the CALLER’s period word, never a hardcoded month', () => {
    expect(headers(mountTable()).at(-2)).toBe('Spend')
    expect(headers(mountTable({ valueColumnLabel: 'July 2026' })).at(-2)).toBe('July 2026')
  })

  it('names the magnitude bar column and renders one bar per row', () => {
    const w = mountTable()
    expect(headers(w)).toContain('Share of spend')
    // Scaled against the LARGEST row (60), not the headline (100): the leader is
    // full width and the second row is 40/60.
    expect(w.find('[data-testid="drivers-bar-a"] span').attributes('style')).toContain('width: 100.0%')
    expect(w.find('[data-testid="drivers-bar-b"] span').attributes('style')).toContain('width: 66.7%')
    expect(w.find('[data-testid="drivers-bar-a"]').attributes('aria-label')).toBe(
      'Ada: 60% of region usage',
    )
  })

  it('renders a zero-width bar rather than NaN when nothing has spend', () => {
    const w = mountTable({
      rows: [{ key: 'z', label: 'Zed', usd: 0, sharePct: 0, spendClass: 'estimated' as const }],
      headlineUsd: 0,
    })
    expect(w.find('[data-testid="drivers-bar-z"] span').attributes('style')).toContain('width: 0%')
    expect(w.html()).not.toContain('NaN')
  })
})

/*
 * The budget column has THREE states, and the two absences are different facts.
 * `budgetUsd: null` is "no budget set" — a decision nobody has made about a row
 * that could hold one. The field being ABSENT means the row has no budget concept
 * at all (the untagged bucket; the folded "(all other — N projects)" remainder,
 * whose several allocations cannot be one percentage). Rendering the second as the
 * first states something false about it.
 */
describe('DriversTable distinguishes "no budget set" from "no budget to set"', () => {
  const mixed = () =>
    mountTable({
      rows: [
        { key: 'p1', label: 'Apollo', usd: 60, sharePct: 0.4, spendClass: 'indicative' as const, budgetUsd: 100 },
        { key: 'p2', label: 'Borealis', usd: 30, sharePct: 0.2, spendClass: 'indicative' as const, budgetUsd: null },
        // No `budgetUsd` key at all — the untagged bucket.
        { key: '__null_project', label: 'Untagged', usd: 60, sharePct: 0.4, spendClass: 'indicative' as const },
      ],
      headlineUsd: 150,
    })

  it('an unset allocation says "no budget set"', () => {
    expect(mixed().find('[data-testid="drivers-budget-p2"]').text()).toContain('no budget set')
  })

  it('a row with NO budget concept says neither "no budget set" nor a percentage', () => {
    const cell = mixed().find('[data-testid="drivers-budget-__null_project"]')
    expect(cell.text()).not.toContain('no budget set')
    expect(cell.text()).not.toContain('%')
    expect(cell.text()).toContain('—')
  })
})
