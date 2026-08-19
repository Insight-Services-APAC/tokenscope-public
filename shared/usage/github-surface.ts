/*
 * github-surface — the GitHub provider adapter for the shared/usage/lanes.ts
 * registry (sibling of the Anthropic adapter in shared/usage/surface.ts).
 *
 * GitHub contributes TWO kinds of lanes (provider-billing-attribution-model.md
 * §A/§B split):
 *   - 'copilot' — the §A USAGE lane, fed by the OTel wire tool literal
 *     'copilot-cli' (also the historical attribution/actual-spend value).
 *     'copilot-cli' remains the §A lane id ONLY: no *_chargeback* view may emit
 *     or filter tool='copilot-cli' except to EXCLUDE §A rows (the mig-0081
 *     firewall; enforced by the pg_get_viewdef integration test).
 *   - 'copilot-agent' — the §A Copilot CODING AGENT usage lane (design D4).
 *     Fed by reconciliation_record category='copilot_coding_agent' (GitHub
 *     ai_credit/usage), surfaced by v_teammate_usage_daily (mig 0086) with
 *     tool='copilot-agent'. The category is OTel-INVISIBLE / ingest_only:
 *     no OTel emission ever carries this tool, so the lane is usage DISPLAY
 *     only — never taggable (excluded from the §A needs-tagging
 *     reconciliation), never OTel-joined, never a charge.
 *   - the three §B CHARGEBACK lanes (D2 lane split) — pooled per cost-owning
 *     unit, fed by copilot_pool_bill (the bill reader), NOT by OTel emission,
 *     so they own no `tool`s. `v_finance_copilot_pool_chargeback` (mig 0085)
 *     emits their lane ids in its `tool` column:
 *       copilot-license      ← license_net_usd      (seat SKUs)
 *       copilot-usage        ← overage_net_usd      (AI-credit / agent SKUs)
 *       copilot-unclassified ← unclassified_net_usd (bill lines matching
 *         neither classifier — VISIBLE everywhere, NEVER charged: excluded
 *         from every chargeableUsd until an operator classifies the SKU and
 *         re-runs the month; see docs/build/worker-scheduler.md).
 *
 * Pure TS with no runtime imports (the lanes import is type-only), so it sits
 * in `shared/` alongside its siblings.
 */
import type { ProviderSurfaceAdapter } from './lanes'

/** The §A usage tool literals (v_teammate_usage_daily copilot-branch values). */
export const COPILOT_CLI_TOOL = 'copilot-cli'
export const COPILOT_AGENT_TOOL = 'copilot-agent'

/*
 * The Copilot App harness, peer of the CLI. Written only to `provider_usage_fact`
 * (token row; model and cost_usd NULL), never emitted by v_teammate_usage_daily.
 * Rides the 'copilot' lane: the wire splits App from CLI for tokens but not money
 * (capture 2026-08-19), so a per-harness credit share would be a ratio. Mig 0120's
 * CHECK does NOT prevent that — it guards the model axis; the writer does, keeping
 * cost on the credits row alone.
 */
export const COPILOT_APP_TOOL = 'copilot-app'

/** The §B chargeback lane ids (view-emitted; no OTel tool). */
export const COPILOT_LICENSE_LANE = 'copilot-license'
export const COPILOT_USAGE_LANE = 'copilot-usage'
export const COPILOT_UNCLASSIFIED_LANE = 'copilot-unclassified'

/*
 * Every §B Copilot chargeback lane, in canonical display order — the set
 * v_finance_copilot_pool_chargeback emits and every §B reporting site splits
 * on (never hand literals in SQL: sites build IN/NOT IN lists from this).
 */
export const GITHUB_ALL_CHARGEBACK_LANES = [
  COPILOT_LICENSE_LANE,
  COPILOT_USAGE_LANE,
  COPILOT_UNCLASSIFIED_LANE,
] as const

export type GithubChargebackLane = (typeof GITHUB_ALL_CHARGEBACK_LANES)[number]

/*
 * The CHARGEABLE subset: what may fold into a chargeableUsd in chargeback
 * mode. copilot-unclassified is deliberately absent — an unclassified bill
 * line is money we cannot yet attribute to a SKU class, so it is surfaced
 * (lane + column + alert) but NEVER charged (design D2, r1-F10).
 *
 * copilot-license IS chargeable despite Copilot being usage-billed — the two
 * easily-conflated rules: DERIVING license money as seats x flat rate is
 * forbidden (copilot-pool-bill.ts "WRONG model #2"), READING the license net off
 * the invoice's own "Copilot Enterprise" SKU line is required. Dropping the lane
 * breaks Σ v_finance_chargeback_month = Σ v_finance_bill_totals_month
 * (00-build-design.md §invariant 1).
 */
export const GITHUB_CHARGEABLE_LANES = [COPILOT_LICENSE_LANE, COPILOT_USAGE_LANE] as const

