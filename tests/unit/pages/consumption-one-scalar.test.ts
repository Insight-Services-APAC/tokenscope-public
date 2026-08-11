// @vitest-environment happy-dom
/*
 * /usage (app/pages/usage/index.vue) — the ADR 0012 page contract, on the
 * W2-rebuilt page (developer-pages build).
 *
 * The rules this file pins are UNCHANGED by the rebuild:
 *
 *   D1 — the headline is ATTRIBUTED USAGE by default, on every surface that
 *        claims to show your usage;
 *   D3 — the headline names its lens in the copy the reader sees;
 *   D4 — the quota tile's operands ARE the headline figures beside it, and the
 *        provider-reported figure never renders as a competing month total;
 *   D2 — the billing figure is reachable, but only through a selected lens;
 *   D5 — a declared personal subscription is disclosed, not alarmed about.
 *
 * What CHANGED under them (W2 D17): the month band's quota BAR and pace column
 * became the four-tile hero — the quota tile carries the same operands (the
 * run-rate value, the quota denominators, the exhaustion states) through the
 * SAME server-built headline, so decision 4 still holds by construction. The
 * old `util-bar`/`pace-figure` assertions are re-pinned on the tile.
 *
 * What changed AGAIN (owner ruling 2026-08-05): the two cards this file used to
 * mount for real — "What is and is not chargeable" (MeLensDisclosure's card
 * variant) and "What kind of AI work drove this" (ConsumptionHeroCard) — are
 * RETIRED. The rules above are about HONESTY, not about those cards existing,
 * so every one of them is re-pinned on the surface that now carries the
 * meaning: D5 on the (i) that the disclosure became, D1's provider-reported
 * rule strengthened to "renders nowhere", and the last describe in this file
 * proving both cards are actually gone (re-mount either → it fails).
 *
 * Same mounting idiom as reporting-shell.test.ts: stub the Nuxt auto-import
 * globals, register pass-through stubs for the UI kit, wrap in <Suspense>.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { PERSONAL_LENS_COPY } from '../../../shared/usage/lens'
import { defineComponent, ref, computed } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ConsumptionPage from '../../../app/pages/usage/index.vue'
import LensDisclosure from '../../../app/components/me/LensDisclosure.vue'

/** The developer's real July: attributed usage over a $3,100 quota = 221%. */
const ATTRIBUTED_MONTH = '6846.35'
const QUOTA = '3100.00'
/** What Anthropic + GitHub reported — the reconciliation reference, not a headline. */
const PROVIDER_TRUTH = '1449.70'
/** What actually cross-charges. */
const CHARGEABLE = '6.12'

const runRate = (mtd: string, isProjection = true) => ({
  projected_month_end_usd: (Number(mtd) * 2).toFixed(2),
  days_elapsed: isProjection ? 15 : 31,
  days_in_month: 31,
  method: 'linear-mtd',
  is_projection: isProjection,
})

const usageHeadline = (opts: { isProjection?: boolean; quotaState?: unknown } = {}) => ({
  lane: 'usage',
  month: '2026-07',
  mtd_usd: ATTRIBUTED_MONTH,
  run_rate: runRate(ATTRIBUTED_MONTH, opts.isProjection ?? true),
  quota: {
    total_usd: QUOTA,
    base_allowance_usd: '100.00',
    allocation_usd: '3000.00',
    projection: opts.quotaState ?? { state: 'exhausted', over_usd: '3746.35' },
  },
})

const chargebackHeadline = () => ({
  lane: 'chargeback',
  month: '2026-07',
  mtd_usd: CHARGEABLE,
  run_rate: runRate(CHARGEABLE),
  quota: null,
})

const heroWindow = {
  from: '2026-07-01',
  to: '2026-07-31',
  is_month: true,
  month: '2026-07',
  days_elapsed: 15,
  days_in_month: 31,
}

