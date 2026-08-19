// @vitest-environment happy-dom
/*
 * /usage rebuilt to the prototype (developer-pages W2) — the page-level halves
 * of T14, T16, T17, T18, T19 and T24.
 *
 * Same mounting idiom as consumption-one-scalar.test.ts (stub the Nuxt
 * auto-import globals, pass-through UI-kit stubs, wrap in <Suspense>). The
 * pieces under test mount REAL: MeHeroTiles + ScopeKpiTile (the hero),
 * ModelSplitPanel (fix 3's zero-category rule), BudgetStateCell (the PROJECT
 * state), InfoDot. The worklist contract components and ActivityCard stay
 * STUBS — T18 pins the wiring, not their internals (which this change may not
 * touch at all — see the diff-guard below).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineComponent, ref, computed } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ConsumptionPage from '../../../app/pages/usage/index.vue'

// ── Fixture — every new leg populated the way the endpoint writes it ─────────

const runRate = (mtd: string) => ({
  projected_month_end_usd: (Number(mtd) * 2).toFixed(2),
  days_elapsed: 14,
  days_in_month: 31,
  method: 'linear-mtd',
  is_projection: true,
})

const heroWindow = {
  from: '2026-07-01',
  to: '2026-07-31',
  is_month: true,
  month: '2026-07',
  days_elapsed: 14,
  days_in_month: 31,
}

const heroTiles = [
  { key: 'attributed', value_usd: '374.31', delta_pct: 0.12, delta_empty_reason: null, spark: [1, 2, 3, 4, 5, 6, 7, 8] },
  {
    key: 'budgeted', value_usd: '320.91', budgeted_share_pct: 0.857, no_budget_usd: '54.01',
    untagged_usd: '22.10', delta_pct: 0.09, delta_empty_reason: null, spark: [1, 2, 3, 4, 5, 6, 7, 8],
  },
  { key: 'quota', quota_basis: 'window-month' },
  { key: 'active_days', count: 9, days_so_far: 14, delta_abs: 2, delta_empty_reason: null, spark: [1, 0, 1, 0, 1, 0, 1, 0] },
]

const fixture = (over: Record<string, unknown> = {}) => ({
  headline: {
    lane: 'usage',
    month: '2026-07',
    mtd_usd: '374.31',
    run_rate: runRate('374.31'),
    quota: {
      total_usd: '500.00',
      base_allowance_usd: '100.00',
      allocation_usd: '400.00',
      projection: { state: 'projected', date: '2026-07-18' },
    },
  },
  disclosure: {
    attributed_usage_usd: '374.31',
    provider_reported_usd: '210.00',
    chargeable_usd: '6.12',
    declared_personal: [],
    declared_personal_usage_usd: '0.00',
    tool_gaps: [],
  },
  month: {
    spend_usd: '374.31', tokens: 1_000_000, quota_usd: '500.00',
    base_allowance_usd: '100.00', allocation_usd: '400.00', run_rate: runRate('374.31'),
  },
  window_days: 30,
  series: [{ day: '2026-07-01', cost_usd: '10.00', tokens: 100 }],
  series_by_model: [],
  mix: {
    by_model: [{ model: 'claude-opus-5', tokens: 100, cost_usd: '148.10' }],
    by_token_type: [],
    buckets: [],
    tagged_spend: [{ activity: 'research', cost_usd: '12.00' }],
    unallocated: {
      total_cost_usd: '22.10', untagged_cost_usd: '22.10', needs_tagging_count: 3,
      needs_tagging_sessions: 2, needs_tagging_days: 1,
    },
  },
  fidelity: { window_cost_usd: '374.31', advisory_cost_usd: '96.40' },
  insights: [
    {
      id: 'cache-hit-starvation',
      severity: 'medium',
      group: 'context-management',
      headline: 'Cache hit ratio 14% on 2.1M prompt tokens.',
      evidence: {},
      related_levers: ['R2'],
      estimated_monthly_savings_usd: '18.00',
    },
  ],
  freshness_minutes_ago: 30,
  aggregate_refreshed_minutes_ago: 0,
  hero_tiles: { window: heroWindow, tiles: heroTiles },
  provider_truth: { month: '2026-07', mtd_usd: '210.00', run_rate: runRate('210.00') },
  page_freshness: {
    telemetry_minutes_ago: 30, aggregate_minutes_ago: 0,
    provider_feed_minutes_ago: 95, worst_minutes_ago: 95,
  },
  providerStates: [
    { vendor: 'anthropic', state: 'settling', settlesAt: '2026-08-30' },
    { vendor: 'usage', state: 'estimated' },
  ],
  coverage: { applicable: false, denominator: null, connected: 0, nonConnected: 0, stale: false },
  context_residency: {
    window: { from: '2026-07-01', to: '2026-07-31' },
    segments: [
      { band: '0-200k', costUsd: 246.6 },
      { band: '200k+', costUsd: 157.71 },
    ],
    remainder: { costUsd: 4, reason: 'before-collection', label: 'not banded — before collection began' },
    totalUsd: 408.31,
  },
  session_economics: {
    sessions: 38, medianUsd: 2.1, p90Usd: 23.4, topShare: { n: 3, pct: 61 }, arm: 'otel',
  },
  model_mix: {
    rows: [
      { key: 'claude-opus-5', label: 'claude-opus-5', cost_usd: '148.10', tokens: 100, gap_reason: null },
      { key: 'claude-sonnet-5', label: 'claude-sonnet-5', cost_usd: '121.44', tokens: 90, gap_reason: null },
      {
        key: '__null_model:provider-day-grain', label: 'Copilot day-grain money',
        cost_usd: '61.02', tokens: 0, gap_reason: 'provider-day-grain',
      },
      {
        key: '__null_model:awaiting-provider-detail', label: 'Awaiting provider detail',
        cost_usd: '43.75', tokens: 0, gap_reason: 'awaiting-provider-detail',
      },
    ],
    total_usd: '374.31',
  },
  where_it_went: {
    total_usd: '374.31',
    untagged_usd: '22.10',
    /*
     * The FOUR no-project states, summing to the $22.10 footing remainder
     * (r3-M5). Only $3.00 of it is anybody's queue: $7.00 already carries an
     * activity tag, $5.00 was DISMISSED ("leave it unallocated"), and $7.10 is
     * §A arm-3 provider usage with nothing to attach a project to.
     */
    no_project: {
      worklist_usd: '3.00',
      activity_tagged_usd: '7.00',
      dismissed_usd: '5.00',
      untaggable_usd: '7.10',
    },
    rows: [
      {
        // T17's fixture: the caller's share is SMALL but the project is OVER —
        // the cell must show the PROJECT's state.
        project_id: 'p1', code: 'ACME-1', display_name: 'Acme Platform',
        mine_usd: '228.40', project_total_usd: '3410.22', allocation_usd: '3000.00', is_member: true,
      },
      {
        project_id: 'p2', code: 'ENDED-1', display_name: 'Ended Engagement',
        mine_usd: '92.51', project_total_usd: '980.03', allocation_usd: null, is_member: false,
      },
    ],
  },
  engagement: {
    claude: {
      sessions: 38, active_days: 9, web_searches: 214,
      surfaces: [
        { tool: 'claude-code', usd: '300.00' },
        { tool: 'claude-ai', usd: '74.31' },
      ],
    },
    copilot: {
      interactions: 214, locKept: 1900, locSuggested: 4600, locDeleted: null,
      locSuggestedToDelete: null, keptPct: 41.3, generationActivity: 88, acceptanceActivity: 70,
      languages: [
        { language: 'TypeScript', sharePct: 52 },
        { language: 'Python', sharePct: 31 },
        { language: 'Go', sharePct: 17 },
      ],
      models: [{ model: 'gpt-5', sharePct: 100 }],
      harnesses: [
        { harness: 'Copilot CLI', sharePct: 75 },
        { harness: 'Copilot App', sharePct: 25 },
      ],
      ideActivityExcluded: true,
    },
  },
  ...over,
})

