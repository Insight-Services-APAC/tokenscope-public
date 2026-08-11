// @vitest-environment happy-dom
/*
 * DriversTable in the BILLED lane.
 *
 * The one thing this file exists to stop shipping: real invoiced money rendered
 * MUTED under the title "informational — not a charge". Every pre-existing
 * SpendClass is informational, so repointing the drivers at
 * `provider_usage_fact` without a new class would have labelled the provider's
 * own bill not-a-charge — the worst direction for that error to run, and the
 * reason `'billed'` was added rather than the rows being reused under
 * `'indicative'`.
 *
 * It also pins the two statements the table must make ABOUT the lane rather than
 * leaving a reader to infer them: an empty billed lane is "not derived yet", not
 * "$0 spent"; and Copilot's credits sit in their own block, below the billed
 * total and never inside it.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DriversTable from '../../../app/components/reporting/DriversTable.vue'
import type { BilledLaneMeta, DriverRow } from '../../../shared/reports/types'

function row(over: Partial<DriverRow> = {}): DriverRow {
  return {
    key: 'claude-opus-5',
    label: 'claude-opus-5',
    usd: 411.25,
    sharePct: 0.82,
    spendClass: 'billed',
    ...over,
  }
}

function billedLane(over: Partial<BilledLaneMeta> = {}): BilledLaneMeta {
  return {
    availability: 'present',
    billedUsd: 411.25,
    consumptionUsd: 0,
    arms: [],
    ...over,
  }
}

const mountTable = (props: Record<string, unknown>) =>
  mount(DriversTable, {
    props: { rows: [row()], headlineUsd: 411.25, denominatorLabel: 'region billed spend', ...props },
  })

describe('a billed row is a hard dollar', () => {
  it('renders unmuted, with no "not a charge" title and no badge', () => {
    const w = mountTable({})
    const cell = w.findAll('td').find((td) => td.text().includes('411.25'))!
    expect(cell.attributes('title')).toBeUndefined()
    expect(cell.classes()).not.toContain('italic')
    expect(cell.classes()).toContain('text-carbon-1')
    // A badge is this table's marker for "read this with a caveat". Billed money
    // has none.
    expect(w.text()).not.toContain('indicative')
    expect(w.text()).not.toContain('pooled')
  })

  it('still mutes every per-row informational class beside it', () => {
    // The mutation guard for the assertion above: if `isInformational` were
    // widened to include 'billed' (or narrowed to include nothing), one of these
    // two tests goes red. `pooled-usage` is the class used here rather than
    // `indicative`, which is now a CARD-level statement — see the describe below.
    const w = mountTable({
      rows: [row({ key: 'x', label: 'Pooled row', usd: 12.5, spendClass: 'pooled-usage' })],
      headlineUsd: 12.5,
    })
    const cell = w.findAll('td').find((td) => td.text().includes('12.50'))!
    expect(cell.attributes('title')).toBe('informational — not a charge')
    expect(cell.classes()).toContain('italic')
  })
})

/*
 * prototype.html `note('fix 4', …)`: "The *indicative* pill on every row is also
 * unexplained — if a figure needs a caveat on every row, the caveat belongs in
 * the card, once."
 *
 * `indicative` is on EVERY row of every attributed table, so per-row marking told
 * a reader nothing one sentence does not. What must NOT be lost is the caveat
 * itself, which is why both halves are asserted here: no per-row marking, AND the
 * card-level statement present.
 */