/** The W2 hero tiles for each lane — the lead tile carries the band figure. */
const usageTiles = [
  { key: 'attributed', value_usd: ATTRIBUTED_MONTH, delta_pct: 0.12, delta_empty_reason: null },
  {
    key: 'budgeted', value_usd: '6000.00', budgeted_share_pct: 0.876,
    no_budget_usd: '846.35', untagged_usd: '0.00', delta_pct: null,
    delta_empty_reason: 'too early to compare',
  },
  { key: 'quota', quota_basis: 'window-month' },
  { key: 'active_days', count: 9, days_so_far: 15, delta_abs: 2, delta_empty_reason: null },
]
const chargebackTiles = [
  { key: 'chargeable', value_usd: CHARGEABLE, delta_pct: null, delta_empty_reason: 'too early to compare' },
  { key: 'attributed', value_usd: ATTRIBUTED_MONTH, delta_pct: 0.12, delta_empty_reason: null },
  { key: 'quota', quota_basis: 'window-month' },
  { key: 'active_days', count: 9, days_so_far: 15, delta_abs: 2, delta_empty_reason: null },
]

const disclosure = (declared = true) => ({
  attributed_usage_usd: ATTRIBUTED_MONTH,
  provider_reported_usd: PROVIDER_TRUTH,
  chargeable_usd: CHARGEABLE,
  declared_personal: declared
    ? [
        {
          tool: 'claude-code',
          label: 'Claude Code',
          subscription_type: 'Claude Max 20',
          monthly_cost_usd: '200.00',
          declared_at: '2026-07-30T09:00:00.000Z',
          usage_mtd_usd: '6800.00',
        },
      ]
    : [],
  declared_personal_usage_usd: declared ? '6800.00' : '0.00',
  tool_gaps: [
    {
      tool: 'claude-code',
      label: 'Claude Code',
      attributed_usage_usd: ATTRIBUTED_MONTH,
      provider_reported_usd: PROVIDER_TRUTH,
      state: declared ? 'declared' : 'material_gap',
      has_open_review: true,
    },
  ],
})

const fixture = (over: Record<string, unknown> = {}) => ({
  headline: usageHeadline(),
  disclosure: disclosure(),
  month: {
    spend_usd: ATTRIBUTED_MONTH,
    tokens: 8_800_000_000,
    quota_usd: QUOTA,
    base_allowance_usd: '100.00',
    allocation_usd: '3000.00',
    run_rate: runRate(ATTRIBUTED_MONTH),
  },
  window_days: 30,
  series: [{ day: '2026-07-01', cost_usd: '10.00', tokens: 100 }],
  series_by_model: [],
  mix: {
    by_model: [{ model: 'claude-fable-5', tokens: 100, cost_usd: '2219.31' }],
    by_token_type: [],
    buckets: [],
    tagged_spend: [{ activity: 'research', cost_usd: '12.00' }],
    unallocated: { total_cost_usd: '0.00', untagged_cost_usd: '0.00', needs_tagging_count: 0 },
  },
  fidelity: { window_cost_usd: '2219.31', advisory_cost_usd: '0.00' },
  insights: [],
  freshness_minutes_ago: 630,
  aggregate_refreshed_minutes_ago: 0,
  hero_tiles: { window: heroWindow, tiles: usageTiles },
  provider_truth: { month: '2026-07', mtd_usd: PROVIDER_TRUTH, run_rate: runRate(PROVIDER_TRUTH) },
  page_freshness: {
    telemetry_minutes_ago: 630,
    aggregate_minutes_ago: 0,
    provider_feed_minutes_ago: 95,
    worst_minutes_ago: 630,
  },
  providerStates: [],
  coverage: null,
  ...over,
})

/** The chargeback-lane fixture: headline AND tiles move together. */
const chargebackFixture = () =>
  fixture({
    headline: chargebackHeadline(),
    hero_tiles: { window: heroWindow, tiles: chargebackTiles },
  })