const worklistFixture = {
  sessions: [
    {
      session_id: 'wl-sess-1', instance_id: 'i1', tool: 'claude-code', cost_usd: '9.12',
      tokens: 100, last_event: '2026-07-14T10:00:00.000Z', activity: null, by_model: [],
    },
  ],
  unaccounted: [
    { id: 'ua-1', day: '2026-07-12', tool: 'copilot-cli', cost_usd: '6.10', tokens: 0 },
  ],
  dismissed: { sessions: [], unaccounted: [] },
}

// (The recent-sessions fixture retired with the route: ActivityCard fetches
// itself and is stubbed here — see tests/unit/components/activity-card.test.ts.)

// ── Stubs / globals ──────────────────────────────────────────────────────────

const passThrough = (tag: string) => ({ template: `<div data-stub="${tag}"><slot /><slot name="actions" /></div>` })

/** Captures the rows ModelSplitPanel hands the ranked bar (fix 3's gate). */
const RankedBarSpy = {
  props: ['rows', 'topN', 'valueFormat'],
  template: '<div data-testid="ranked-bar-stub">{{ rows.map((r) => r.label).join("|") }}</div>',
}

/** T18's wiring probe: renders its operands, re-emits the worklist intents. */
const NeedsTaggingSpy = {
  props: ['sessions', 'unaccounted', 'dismissed', 'summary', 'loadFailed'],
  template:
    '<div data-testid="needs-tagging-stub" :data-sessions="sessions.length" :data-unaccounted="unaccounted.length" :data-summary-count="summary.needs_tagging_count">' +
    '<button data-testid="stub-tag-day" @click="$emit(\'tag-day\', unaccounted[0])">tag day</button>' +
    '<button data-testid="stub-day-detail" @click="$emit(\'day-detail\', unaccounted[0])">day detail</button>' +
    '<button data-testid="stub-tag-session" @click="$emit(\'tag-session\', sessions[0])">tag session</button>' +
    '</div>',
}