describe('the `indicative` caveat is the CARD’s, once — never a pill per row', () => {
  const indicative = (over: Partial<DriverRow> = {}) =>
    row({ key: 'i', label: 'Atlas', usd: 12.5, spendClass: 'indicative', ...over })

  it('an indicative row carries no badge and is not muted', () => {
    const w = mountTable({ rows: [indicative()], headlineUsd: 12.5 })
    const cell = w.findAll('td').find((td) => td.text().includes('12.50'))!
    expect(cell.attributes('title')).toBeUndefined()
    expect(cell.classes()).not.toContain('italic')
    // The word appears ONCE, in the card statement — never beside the figure.
    expect(w.findAll('[data-testid="drivers-indicative-note"]')).toHaveLength(1)
    expect(w.find('td').text()).not.toContain('indicative')
  })

  it('an all-indicative table says so of EVERY figure', () => {
    const w = mountTable({
      rows: [indicative(), indicative({ key: 'j', label: 'Borealis', usd: 7.5 })],
      headlineUsd: 20,
    })
    expect(w.find('[data-testid="drivers-indicative-note"]').text()).toBe(
      'Every figure here is attributed usage — indicative, not a billed charge.',
    )
  })

  it('a MIXED table qualifies only the unbadged rows', () => {
    // The claim has to narrow when the table is not uniform: the pooled row beside
    // it is a different kind of dollar and wears its own badge.
    const w = mountTable({
      rows: [indicative(), row({ key: 'p', label: 'Copilot', usd: 7.5, spendClass: 'pooled-usage' })],
      headlineUsd: 20,
    })
    expect(w.find('[data-testid="drivers-indicative-note"]').text()).toBe(
      'Rows carrying no badge are attributed usage — indicative, not a billed charge.',
    )
  })

  it('a table with NO indicative row makes no such statement', () => {
    const w = mountTable({})
    expect(w.find('[data-testid="drivers-indicative-note"]').exists()).toBe(false)
  })
})

describe('an empty billed lane says WHICH kind of empty', () => {
  it('`no-data-yet` is "not derived", never "$0 spent"', () => {
    const w = mountTable({
      rows: [],
      headlineUsd: 0,
      billedLane: billedLane({ availability: 'no-data-yet', billedUsd: 0 }),
    })
    const empty = w.find('[data-testid="drivers-empty"]').text()
    expect(empty).toContain('have not been derived')
    expect(empty).toContain('not the same as no spend')
  })

  it('`none-in-scope` IS a measured zero and says so differently', () => {
    const w = mountTable({
      rows: [],
      headlineUsd: 0,
      billedLane: billedLane({ availability: 'none-in-scope', billedUsd: 0 }),
    })
    expect(w.find('[data-testid="drivers-empty"]').text()).toBe(
      'No billed spend in this scope for this period.',
    )
  })

  it('an attributed axis keeps the lane-neutral copy', () => {
    const w = mountTable({ rows: [], headlineUsd: 0 })
    expect(w.find('[data-testid="drivers-empty"]').text()).toBe('No drivers in this lane.')
  })
})

describe('consumption is rendered BESIDE the billed total, never inside it', () => {
  const withCopilot = () =>
    mountTable({
      billedLane: billedLane({
        consumptionUsd: 913.4,
        arms: [
          {
            provider: 'anthropic',
            measure: 'billed',
            availability: 'present',
            totalUsd: 411.25,
            rows: [row()],
          },
          {
            provider: 'github',
            measure: 'consumption',
            availability: 'present',
            totalUsd: 913.4,
            rows: [
              row({
                key: 'copilot-cli',
                label: 'GitHub Copilot',
                usd: 913.4,
                spendClass: 'pooled-usage',
              }),
            ],
          },
        ],
      }),
    })

  it('gives the consumption arm its own block, total and reason', () => {
    const block = withCopilot().find('[data-testid="drivers-consumption-github"]')
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain('913.40')
    expect(block.text()).toContain('not part of the billed total above')
    // The sentence names OUR grain mismatch, not a provider failing.
    expect(block.text()).toContain('before the included allowance')
    expect(block.text()).toContain('pooled per cost centre')
  })

  it('leaves the sum-back row footing to the BILLED total alone', () => {
    const foot = withCopilot().find('[data-testid="drivers-sumback"]')
    // Σ drivers === headline. If the consumption arm had been folded into
    // `rows`, this row would read $1,324.65 and flag a mismatch.
    expect(foot.attributes('data-mismatch')).toBe('false')
    expect(foot.text()).toContain('411.25')
    expect(foot.text()).not.toContain('1,324.65')
  })

  it('renders no consumption block when every arm is billed', () => {
    const w = mountTable({
      billedLane: billedLane({
        arms: [
          {
            provider: 'anthropic',
            measure: 'billed',
            availability: 'present',
            totalUsd: 411.25,
            rows: [row()],
          },
        ],
      }),
    })
    expect(w.find('[data-testid="drivers-consumption-github"]').exists()).toBe(false)
  })
})