const passThrough = (tag: string) => ({ template: `<div data-stub="${tag}"><slot /><slot name="actions" /></div>` })

const STUBS = {
  UiPageHead: passThrough('page-head'),
  UiCard: passThrough('card'),
  UiEyebrow: passThrough('eyebrow'),
  UiBadge: passThrough('badge'),
  UiButton: passThrough('button'),
  UiEmptyState: true,
  NuxtLink: passThrough('link'),
  UsageWindowToggle: passThrough('window-toggle'),
  ChartsStackedBars: true,
  ChartsTrendArea: true,
  ChartRankedBar: true,
  MeLensDisclosure: LensDisclosure, // the REAL disclosure (its `dot` variant)
  ReportingLaneToggle: {
    props: ['modelValue', 'captions'],
    template:
      '<div data-testid="lane-toggle" :data-lane="modelValue">' +
      '<button data-testid="lane-usage" @click="$emit(\'update:modelValue\', \'usage\')">Usage</button>' +
      '<button data-testid="lane-chargeback" @click="$emit(\'update:modelValue\', \'chargeback\')">Chargeback</button>' +
      '<p data-testid="lane-caption">{{ captions?.[modelValue] }}</p></div>',
  },
  DateRangeControl: { template: '<div data-testid="date-range-stub" />' },
  CcHeaderNotes: true,
  SessionDetailDrawer: true,
  // §F4: Activity owns its own keyset fetch; pinned in its own component test.
  ActivityCard: { template: '<div data-testid="activity-card-stub" />' },
  ActivityDetailDrawer: { props: ['activity'], template: '<div data-testid="act-drawer" :data-activity="activity ?? \'\'" />' },
  HomeNeedsTaggingPanel: true,
  HomeTagSessionDialog: true,
  ProviderDayDetailDrawer: true,
  UiToolPill: true,
  UsageModelBadge: true,
  Icon: true,
}

// The page's TEMPLATE references the auto-imported formatters, which compile
// to `_ctx.fmtUsd` — resolved through the instance proxy, so they are provided
// as global MOCKS (not globalThis stubs). Mirrors the app's fmtUsd formatting
// (thousands separators) so text assertions are realistic.
const FORMAT_MOCKS = {
  fmtUsd: (n: number | string | null | undefined) =>
    n == null || n === '' || !Number.isFinite(Number(n))
      ? '—'
      : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  fmtTokens: (n: number) => String(n),
  fmtTimeAgo: () => 'just now',
  clientMeta: () => ({ name: 'Claude Code', icon: 'x' }),
}

/** The lane the page asked the server for, captured off the ME-USAGE fetch only. */
let requestedLane = ''

/**
 * `askedLane` is what the URL ref holds; the fixture's `headline.lane` is what
 * the server answered with. They are the SAME on a settled page and DIFFER for
 * the whole of a lens switch, which is the state this file pins below.
 */