const TagDialogSpy = {
  props: ['target', 'projects', 'activityTypes'],
  template: '<div data-testid="tag-dialog-stub" :data-subject="target ? (target.subject_label ?? target.session_id) : \'\'" />',
}

const DayDrawerSpy = {
  props: ['recordId'],
  template: '<div data-testid="day-drawer-stub" :data-record="recordId ?? \'\'" />',
}

const STUBS = {
  UiPageHead: passThrough('page-head'),
  UiCard: passThrough('card'),
  UiEyebrow: passThrough('eyebrow'),
  UiBadge: passThrough('badge'),
  UiButton: { template: '<button><slot /></button>' },
  UiEmptyState: true,
  NuxtLink: passThrough('link'),
  UsageWindowToggle: passThrough('window-toggle'),
  ChartsStackedBars: true,
  ChartsTrendArea: true,
  ChartRankedBar: RankedBarSpy,
  MeLensDisclosure: true,
  ReportingLaneToggle: {
    props: ['modelValue', 'captions'],
    template: '<div data-testid="lane-toggle" :data-lane="modelValue" />',
  },
  DateRangeControl: { template: '<div data-testid="date-range-stub" />' },
  CcHeaderNotes: {
    props: ['providerStates', 'coverage', 'lane'],
    template: '<div data-testid="chip-row-stub" :data-states="providerStates.length" :data-lane="lane" />',
  },
  SessionDetailDrawer: true,
  ActivityDetailDrawer: true,
  // §F4: Activity owns its own keyset fetch; its behaviour is pinned in
  // tests/unit/components/activity-card.test.ts. Here only the MOUNT matters.
  ActivityCard: { template: '<div data-testid="activity-card-stub" />' },
  HomeNeedsTaggingPanel: NeedsTaggingSpy,
  HomeTagSessionDialog: TagDialogSpy,
  ProviderDayDetailDrawer: DayDrawerSpy,
  UiToolPill: true,
  UsageModelBadge: true,
  Icon: true,
}

const FORMAT_MOCKS = {
  fmtUsd: (n: number | string | null | undefined) =>
    n == null || n === '' || !Number.isFinite(Number(n))
      ? '—'
      : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  fmtTokens: (n: number) => String(n),
  fmtTimeAgo: () => 'just now',
  clientMeta: (tool: string) => ({ name: tool === 'claude-ai' ? 'Claude Chat' : 'Claude Code', icon: 'x' }),
}

