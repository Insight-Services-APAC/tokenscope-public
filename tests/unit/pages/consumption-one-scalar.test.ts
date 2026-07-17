// @vitest-environment happy-dom
/*
 * /consumption (app/pages/consumption/index.vue) — the §I3 "one honest number"
 * page contract (D2: the shipped page rendered "$360 MTD" beside "$2,219
 * window spend" with no explanation):
 *
 *   - exactly ONE MTD-shaped scalar renders on the page ([data-mtd-scalar]),
 *     and it is the PROVIDER-TRUTH MTD — never the attribution month number;
 *   - the attributed month spend feeds ONLY the quota bar (never rendered as
 *     a second MTD $ figure);
 *   - ONE worst-of-sources freshness line replaces the per-card footnotes
 *     ("updated Xm ago" / "series refreshed Xm ago" are gone);
 *   - the hero renders both basis groups (its chips are per-LANE figures,
 *     each labelled, so they are not page-MTD-shaped scalars).
 *
 * Same mounting idiom as reporting-shell.test.ts: stub the Nuxt auto-import
 * globals, register pass-through stubs for the UI kit, wrap in <Suspense>.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import ConsumptionPage from '../../../app/pages/consumption/index.vue'
import HeroCard from '../../../app/components/consumption/HeroCard.vue'

const ATTRIBUTED_MONTH = '360.00' // must never render as an MTD scalar
const PROVIDER_TRUTH = '2483.55' // the page's ONE MTD scalar

const runRate = (mtd: string) => ({
  projected_month_end_usd: (Number(mtd) * 2).toFixed(2),
  days_elapsed: 15,
  days_in_month: 31,
  method: 'linear-mtd',
})

const fixture = () => ({
  month: {
    spend_usd: ATTRIBUTED_MONTH,
    tokens: 3000,
    quota_usd: '100.00',
    base_allowance_usd: '100.00',
    allocation_usd: '0.00',
    run_rate: runRate(ATTRIBUTED_MONTH),
  },
  window_days: 30,
  series: [{ day: '2026-07-01', cost_usd: '10.00', tokens: 100 }],
  series_by_model: [],
  mix: {
    by_model: [{ model: 'claude-fable-5', tokens: 100, cost_usd: '2219.31' }],
    by_token_type: [],
    buckets: [],
    tagged_spend: [],
    unallocated: { total_cost_usd: '0.00', untagged_cost_usd: '0.00', needs_tagging_count: 0 },
  },
  cache: { read_tokens: 0, write_tokens: 0, input_tokens: 0, hit_ratio: null, savings_usd: null },
  aux: { main_tokens: 0, aux_tokens: 0, unknown_tokens: 0, aux_cost_usd: '0.00', aux_share: null },
  fidelity: { window_cost_usd: '2219.31', advisory_cost_usd: '0.00' },
  insights: [],
  freshness_minutes_ago: 630,
  aggregate_refreshed_minutes_ago: 0,
  hero: {
    window_days: 30,
    // SERVER-provided today (hero.as_of) — the real HeroCard mounts below and
    // must never fall back to a client `new Date()` (hydration, iter2 r1).
    as_of: '2026-07-15',
    groups: [
      {
        id: 'telemetry',
        label: 'Telemetry-attributed',
        basis: 'attributed telemetry usage · weekly',
        lanes: [
          {
            lane: 'claude',
            label: 'Claude Code',
            mtd_usd: '360.00',
            weekly: [{ week_start: '2026-06-29', usd: '360.00' }],
          },
        ],
      },
      {
        id: 'billed',
        label: 'Billed surfaces',
        basis: 'billed usage (provider bill) · weekly',
        lanes: [
          {
            lane: 'claude-ai',
            label: 'Claude Chat',
            mtd_usd: '223.10',
            weekly: [{ week_start: '2026-06-29', usd: '223.10' }],
          },
        ],
      },
    ],
  },
  provider_truth: { month: '2026-07', mtd_usd: PROVIDER_TRUTH, run_rate: runRate(PROVIDER_TRUTH) },
  page_freshness: {
    telemetry_minutes_ago: 630,
    aggregate_minutes_ago: 0,
    provider_feed_minutes_ago: 95,
    worst_minutes_ago: 630,
  },
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
  ChartsUtilBar: true, // quota bar: consumes the attributed spend, renders % only
  ChartsStackedBars: true,
  ChartsTrendArea: true,
  ChartsDonutChart: true,
  ConsumptionHeroCard: HeroCard, // the REAL hero — its chips must not violate the rule
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
}

async function mountPage(data = fixture()) {
  // Script-scope references (inside computed()s) resolve via globalThis;
  // template references via the instance proxy (mocks). Provide both.
  vi.stubGlobal('fmtUsd', FORMAT_MOCKS.fmtUsd)
  vi.stubGlobal('fmtTokens', FORMAT_MOCKS.fmtTokens)
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: 't1', displayName: 'Priya' }),
    ensure: async () => {},
  }))
  vi.stubGlobal('useFetch', () => ({
    data: ref(data),
    refresh: vi.fn(),
    pending: ref(false),
    error: ref(null),
  }))
  const Parent = defineComponent({
    components: { ConsumptionPage },
    template: '<Suspense><ConsumptionPage /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: FORMAT_MOCKS } })
  await flushPromises()
  return w
}

afterEach(() => vi.unstubAllGlobals())

describe('/consumption — one honest number (§I3)', () => {
  it('renders exactly ONE MTD scalar, and it is the provider-truth value', async () => {
    const w = await mountPage()
    const scalars = w.findAll('[data-mtd-scalar]')
    expect(scalars).toHaveLength(1)
    expect(scalars[0]!.text()).toContain('2,483.55')
  })

  it('the attributed month number never renders as text anywhere on the page', async () => {
    const w = await mountPage()
    // $360.00 feeds the quota bar (stubbed — renders % only) and the hero's
    // labelled per-lane chip. As a bare page-level scalar it must not appear:
    // every '360.00' occurrence must live inside the hero's labelled chips.
    const count = (s: string) => s.split('360.00').length - 1
    const total = count(w.text())
    const insideHero = count(w.find('[data-testid="consumption-hero"]').text())
    expect(total).toBe(insideHero)
    expect(w.find('[data-testid="mtd-scalar"]').text()).not.toContain('360.00')
  })

  it('every same-window MTD-shaped scalar agrees: no second, different MTD value renders', async () => {
    const w = await mountPage()
    // Machine-checkable form of the acceptance: group [data-mtd-scalar]
    // elements by their attribute value (window+basis key) — each group must
    // hold exactly one distinct rendered value.
    const byKey = new Map<string, Set<string>>()
    for (const el of w.findAll('[data-mtd-scalar]')) {
      const key = el.attributes('data-mtd-scalar') ?? ''
      const set = byKey.get(key) ?? new Set<string>()
      set.add(el.text().trim())
      byKey.set(key, set)
    }
    for (const [, values] of byKey) expect(values.size).toBe(1)
  })

  it('ONE page freshness line renders; the per-card freshness footnotes are gone', async () => {
    const w = await mountPage()
    const lines = w.findAll('[data-testid="page-freshness"]')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text()).toContain('630m ago')
    expect(w.text()).not.toContain('series refreshed')
    expect(w.text()).not.toMatch(/updated \d+m ago/)
  })

  it('the hero renders BOTH basis groups with their captions and per-lane chips', async () => {
    const w = await mountPage()
    expect(w.find('[data-testid="hero-group-telemetry"]').exists()).toBe(true)
    expect(w.find('[data-testid="hero-group-billed"]').exists()).toBe(true)
    expect(w.find('[data-testid="hero-group-telemetry"]').text()).toContain('attributed telemetry')
    expect(w.find('[data-testid="hero-group-billed"]').text()).toContain('billed usage')
    expect(w.find('[data-testid="hero-chip-telemetry-claude"]').text()).toContain('Claude Code')
    expect(w.find('[data-testid="hero-chip-billed-claude-ai"]').text()).toContain('Claude Chat')
    // No cross-basis scalar: the hero card never renders a combined total.
    expect(w.find('[data-testid="consumption-hero"]').text()).not.toContain('583.10') // 360 + 223.10
  })
})