async function mountPage(data = fixture(), askedLane?: 'usage' | 'chargeback') {
  // Script-scope references (inside computed()s) resolve via globalThis;
  // template references via the instance proxy (mocks). Provide both.
  for (const [k, v] of Object.entries(FORMAT_MOCKS)) vi.stubGlobal(k, v)
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: 't1', displayName: 'Priya' }),
    ensure: async () => {},
  }))
  const returnedLane = (data.headline as { lane: 'usage' | 'chargeback' }).lane
  const laneRef = ref<'usage' | 'chargeback'>(askedLane ?? returnedLane)
  vi.stubGlobal('usePersonalLens', () => laneRef)
  vi.stubGlobal('useRefreshOnVisible', () => {})
  vi.stubGlobal('useReportState', () => ({
    month: ref<string | null>(null),
    from: ref<string | null>(null),
    to: ref<string | null>(null),
  }))
  requestedLane = ''
  stubServerClock()
  vi.stubGlobal('useFetch', (url: string, opts?: { query?: { value?: Record<string, unknown> } }) => {
    const q = computed(() => opts?.query?.value ?? {})
    const isMain = url.startsWith('/api/v1/me/usage')
    if (isMain) requestedLane = String(q.value.lane ?? '')
    const body = isMain
      ? data
      : url.startsWith('/api/v1/me/sessions/untagged')
        ? { sessions: [], unaccounted: [], dismissed: { sessions: [], unaccounted: [] } }
        : url.startsWith('/api/v1/me/quarantined-spend')
          ? { sessions: [] }
          : url.startsWith('/api/v1/me/projects')
            ? { projects: [] }
            : { activity_types: [] }
    return {
      data: ref(body),
      refresh: vi.fn(),
      pending: ref(false),
      error: ref(null),
    }
  })
  const Parent = defineComponent({
    components: { ConsumptionPage },
    template: '<Suspense><ConsumptionPage /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: FORMAT_MOCKS } })
  await flushPromises()
  return { w, laneRef, returnedLane }
}

afterEach(() => vi.unstubAllGlobals())

describe('/usage — one quantity, labelled (ADR 0012 D1/D3)', () => {
  it('the headline is ATTRIBUTED USAGE, not the provider-reported figure', async () => {
    const { w } = await mountPage()
    const scalars = w.findAll('[data-mtd-scalar]')
    expect(scalars).toHaveLength(1)
    expect(scalars[0]!.text()).toContain('6,846.35')
    expect(scalars[0]!.attributes('data-mtd-scalar')).toBe('usage')
  })

  it('the headline names its lens in the copy the reader sees (D3)', async () => {
    const { w } = await mountPage()
    expect(w.find('[data-testid="mtd-basis"]').text()).toContain('attributed usage')
    // ...and the month it belongs to, from the SERVER-resolved window.
    expect(w.find('[data-testid="month-band"]').text()).toContain('July 2026')
  })

  it('the provider-reported figure never renders as a competing month total', async () => {
    /*
     * RE-PINNED, and STRICTER than before. This used to allow the figure inside
     * the "What is and is not chargeable" card's three-scalar row and assert it
     * appeared nowhere else. That card is retired (owner ruling 2026-08-05) and
     * the compressed (i) that replaced it does not reprint the figure, so the
     * honest pin is now absolute: $1,449.70 is a reconciliation reference the
     * server compares against, and it renders on this page nowhere at all.
     */
    const { w } = await mountPage()
    expect(w.text()).not.toContain('1,449.70')
    expect(w.find('[data-testid="mtd-scalar"]').text()).not.toContain('1,449.70')
    // Guard the guard: the fixture really does carry it, so this cannot pass by
    // the payload simply not having the operand.
    expect(fixture().disclosure.provider_reported_usd).toBe(PROVIDER_TRUTH)
  })
})

describe('/usage — the quota tile and the figure beside it share operands (D4)', () => {
  it("the quota tile's value is the headline's OWN run rate, never the other lane's", async () => {
    const { w } = await mountPage()
    const tile = w.find('[data-testid="me-tile-quota"]')
    // The fixture's run rate is 2x its own MTD; the tile must therefore show
    // 2 x 6,846.35 and never 2 x 1,449.70.
    expect(tile.text()).toContain('13,692.70')
    expect(tile.text()).not.toContain('2,899.40')
    // And the operand it divides by is on screen beside it.
    expect(w.find('[data-testid="mtd-scalar"]').text()).toContain('6,846.35')
  })

  it('spells the quota operands out on the tile, so the quotient can be checked', async () => {
    const { w } = await mountPage()
    const tile = w.find('[data-testid="me-tile-quota"]').text()
    expect(tile).toContain('3,100.00') // the quota
    expect(tile).toContain('100.00') // the allowance
    expect(tile).toContain('3,000.00') // the allocations
  })
})

describe('/usage — quota state is a state, in the right tense (defect 3)', () => {
  it('says the quota IS exhausted, with the overage — not "on pace to exhaust"', async () => {
    const { w } = await mountPage()
    const line = w.find('[data-testid="quota-exhausted"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('is exhausted')
    expect(line.text()).toContain('3,746.35')
    expect(w.find('[data-testid="quota-exhaustion"]').exists()).toBe(false)
    expect(w.text()).not.toContain('on pace to exhaust')
  })

  it('still says "on pace to exhaust ~<date>" when the quota has NOT been passed', async () => {
    const { w } = await mountPage(
      fixture({
        headline: usageHeadline({ quotaState: { state: 'projected', date: '2026-07-28' } }),
      }),
    )
    expect(w.find('[data-testid="quota-exhaustion"]').text()).toContain('2026-07-28')
    expect(w.find('[data-testid="quota-exhausted"]').exists()).toBe(false)
  })

  it('says nothing at all when this month’s pace will not reach the quota', async () => {
    const { w } = await mountPage(
      fixture({ headline: usageHeadline({ quotaState: { state: 'not-at-this-pace' } }) }),
    )
    expect(w.find('[data-testid="quota-exhaustion"]').exists()).toBe(false)
    expect(w.find('[data-testid="quota-exhausted"]').exists()).toBe(false)
  })
})

describe('/usage — the quota tile on the last day of the month (defect 4)', () => {
  it('stops projecting: the figure is the month-to-date itself, said as "so far"', async () => {
    const { w } = await mountPage(
      fixture({ headline: usageHeadline({ isProjection: false, quotaState: { state: 'not-at-this-pace' } }) }),
    )
    const tile = w.find('[data-testid="me-tile-quota"]')
    // The MTD figure, not a scaled forecast (~2x) — and not the "~" prefix.
    expect(tile.text()).toContain('6,846.35')
    expect(tile.text()).not.toContain('13,692.70')
    expect(tile.text()).toContain('so far')
  })

  it('does NOT call the month finished — `is_projection` goes false at 00:00 UTC', async () => {
    const { w } = await mountPage(
      fixture({ headline: usageHeadline({ isProjection: false, quotaState: { state: 'not-at-this-pace' } }) }),
    )
    const text = w.text().toLowerCase()
    for (const claim of [
      'month ends today',
      'nothing left to project',
      "month's spend",
      'month total',
      'final total',
    ]) {
      expect(text).not.toContain(claim)
    }
  })
})

describe('/usage — the lens is selectable and says so (D2)', () => {
  it('renders the lens control with the personal-surface caption', async () => {
    const { w } = await mountPage()
    expect(w.find('[data-testid="lane-toggle"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-caption"]').text()).toContain('Every token you spent')
  })

  it('asks the SERVER for the selected lane rather than re-lensing on the client', async () => {
    await mountPage()
    expect(requestedLane).toBe('usage')
    await mountPage(chargebackFixture())
    expect(requestedLane).toBe('chargeback')
  })

  it('under the chargeback lens the headline is the chargeable figure, labelled', async () => {
    const { w } = await mountPage(chargebackFixture())
    const scalar = w.find('[data-mtd-scalar]')
    expect(scalar.attributes('data-mtd-scalar')).toBe('chargeback')
    expect(scalar.text()).toContain('6.12')
    expect(w.find('[data-testid="mtd-basis"]').text()).toContain('chargeback')
  })

  it('the quota tile is "—" under the chargeback lens, WITH the reason (T15)', async () => {
    /*
     * The defect in one sentence: a percentage whose numerator comes from the
     * other lane. Under §B there is no §A numerator to put over the quota, so
     * the tile says WHY instead of drawing one — never a silently empty tile.
     */
    const { w } = await mountPage(chargebackFixture())
    const tile = w.find('[data-testid="me-tile-quota"]')
    expect(tile.text()).toContain('—')
    expect(tile.find('[data-testid="kpi-delta-empty"]').text()).toContain('attributed usage')
    expect(tile.find('[data-testid="kpi-delta-empty"]').text()).toContain('chargeback lens')
  })
})

describe('/usage — a lens switch in flight keeps the label with the figure (D4)', () => {
  it('keeps the control, its caption and the basis on the lane the FIGURE is in', async () => {
    /*
     * `useFetch` holds the previous body for the whole of a refetch — it only
     * assigns `data.value` when the new promise resolves. So between the click
     * and the response the URL says chargeback while the figures are still the
     * usage ones. Binding the control straight to the URL ref put a Chargeback
     * label and caption above a usage number: decision 4 broken in the one
     * interaction the lens exists for.
     */
    const { w, laneRef, returnedLane } = await mountPage(fixture(), 'chargeback')
    // Guard the guard: this pins nothing unless the two genuinely differ.
    expect(returnedLane).toBe('usage')
    expect(laneRef.value).toBe('chargeback')
    expect(laneRef.value).not.toBe(returnedLane)

    expect(w.find('[data-testid="lane-toggle"]').attributes('data-lane')).toBe('usage')
    // The USAGE caption, read from its own definition rather than quoted.
    expect(w.find('[data-testid="lane-caption"]').text()).toContain(
      PERSONAL_LENS_COPY.usage.caption,
    )
    expect(w.find('[data-mtd-scalar]').attributes('data-mtd-scalar')).toBe('usage')
    expect(w.find('[data-testid="mtd-basis"]').text()).toContain('attributed usage')
  })

  it('marks the figures provisional and NAMES the switch while the lanes disagree', async () => {
    const { w } = await mountPage(fixture(), 'chargeback')
    const figures = w.find('[data-testid="month-band-figures"]')
    expect(figures.attributes('aria-busy')).toBe('true')
    expect(figures.classes()).toContain('opacity-50')
    const chip = w.find('[data-testid="lens-switching"]')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('role')).toBe('status')
    expect(chip.text()).toMatch(/switching lens/i)
  })

  it('presents settled figures as settled once the lanes agree', async () => {
    const { w, laneRef, returnedLane } = await mountPage()
    expect(laneRef.value).toBe(returnedLane)
    const figures = w.find('[data-testid="month-band-figures"]')
    expect(figures.attributes('aria-busy')).toBe('false')
    expect(figures.classes()).not.toContain('opacity-50')
    expect(w.find('[data-testid="lens-switching"]').exists()).toBe(false)
  })

  it('still WRITES the selected lane through — reading the resolved lane must not make it inert', async () => {
    const { w, laneRef } = await mountPage()
    await w.find('[data-testid="lane-chargeback"]').trigger('click')
    expect(laneRef.value).toBe('chargeback')
    // The response has not moved, so the card reads as provisional rather than
    // as a control that did nothing.
    expect(w.find('[data-testid="lane-toggle"]').attributes('data-lane')).toBe('usage')
    expect(w.find('[data-testid="month-band-figures"]').attributes('aria-busy')).toBe('true')
  })
})

describe('/usage — declared personal subscription is disclosed, not alarmed (D5)', () => {
  /*
   * SAME INVARIANT, NEW SURFACE. D5 is answered on this page by the (i) on the
   * lane toggle (MeLensDisclosure `dot`), not by the retired "What is and is
   * not chargeable" card. What D5 requires — how much of the figure is
   * declared-personal, and what the declaration does and does not do — is
   * pinned below on the popover. The DECLARED-AT DATE is the one operand that
   * did not come with it: it is on /account, which this popover links to, and
   * a reader asking why their usage does not cross-charge does not need it.
   */
  it('names the tool, the plan, the price and the usage behind it', async () => {
    const { w } = await mountPage()
    const line = w.find('[data-testid="declared-personal-claude-code"]').text()
    expect(line).toContain('Claude Code')
    expect(line).toContain('Claude Max 20')
    expect(line).toContain('$200.00')
    expect(line).toContain('6,800.00')
    // NOT "never charged back" — migration 0105:16-19 says a declaration never
    // changes a chargeback verdict. See the LensDisclosure header.
    expect(line).toContain('does not by itself change what is charged back')
    // …and it sits behind the (i), not in the page body (D12, owner ruling).
    expect(w.find('[data-testid="lens-disclosure-dot"]').exists()).toBe(true)
    expect(
      w.find('[data-testid="lens-disclosure-dot"]').find('[data-testid="info-dot-trigger"]').exists(),
    ).toBe(true)
  })

  it('keeps the chargeback-follows-the-bill sentence and the account-page route', async () => {
    /*
     * The four-line paragraph is gone; the two things a reader needs at the
     * moment they ask are not. The lead sentence is the NARROW true one (mig
     * 0105:16-19 — chargeback follows the bill, the declaration does not confer
     * the escape), and the manage-declarations link still reaches /account.
     */
    const { w } = await mountPage()
    const lead = w.find('[data-testid="lens-disclosure-lead"]').text()
    expect(lead).toContain('Chargeback follows the provider bill')
    const cta = w.find('[data-testid="lens-disclosure-manage-cta"]')
    expect(cta.exists()).toBe(true)
    expect(cta.text()).toContain('account page')
  })

  it('does NOT hedge the headline (D6), by the SHAPE of the hedge not a word list', async () => {
    const { w } = await mountPage()
    const caption = w.get('[data-testid="lane-caption"]').text().toLowerCase()
    for (const hedge of [
      'notional', 'not real spend', 'hypothetical', 'does not count',
      'invoice', 'not billed', 'no bill', 'yet',
    ]) {
      expect(caption).not.toContain(hedge)
    }
    // And the positive: it says what the figure IS, in the present tense.
    expect(caption).toContain('spent')
  })

  it('with NO declaration and a material gap, points at the review flow instead', async () => {
    /*
     * Re-pinned per TOOL. The card wrapped these branches in
     * `lens-disclosure-declared` / `lens-disclosure-undeclared` group divs; the
     * (i) renders one sentence per tool with no group wrapper, so the pin moves
     * to the sentences themselves — which is where the per-tool rule (a Claude
     * declaration must not swallow a Copilot gap) actually lives.
     */
    const { w } = await mountPage(fixture({ disclosure: disclosure(false) }))
    expect(w.find('[data-testid="undeclared-gap-claude-code"]').exists()).toBe(true)
    expect(w.find('[data-testid="declared-personal-claude-code"]').exists()).toBe(false)
    expect(w.find('[data-testid="undeclared-gap-claude-code"]').text()).toContain(
      'open for review on your',
    )
  })

  it('says nothing per-tool when there is nothing to disclose — but still explains the lens', async () => {
    /*
     * The CARD was gated on "is there a declaration, a gap, or a missing
     * record", because a page-body block with nothing to say is noise. The (i)
     * is not gated: it costs a reader nothing until they open it, and "why
     * doesn't my usage cross-charge?" is asked at the toggle in every month.
     * So the per-tool sentences still disappear; the lead sentence does not.
     */
    const { w } = await mountPage(
      fixture({ disclosure: { ...disclosure(false), tool_gaps: [] } }),
    )
    expect(w.find('[data-testid="declared-personal-claude-code"]').exists()).toBe(false)
    expect(w.findAll('[data-testid^="undeclared-gap-"]')).toHaveLength(0)
    expect(w.findAll('[data-testid^="no-provider-record-"]')).toHaveLength(0)
    expect(w.find('[data-testid="lens-disclosure-lead"]').exists()).toBe(true)
  })
})

describe('/usage — the parts this rebuild did not change', () => {
  it('the freshness prose is GONE — the chip row is the freshness surface now (D14)', async () => {
    const { w } = await mountPage()
    expect(w.find('[data-testid="page-freshness"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Data as fresh as its stalest source')
  })

  it('renders clickable tagged-activity chips that open the activity drawer', async () => {
    const { w } = await mountPage()
    const chip = w.find('[data-testid="activity-chip-research"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('research')
    // Drawer starts closed, opens with the clicked activity.
    expect(w.find('[data-testid="act-drawer"]').attributes('data-activity')).toBe('')
    await chip.trigger('click')
    expect(w.find('[data-testid="act-drawer"]').attributes('data-activity')).toBe('research')
  })
})

describe('/usage — the two retired cards (owner ruling 2026-08-05)', () => {
  /*
   * MUTATION PROOF. Re-mount either card on the page and exactly one of these
   * fails, because each keys on the retired component's OWN root testid rather
   * than on a string that some other card might also carry.
   */
  it('"What is and is not chargeable" is gone — the card, its three scalars and its paragraph', async () => {
    /*
     * WHERE ITS MEANING WENT, assertion by assertion:
     *   - attributed usage / chargeable  → the lane toggle + the hero tiles
     *     (the lead tile becomes Chargeable in the billed lane with Attributed
     *     usage beside it — pinned by the D2 describe above);
     *   - providers reported             → nowhere, deliberately: it is a
     *     server-side reconciliation operand, pinned absent by the D1 describe;
     *   - the declaration paragraph      → the (i) on the lane toggle, pinned
     *     by the D5 describe above;
     *   - "you are viewing the chargeback lens, budgets measure attributed
     *     usage" → the quota tile's stated reason (the D2 describe's last test).
     */
    const { w } = await mountPage()
    expect(w.find('[data-testid="lens-disclosure"]').exists()).toBe(false)
    expect(w.find('[data-testid="lens-disclosure-figures"]').exists()).toBe(false)
    expect(w.text()).not.toContain('What is and is not chargeable')
    expect(w.text()).not.toContain('providers reported')
    // The paragraph's own giveaway clause, which the compressed (i) drops.
    expect(w.text()).not.toContain('chargeback follows the provider bill, so usage with no Insight')
  })

  it('"What kind of AI work drove this" is gone — card, groups, chips and basis caption', async () => {
    /*
     * WHERE ITS MEANING WENT: "what drove this" is answered by Daily spend (the
     * trend card), the Claude/Copilot engagement pair (each provider in its own
     * vocabulary), Top models with its coverage footer, and Where it went. The
     * card's own r1-F1 invariant — never sum across bases — is not lost either:
     * with no card there is no cross-basis surface to violate it, and the
     * one-scalar-per-basis rule is pinned on the band above (D1).
     */
    const { w } = await mountPage()
    expect(w.find('[data-testid="consumption-hero"]').exists()).toBe(false)
    expect(w.find('[data-testid="hero-group-telemetry"]').exists()).toBe(false)
    expect(w.find('[data-testid="hero-group-billed"]').exists()).toBe(false)
    expect(w.findAll('[data-testid^="hero-chip-"]')).toHaveLength(0)
    expect(w.text()).not.toContain('What kind of AI work drove this')
    expect(w.text()).not.toContain('never summed across groups')
    // The surfaces that DO answer it are on the page — the retirement is a
    // replacement, not a deletion.
    expect(w.find('[data-testid="trend-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="top-models-card"]').exists()).toBe(true)
    // (Where it went rides its own leg, which this ADR fixture does not seed —
    // usage-rebuild.test.ts is where that card's contract is pinned.)
    expect(w.find('[data-testid="engagement-claude"]').exists()).toBe(true)
    expect(w.find('[data-testid="engagement-copilot"]').exists()).toBe(true)
  })

  it('the ONE-SCALAR rule still holds with both cards gone', async () => {
    // The band is the page's only MTD-shaped scalar, in the resolved lane —
    // the invariant the retired hero's chips were the other risk to.
    const { w } = await mountPage()
    expect(w.findAll('[data-mtd-scalar]')).toHaveLength(1)
    expect(w.find('[data-mtd-scalar]').attributes('data-mtd-scalar')).toBe('usage')
  })
})