async function mountPage(data = fixture()) {
  for (const [k, v] of Object.entries(FORMAT_MOCKS)) vi.stubGlobal(k, v)
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: 't1', displayName: 'Priya' }),
    ensure: async () => {},
  }))
  vi.stubGlobal('usePersonalLens', () => ref<'usage' | 'chargeback'>('usage'))
  vi.stubGlobal('useRefreshOnVisible', () => {})
  vi.stubGlobal('useReportState', () => ({
    month: ref<string | null>(null),
    from: ref<string | null>(null),
    to: ref<string | null>(null),
  }))
  stubServerClock()
  vi.stubGlobal('useFetch', (url: string, opts?: { query?: { value?: Record<string, unknown> } }) => {
    void computed(() => opts?.query?.value ?? {}).value
    const body = url.startsWith('/api/v1/me/usage')
      ? data
      : url.startsWith('/api/v1/me/sessions/untagged')
        ? worklistFixture
        : url.startsWith('/api/v1/me/quarantined-spend')
          ? { sessions: [] }
          : url.startsWith('/api/v1/me/projects')
            ? { projects: [] }
            : { activity_types: [] }
    return { data: ref(body), refresh: vi.fn(), pending: ref(false), error: ref(null) }
  })
  const Parent = defineComponent({
    components: { ConsumptionPage },
    template: '<Suspense><ConsumptionPage /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: FORMAT_MOCKS } })
  await flushPromises()
  return w
}

afterEach(() => vi.unstubAllGlobals())

// ── T14 — the rebuild band ───────────────────────────────────────────────────

describe('/usage rebuild — month band + four tiles (T14)', () => {
  it('renders the band (month word + headline) and the four hero tiles', async () => {
    const w = await mountPage()
    const band = w.find('[data-testid="month-band"]')
    expect(band.text()).toContain('July 2026')
    expect(band.find('[data-testid="mtd-scalar"]').text()).toContain('374.31')
    expect(band.text()).toContain('day 14 of 31')
    expect(w.findAll('[data-testid="scope-kpi-tile"]')).toHaveLength(4)
    // Per-tile deltas with the shared basis phrase.
    expect(w.find('[data-testid="me-tile-attributed"] [data-testid="kpi-delta"]').text()).toContain(
      'vs last month',
    )
  })

  it('day-1 fixture: withheld deltas say "too early to compare"', async () => {
    const early = heroTiles.map((t) =>
      t.key === 'quota' ? t : { ...t, delta_pct: null, delta_abs: null, delta_empty_reason: 'too early to compare', spark: [1] },
    )
    const w = await mountPage(fixture({ hero_tiles: { window: heroWindow, tiles: early } }))
    expect(w.find('[data-testid="me-tile-attributed"] [data-testid="kpi-delta-empty"]').text()).toBe(
      'too early to compare',
    )
    // The spark has NO floor (F2/D7): one day is one point, and the rest of the
    // month is drawn as the dots it has not reached yet.
    const spark = w.find('[data-testid="me-tile-attributed"] [data-testid="month-spark"]')
    expect(spark.exists()).toBe(true)
    expect(spark.findAll('[data-testid="month-spark-dot"]')).toHaveLength(30)
    expect(w.text()).not.toContain('not enough days yet')
  })

  it('custom range: the named no-MoM reason + the quota month-basis reason', async () => {
    const rangeWindow = { from: '2026-07-01', to: '2026-07-15', is_month: false, month: null, days_elapsed: null, days_in_month: null }
    const rangeTiles = heroTiles.map((t) =>
      t.key === 'quota'
        ? { ...t, quota_basis: 'custom-range' }
        : { ...t, delta_pct: null, delta_abs: null, delta_empty_reason: 'no month-on-month for a custom range' },
    )
    const w = await mountPage(
      fixture({ hero_tiles: { window: rangeWindow, tiles: rangeTiles } }),
    )
    expect(w.find('[data-testid="month-band"]').text()).toContain('2026-07-01 → 2026-07-15')
    expect(w.find('[data-testid="me-tile-active_days"] [data-testid="kpi-delta-empty"]').text()).toBe(
      'no month-on-month for a custom range',
    )
    expect(w.find('[data-testid="me-tile-quota"]').text()).toContain('calendar-month measure')
  })

  it('window presets are mounted (D16) beside the lane toggle', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="date-range-stub"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-toggle"]').exists()).toBe(true)
  })

  it('Daily spend keeps its 30/90 toggle, stack toggle and advisory footnote (D18)', async () => {
    const w = await mountPage()
    const card = w.find('[data-testid="trend-card"]')
    expect(card.exists()).toBe(true)
    expect(card.find('[data-stub="window-toggle"]').exists()).toBe(true)
    expect(card.find('[data-testid="stack-toggle"]').exists()).toBe(true)
    expect(card.text()).toContain('$96.40 of the last 30d is advisory')
  })

  it('the chip row mounts from the payload operands (D14) and the prose is gone', async () => {
    const w = await mountPage()
    const chip = w.find('[data-testid="chip-row-stub"]')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('data-states')).toBe('2')
    expect(chip.attributes('data-lane')).toBe('usage')
    // The worst-of-sources freshness sentence retired WITH its replacement.
    expect(w.find('[data-testid="page-freshness"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Data as fresh as its stalest source')
  })
})