describe('the Top models caption states the lane it MEASURED', () => {
  /*
   * The caption used to read "usage lane" unconditionally. Once the page's
   * toggle reached the drivers endpoint that became a false claim in chargeback
   * mode — `provider_usage_fact` bars under a caption naming the attributed
   * lane. It now comes from the response's own `measureLanes.rows`, so a caption
   * cannot outlive the figures it describes.
   */
  it('says billed when the rows are billed, and attributed otherwise', async () => {
    const RegionalTopModels = (
      await import('../../../app/components/reporting/regional/RegionalTopModels.vue')
    ).default
    const stubs = { ChartRankedBar: true, ClientOnly: { template: '<div><slot /></div>' } }

    const billed = mount(RegionalTopModels, {
      props: { rows: [row()], lane: 'billed' },
      global: { stubs },
    })
    expect(billed.find('[data-testid="regional-top-models-lane"]').text()).toContain('billed lane')

    const attributed = mount(RegionalTopModels, {
      props: { rows: [row({ spendClass: 'indicative' })], lane: 'attributed' },
      global: { stubs },
    })
    const caption = attributed.find('[data-testid="regional-top-models-lane"]').text()
    expect(caption).toContain('attributed usage lane')
    expect(caption).not.toContain('billed')
  })
})

describe('the whole-company cards state the lane they measured', () => {
  /*
   * The same class of defect as the Region caption, at the other width: both
   * cards hardcoded "company usage" / "By attributed usage", and the drivers
   * endpoint is ONE handler serving both widths. A toggle that reached the rows
   * on one screen and not the other would leave the two widths disagreeing about
   * what the same lane means.
   */
  const respond = (lane: 'attributed' | 'billed') => ({
    axis: 'model',
    headlineUsd: 411.25,
    rows: [row(lane === 'billed' ? {} : { spendClass: 'indicative' as const })],
    concentration: null as never,
    measureLanes: { rows: lane, headlineUsd: lane },
  })
  const stubs = { ChartRankedBar: true, ClientOnly: { template: '<div><slot /></div>' } }

  it('TopDriversCard names the billed denominator, never "company usage"', async () => {
    const TopDriversCard = (
      await import('../../../app/components/reporting/across/TopDriversCard.vue')
    ).default
    const billed = mount(TopDriversCard, {
      props: { drivers: respond('billed'), axis: 'model' },
      global: { stubs },
    })
    expect(billed.find('[data-testid="across-drivers-lane"]').text()).toContain('billed lane')
    expect(billed.text()).toContain('share of company billed spend')

    const attributed = mount(TopDriversCard, {
      props: { drivers: respond('attributed'), axis: 'model' },
      global: { stubs },
    })
    expect(attributed.text()).toContain('share of company usage')
    expect(attributed.text()).not.toContain('billed spend')
  })

  it('TopModelsCard names the lane its bars came from', async () => {
    const TopModelsCard = (
      await import('../../../app/components/reporting/across/TopModelsCard.vue')
    ).default
    const billed = mount(TopModelsCard, {
      props: { models: respond('billed') },
      global: { stubs },
    })
    expect(billed.find('[data-testid="across-top-models-lane"]').text()).toBe(
      'By billed spend, per the provider',
    )

    const attributed = mount(TopModelsCard, {
      props: { models: respond('attributed') },
      global: { stubs },
    })
    expect(attributed.find('[data-testid="across-top-models-lane"]').text()).toBe(
      'By attributed usage',
    )
  })
})

// ── WHOSE charge a chargeback figure is ─────────────────────────────────────
/*
 * "company billed spend" was still a false claim on the teammate / model /
 * surface axes. `provider_usage_fact` holds no Copilot CHARGE at all — after mig
 * 0120 its `github` rows are gross consumption — and Copilot raises ONE pooled
 * invoice per cost centre, so those axes carry Anthropic's charge alone. The
 * figure was defensible; the label was not.
 *
 * Two things are asserted for every surface: the label NAMES its scope, and the
 * reason is on screen in words. A qualifier without the reason is a footnote
 * nobody can act on; a reason without the qualifier leaves the headline lying.
 */