export const githubSurfaceAdapter = {
  provider: 'github',
  lanes: [
    // COPILOT_APP_TOOL rides this lane rather than owning one — see its constant
    // for why the wire cannot support an App lane that carries money.
    { id: 'copilot', label: 'Copilot', tools: [COPILOT_CLI_TOOL, COPILOT_APP_TOOL] },
    // §A coding-agent usage lane (D4): view-fed (mig 0086) — display-only,
    // never taggable; its tool literal never appears in OTel emission.
    { id: 'copilot-agent', label: 'Copilot Coding Agent', tools: [COPILOT_AGENT_TOOL] },
    // §B chargeback lanes: billing-fed, no OTel tool of their own (LaneDef
    // allows empty `tools`); ordered after the usage lanes, before vendor.ts
    // appends the 'other' catch-all.
    { id: COPILOT_LICENSE_LANE, label: 'Copilot License', tools: [] },
    { id: COPILOT_USAGE_LANE, label: 'Copilot Usage', tools: [] },
    { id: COPILOT_UNCLASSIFIED_LANE, label: 'Copilot (unclassified)', tools: [] },
  ],
} as const satisfies ProviderSurfaceAdapter

/*
 * Every §A GitHub usage tool literal, in canonical display order — derived from
 * the adapter (the §B lanes own no tools, so they contribute nothing). §A readers
 * that want "ALL Copilot usage" (e.g. the Overage-Drivers weight) build their IN
 * lists from this — never hand literals in SQL (copilot-surface-lanes checklist).
 *
 * Mixed origin: copilot-cli / copilot-agent from `v_teammate_usage_daily`,
 * copilot-app only from `provider_usage_fact`.
 */
export const GITHUB_USAGE_TOOLS: readonly string[] = githubSurfaceAdapter.lanes.flatMap((l) => [
  ...l.tools,
])

/*
 * What `v_teammate_usage_daily` emits — its actual_spend branch's exclusion list
 * (mig 0086), which ab-decomposition.ts's chargeback-exempt term must mirror
 * exactly. Pinned by the mig 0086/0101 guards in tests/unit/usage/surface.test.ts.
 */
export const GITHUB_USAGE_VIEW_TOOLS: readonly string[] = GITHUB_USAGE_TOOLS.filter(
  (t) => t !== COPILOT_APP_TOOL,
)

/* The display-only subset now lives as INGEST_ONLY_USAGE_TOOLS in ./surface.ts. */

/** Every GitHub lane id (usage + chargeback). Prefer GITHUB_FIREWALL_EXCLUSIONS
 * for Anthropic-remainder predicates — the lane ids alone miss 'copilot-cli'. */
export const GITHUB_LANES: readonly string[] = githubSurfaceAdapter.lanes.map((l) => l.id)

/*
 * The §B ANTHROPIC-ARM FIREWALL — the ONE registry-derived exclusion set every
 * §B site uses to compute "the non-GitHub (Anthropic) remainder" of a
 * chargeback split: every GitHub id a tool-shaped column can carry, i.e. the
 * lane ids (usage 'copilot' / 'copilot-agent' + the three chargeback lanes)
 * ∪ the §A usage tool literals. NEVER use the narrower
 * GITHUB_ALL_CHARGEBACK_LANES for an exclusion: a stray §A copilot row landing on
 * a bill surface must fall OUT of the Anthropic arm everywhere, not just in
 * finance.ts (r1 finding 1).
 *
 * The SQL NOT IN lists in migs 0085/0115 mirror this for the VIEW-EMITTED tools
 * only. copilot-app is absent from them by construction: it reaches no chargeback
 * view. Anything that writes copilot-app to `actual_spend` must add it there too.
 */
export const GITHUB_FIREWALL_EXCLUSIONS: readonly string[] = [
  ...new Set<string>([...GITHUB_LANES, ...GITHUB_USAGE_TOOLS]),
]

/*
 * The registry-derived §A GitHub USAGE lane ids ('copilot' + 'copilot-agent') —
 * the two lanes that draw against the SAME pooled per-org AI-Credit allowance
 * (docs/wiki/Reporting.md §5: "ALL Copilot usage lanes weigh in... the coding
 * agent draws from exactly like interactive use"). Derived from the adapter
 * (never a hand-typed `['copilot', 'copilot-agent']` literal) by filtering to
 * lanes that own at least one emit tool — the three §B chargeback lanes have
 * none (billing-fed), so this is exactly the two usage lanes. Used to mark a
 * `surface`-axis driver row `pooled-usage` (the per-teammate $ is informational
 * — GitHub Copilot bills the ORG pool, never a per-user charge).
 */
export const GITHUB_USAGE_LANE_IDS: readonly string[] = githubSurfaceAdapter.lanes
  .filter((l) => l.tools.length > 0)
  .map((l) => l.id)