// ── T16 — Top models on self ─────────────────────────────────────────────────

describe('/usage rebuild — Top models (T16)', () => {
  it('remainder rows become the reason-typed footer, never category rows', async () => {
    const w = await mountPage()
    // The ranked bar received ONLY the named models.
    const bars = w.find('[data-testid="ranked-bar-stub"]').text()
    expect(bars).toBe('claude-opus-5|claude-sonnet-5')
    expect(bars).not.toContain('Copilot day-grain money')
    // The coverage footer prices each reason.
    const footer = w.find('[data-testid="model-split-footer"]').text()
    expect(footer).toContain('$269.54') // named Σ (148.10 + 121.44)
    expect(footer).toContain('$61.02 Copilot money is day-grain')
    expect(footer).toContain('$43.75 awaiting provider detail')
  })

  it('the three donut mounts are GONE (D41)', async () => {
    const w = await mountPage()
    for (const gone of ['mix-models', 'mix-token-types', 'mix-destination']) {
      expect(w.find(`[data-testid="${gone}"]`).exists()).toBe(false)
    }
  })

  it('the insights card pairs beside it — self-visible, dismissible (kept)', async () => {
    const w = await mountPage()
    const card = w.find('[data-testid="insights-card"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('Cache hit ratio 14%')
    expect(card.find('[data-testid="dismiss-cache-hit-starvation"]').exists()).toBe(true)
  })
})

// ── T17 — Where it went ──────────────────────────────────────────────────────

describe('/usage rebuild — Where it went (T17)', () => {
  it('the against-budget cell shows the PROJECT state — over while the caller share is small', async () => {
    const w = await mountPage()
    const row = w.find('[data-testid="where-row-ACME-1"]')
    expect(row.text()).toContain('$228.40') // the caller's share
    const consumed = row.find('[data-testid="budget-state-consumed"]')
    // 3410.22 / 3000 → the PROJECT is over; the cell must say so.
    expect(consumed.text()).toContain('114%')
    expect(consumed.classes()).toContain('text-rag-red')
    /*
     * Per-row pace on the PROJECT's own projection (never the portfolio). This
     * project is heading PAST its budget — $7,551.20 against $3,000 — so the
     * pace renders as state rather than as a third grey clause: the multiple
     * leads, the money follows. A pace that lands under budget keeps the quiet
     * `budget-state-pace` treatment.
     */
    const pace = row.find('[data-testid="budget-state-pace-over"]')
    expect(pace.text()).toContain('252%')
    expect(pace.text()).toContain('~$7,551.20')
    expect(row.find('[data-testid="budget-state-pace"]').exists()).toBe(false)
  })

  it('a null allocation reads "no budget set"; the untagged row is n/a with the worklist pill', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="where-row-ENDED-1"]').text()).toContain('no budget set')
    const untagged = w.find('[data-testid="where-row-untagged"]')
    expect(untagged.text()).toContain('$22.10')
    expect(untagged.find('[aria-label="not applicable"]').exists()).toBe(true)
    expect(untagged.find('[data-testid="where-untagged-worklist-pill"]').attributes('href')).toBe('#worklist')
  })

  /*
   * r3-M5 — "$X untagged → worklist" claimed the WHOLE no-project remainder as
   * work the developer owed. Three of its four states are not: an activity tag
   * is a decision already made, a dismissal is a decision explicitly made, and
   * arm-3 provider usage can never be tagged at all. The pill is a link INTO the
   * queue, so it must state the queue's money and nothing else.
   */
  it('the worklist pill quotes the WORKLIST-ELIGIBLE figure, never the whole no-project remainder', async () => {
    const w = await mountPage()
    const pill = w.find('[data-testid="where-untagged-worklist-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('$3.00')
    // The remainder is $22.10 and the row still shows it — but the PROMISE of
    // actionable work must not.
    expect(pill.text()).not.toContain('22.10')
    expect(w.find('[data-testid="where-row-untagged"]').text()).toContain('$22.10')
  })

  it('the other no-project states are drawn as their own segments, not folded away', async () => {
    const w = await mountPage()
    const row = w.find('[data-testid="where-row-untagged"]')
    // Each state present in the payload gets its own segment; the bar IS the
    // disclosure (owner ruling: visuals tell the story, no paragraph).
    for (const key of ['worklist', 'activity_tagged', 'dismissed', 'untaggable']) {
      const seg = row.find(`[data-testid="where-untagged-seg-${key}"]`)
      expect(seg.exists(), `segment ${key} must render`).toBe(true)
    }
    expect(row.find('[data-testid="where-untagged-seg-dismissed"]').attributes('title')).toContain(
      '$5.00',
    )
  })

  it('a zero-worklist window shows NO pill — an empty queue is not a call to action', async () => {
    const base = fixture()
    const w = await mountPage(
      fixture({
        where_it_went: {
          ...base.where_it_went,
          no_project: {
            worklist_usd: '0.00',
            activity_tagged_usd: '0.00',
            dismissed_usd: '0.00',
            untaggable_usd: '22.10',
          },
        },
      }),
    )
    expect(w.find('[data-testid="where-untagged-worklist-pill"]').exists()).toBe(false)
    expect(w.find('[data-testid="where-row-untagged"]').text()).toContain('$22.10')
  })

  it('rows foot to the window total including the untagged row', async () => {
    const w = await mountPage()
    const card = w.find('[data-testid="where-it-went"]')
    // 228.40 + 92.51 + 22.10 = 343.01 + ... the fixture's Σ mine + untagged
    for (const usd of ['$228.40', '$92.51', '$22.10']) expect(card.text()).toContain(usd)
  })

  it('member rows LINK to the project; a non-member row is plain text (D29 rule)', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="where-link-ACME-1"]').exists()).toBe(true)
    expect(w.find('[data-testid="where-link-ENDED-1"]').exists()).toBe(false)
  })
})