const ANTHROPIC_ONLY = {
  providers: ['anthropic'],
  gaps: [
    {
      provider: 'github',
      reason:
        'Copilot bills pooled per cost centre, so it has no per-model charge — this figure is Anthropic’s alone. Break down by Practice to see the Copilot charge.',
    },
  ],
}
const BOTH_PROVIDERS = { providers: ['anthropic', 'github'], gaps: [] }

describe('a partial chargeback figure names its own scope', () => {
  const stubs = { ChartRankedBar: true, ClientOnly: { template: '<div><slot /></div>' } }
  const respond = (coverage?: unknown) => ({
    axis: 'model',
    headlineUsd: 411.25,
    rows: [row()],
    concentration: null as never,
    measureLanes: { rows: 'billed', headlineUsd: 'billed' },
    chargebackCoverage: coverage,
  })

  it('DriversTable renders the reason ABOVE the figures it qualifies', () => {
    const w = mountTable({ chargebackCoverage: ANTHROPIC_ONLY })
    const note = w.find('[data-testid="drivers-chargeback-gaps"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('pooled per cost centre')
    expect(note.text()).toContain('Break down by Practice')
    // It precedes the table: a caveat under a ranking is read after the number
    // has already been taken as the answer.
    expect(w.html().indexOf('drivers-chargeback-gaps')).toBeLessThan(
      w.html().indexOf('drivers-sumback'),
    )
  })

  it('DriversTable renders NO such note when the figure is complete', () => {
    // The discriminating half — a note that always renders says nothing.
    expect(
      mountTable({ chargebackCoverage: BOTH_PROVIDERS })
        .find('[data-testid="drivers-chargeback-gaps"]')
        .exists(),
    ).toBe(false)
    expect(mountTable({}).find('[data-testid="drivers-chargeback-gaps"]').exists()).toBe(false)
  })

  it('TopDriversCard qualifies the company-wide label, and drops the qualifier when complete', async () => {
    const TopDriversCard = (
      await import('../../../app/components/reporting/across/TopDriversCard.vue')
    ).default
    const partial = mount(TopDriversCard, {
      props: { drivers: respond(ANTHROPIC_ONLY), axis: 'model' },
      global: { stubs },
    })
    expect(partial.text()).toContain('share of company billed spend — Anthropic only')
    expect(partial.find('[data-testid="across-drivers-lane"]').text()).toContain('Anthropic only')

    const complete = mount(TopDriversCard, {
      props: { drivers: respond(BOTH_PROVIDERS), axis: 'model' },
      global: { stubs },
    })
    expect(complete.text()).toContain('share of company billed spend')
    expect(complete.text()).not.toContain('Anthropic only')
  })

  it('TopModelsCard qualifies its caption and states the reason', async () => {
    const TopModelsCard = (
      await import('../../../app/components/reporting/across/TopModelsCard.vue')
    ).default
    const w = mount(TopModelsCard, {
      props: { models: respond(ANTHROPIC_ONLY) },
      global: { stubs },
    })
    expect(w.find('[data-testid="across-top-models-lane"]').text()).toContain('Anthropic only')
    expect(w.find('[data-testid="across-top-models-gaps"]').text()).toContain(
      'pooled per cost centre',
    )
  })

  it('RegionalTopModels qualifies its caption and states the reason', async () => {
    const RegionalTopModels = (
      await import('../../../app/components/reporting/regional/RegionalTopModels.vue')
    ).default
    const w = mount(RegionalTopModels, {
      props: { rows: [row()], lane: 'billed', chargebackCoverage: ANTHROPIC_ONLY },
      global: { stubs },
    })
    expect(w.find('[data-testid="regional-top-models-lane"]').text()).toContain('Anthropic only')
    expect(w.find('[data-testid="regional-top-models-gaps"]').text()).toContain(
      'pooled per cost centre',
    )

    // Complete → no qualifier, no note.
    const complete = mount(RegionalTopModels, {
      props: { rows: [row()], lane: 'billed', chargebackCoverage: BOTH_PROVIDERS },
      global: { stubs },
    })
    expect(complete.find('[data-testid="regional-top-models-lane"]').text()).not.toContain('only')
    expect(complete.find('[data-testid="regional-top-models-gaps"]').exists()).toBe(false)
  })
})