// ── D22 — the engagement pair ────────────────────────────────────────────────

describe('/usage rebuild — engagement side-by-side (D22/T9)', () => {
  it('each provider speaks its OWN vocabulary — no fake symmetry', async () => {
    const w = await mountPage()
    const claude = w.find('[data-testid="engagement-claude"]')
    expect(claude.text()).toContain('38 sessions')
    expect(claude.text()).toContain('214 web searches')
    expect(claude.text().toLowerCase()).not.toContain('lines') // Claude emits no LOC

    const copilot = w.find('[data-testid="engagement-copilot"]')
    expect(copilot.text()).toContain('214 interactions')
    expect(copilot.text()).toContain('1.9k lines kept')
    expect(copilot.text()).toContain('4.6k suggested')
    expect(copilot.text().toLowerCase()).not.toContain('session') // Copilot has no sessions
    // Deleted-LOC legs are ABSENT when the wire lacks them (honest numbers).
    expect(copilot.find('[data-testid="engagement-copilot-deleted"]').exists()).toBe(false)
  })

  it('the harness bar splits CLI vs App, names its basis, and never says "session"', async () => {
    // The Copilot App is a harness peer of the CLI. Without this the whole bar
    // could be deleted and every other page test would still pass (measured).
    const w = await mountPage()
    const copilot = w.find('[data-testid="engagement-copilot"]')
    expect(copilot.find('[data-testid="engagement-copilot-harness-bar"]').exists()).toBe(true)
    const legend = copilot.find('[data-testid="engagement-copilot-harness-legend"]')
    expect(legend.text()).toContain('Copilot CLI 75%')
    expect(legend.text()).toContain('Copilot App 25%')
    // The basis is PRINTED: the Claude card's bar beside it splits money.
    expect(copilot.text()).toContain('by requests')
    // D22 again, on the new surface specifically — `session_count` was available
    // and rejected as the weight for exactly this reason.
    expect(copilot.text().toLowerCase()).not.toContain('session')
  })

  it('the IDE note stands alone when there is no harness bar — the COMMON case', async () => {
    /*
     * 60 of 74 observed user-days carry IDE activity and neither CLI nor App
     * (capture 2026-08-19), so nesting this note inside the bar hid it from most
     * users — they saw no harness line and no reason why.
     */
    const w = await mountPage(
      fixture({
        engagement: {
          claude: null,
          copilot: {
            interactions: null, locKept: null, locSuggested: null, locDeleted: null,
            locSuggestedToDelete: null, keptPct: null, generationActivity: null,
            acceptanceActivity: null, languages: null, models: null,
            harnesses: null, ideActivityExcluded: true,
          },
        },
      }),
    )
    const copilot = w.find('[data-testid="engagement-copilot"]')
    expect(copilot.find('[data-testid="engagement-copilot-harness-bar"]').exists()).toBe(false)
    expect(copilot.find('[data-testid="engagement-copilot-harness-ide-note"]').text()).toContain(
      'different measure',
    )
    // ideActivityExcluded alone must count as detail, or this renders the
    // "no detail" empty state while holding something to say.
    expect(copilot.find('[data-testid="engagement-copilot-nodetail"]').exists()).toBe(false)
  })

  it('a single harness renders at 100% with no note when no IDE activity exists', async () => {
    const w = await mountPage(
      fixture({
        engagement: {
          claude: null,
          copilot: {
            interactions: 5, locKept: null, locSuggested: null, locDeleted: null,
            locSuggestedToDelete: null, keptPct: null, generationActivity: null,
            acceptanceActivity: null, languages: null, models: null,
            harnesses: [{ harness: 'Copilot App', sharePct: 100 }],
            ideActivityExcluded: false,
          },
        },
      }),
    )
    const copilot = w.find('[data-testid="engagement-copilot"]')
    expect(copilot.find('[data-testid="engagement-copilot-harness-legend"]').text()).toContain(
      'Copilot App 100%',
    )
    expect(copilot.find('[data-testid="engagement-copilot-harness-ide-note"]').exists()).toBe(false)
  })

  it('a provider with no rows renders an empty state, not zeros (D22 empty states)', async () => {
    const w = await mountPage(fixture({ engagement: { claude: null, copilot: null } }))
    expect(w.find('[data-testid="engagement-claude-empty"]').text()).toContain('No Claude usage')
    expect(w.find('[data-testid="engagement-copilot-empty"]').text()).toContain('No Copilot activity')
    expect(w.find('[data-testid="engagement-claude"]').text()).not.toContain('0 sessions')
  })
})

// ── D19 — the cost-behaviour row ─────────────────────────────────────────────

describe('/usage rebuild — residency + session economics (D19)', () => {
  it('residency renders bands + the reason-typed remainder footer', async () => {
    const w = await mountPage()
    const card = w.find('[data-testid="context-residency-card"]')
    expect(card.find('[data-testid="residency-band-0-200k"]').text()).toContain('$246.60')
    expect(card.find('[data-testid="residency-band-200k+"]').text()).toContain('$157.71')
    expect(card.find('[data-testid="residency-remainder"]').text()).toContain(
      'not banded — before collection began',
    )
    expect(card.text()).toContain('the premium band')
  })

  it('session economics: median / p90 / top-3 share, arm disclosed via (i)', async () => {
    const w = await mountPage()
    const card = w.find('[data-testid="session-economics-card"]')
    expect(card.text()).toContain('$2.10')
    expect(card.text()).toContain('$23.40')
    expect(card.text()).toContain('61%')
    expect(card.text()).toContain('OTel-observed sessions')
    expect(card.find('[data-testid="info-dot"]').exists()).toBe(true)
  })

  it('day-1 honesty: a thin distribution says so instead of drawing one', async () => {
    const w = await mountPage(
      fixture({
        session_economics: { sessions: 2, medianUsd: 1, p90Usd: 2, topShare: { n: 3, pct: null }, arm: 'otel' },
      }),
    )
    expect(w.find('[data-testid="session-economics-early"]').text()).toContain(
      '2 sessions so far — a distribution needs a few days',
    )
  })
})

// ── T18/T19 — the worklist contract mounts, untouched ────────────────────────

describe('/usage rebuild — worklist + sessions mounts (T18/T19)', () => {
  it('mounts the needs-tagging panel with the same operands Home feeds it', async () => {
    const w = await mountPage()
    const panel = w.find('[data-testid="needs-tagging-stub"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('data-sessions')).toBe('1')
    expect(panel.attributes('data-unaccounted')).toBe('1')
    expect(panel.attributes('data-summary-count')).toBe('3')
  })

  it('tag-day opens the SAME dialog with the day subject; day-detail opens the drawer', async () => {
    const w = await mountPage()
    await w.find('[data-testid="stub-tag-day"]').trigger('click')
    expect(w.find('[data-testid="tag-dialog-stub"]').attributes('data-subject')).toBe('2026-07-12')
    await w.find('[data-testid="stub-day-detail"]').trigger('click')
    expect(w.find('[data-testid="day-drawer-stub"]').attributes('data-record')).toBe('ua-1')
  })

  it('tag-session opens the dialog with the session subject', async () => {
    const w = await mountPage()
    await w.find('[data-testid="stub-tag-session"]').trigger('click')
    expect(w.find('[data-testid="tag-dialog-stub"]').attributes('data-subject')).toBe('wl-sess-1')
  })

  it('Activity mounts, and the worklist above it STAYS (§F4)', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="activity-card-stub"]').exists()).toBe(true)
    // The worklist is the TASK list and Activity is the RECORD — the fix is one
    // list gaining provider-days, not the worklist being replaced by it.
    expect(w.find('[data-testid="needs-tagging-stub"]').exists()).toBe(true)
  })
})

// ── T24 — the retirement, and what is NOT retired ────────────────────────────

describe('/usage rebuild — cache/aux retirement (T24, D23)', () => {
  it('the cache-card and aux-card are gone', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="cache-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="aux-card"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Cache economics')
    expect(w.text()).not.toContain('harness overhead')
  })

  it('NOT retired: the detectors’ card renders findings; the playbook route is intact', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="insights-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="playbook-link"]').exists()).toBe(true)
  })

  it('the mix-destination nudge line died with its donut', async () => {
    const w = await mountPage()
    expect(w.text()).not.toContain('tag them on the dashboard')
  })
})

/*
 * ── T18's diff-guard — source-level, no mount ────────────────────────────────
 * The #231/#235 contract lives in the components and their endpoints. This
 * change may MOUNT them; it may not MODIFY them. The guard pins the load-
 * bearing strings of each contract surface, plus the identical dual-mount
 * wiring on Home and /usage — a drifted copy on either page goes red here.
 */
describe('worklist contract diff-guard (T18)', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('the contract components keep their endpoint strings and events', () => {
    const panel = read('app/components/home/NeedsTaggingPanel.vue')
    for (const s of ["'tagSession'", "'tagDay'", "'dayDetail'", "'tagBulk'", "'changed'"]) {
      expect(panel).toContain(s)
    }
    const drawer = read('app/components/provider-day/DetailDrawer.vue')
    expect(drawer).toContain('/api/v1/me/unaccounted/')
    const dialog = read('app/components/home/TagSessionDialog.vue')
    expect(dialog).toContain('/api/v1/me/worklist/bulk')
  })

  it('Home and /usage mount the SAME worklist wiring', () => {
    const home = read('app/pages/index.vue')
    const usage = read('app/pages/usage/index.vue')
    for (const wiring of [
      '@tag-session="openTagSession"',
      '@tag-day="openTagUnaccounted"',
      '@day-detail="openProviderDayDetail"',
      '@tag-bulk="openTagBulk"',
      '@changed="onWorklistChanged"',
      ':record-id="providerDayDetailId"',
      '@saved="onTagSaved"',
    ]) {
      expect(home).toContain(wiring)
      expect(usage).toContain(wiring)
    }
    // Both pages mount the ONE Activity card (D24.1, §F4) and route BOTH row
    // kinds at the drawers that already exist — neither page builds a second
    // details pane, and neither still calls the retired recent-sessions route.
    for (const src of [home, usage]) {
      expect(src).toContain('<ActivityCard')
      expect(src).toContain('@open-session="openSessionDetail"')
      expect(src).toContain('@open-provider-day="providerDayDetailId = $event"')
      expect(src).not.toContain('/api/v1/me/sessions/recent')
      expect(src).not.toContain('RecentSessionsCard')
    }
  })

  it('the donut idiom and the retired cards are absent from the page source (D41)', () => {
    const usage = read('app/pages/usage/index.vue')
    expect(usage).not.toContain('ChartsDonutChart')
    expect(usage).not.toContain('cache-card')
    expect(usage).not.toContain('aux-card')
  })
})
