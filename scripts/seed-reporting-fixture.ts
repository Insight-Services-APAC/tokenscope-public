/*
 * seed-reporting-fixture — a LOCAL-ONLY synthetic estate, big enough that every
 * /reporting card renders something a designer can judge.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * `npm run db:seed` produces 4 `actual_spend` rows, 9 teammates in ONE region,
 * 8 projects and 6 attribution records. The reporting surfaces are being rebuilt
 * against `docs/design/reporting-consolidation/prototype.html`, which is drawn at
 * ~207 people, ~20 projects and 4 regions. A KPI row reading "avg $6,427.50
 * across 2 users" cannot tell anyone whether the design is right — the parity
 * loop (`scripts/parity-shots.sh`) is comparing a page against an empty state.
 *
 * This writes the estate the prototype assumes. It is a DESIGN fixture: the
 * shapes are real, the money is invented.
 *
 * ── THE ONE RULE: IT MUST NEVER REACH A DEPLOYED ENVIRONMENT ─────────────────
 *
 * This writes tens of thousands of synthetic spend rows across four months and
 * DELETES every spend row in that range first. On Dev or production that is data
 * loss plus a fabricated ledger. It is guarded by TWO independent gates and
 * NEITHER has an override (see `assertLocalOnly`) — `scripts/seed-demo-homepage.ts`
 * offers `SEED_FORCE=1` because it touches one persona's handful of rows; the
 * blast radius here does not earn an escape hatch. Someone who genuinely needs it
 * elsewhere can edit this file, which is the right amount of friction.
 *
 * ── IT OWNS A DATE RANGE, NOT JUST ITS OWN ROWS ─────────────────────────────
 *
 * Re-runnable, and the clean slate is a RANGE: every spend row dated
 * `[rangeStart, endOfCurrentMonth)` is deleted before anything is written,
 * whoever wrote it. That is deliberate and it is the only honest option — the
 * base seed writes a $12,710 spike dated in the FUTURE (2026-08-04 against a
 * 2026-08-03 clock), which lands inside the current REPORT MONTH and dominates
 * every figure on the page. A fixture that left it there would be measuring the
 * base seed. Structural rows (org units, teammates, projects, allocations) are
 * marked `source = 'reporting-fixture'` and only those are removed.
 *
 * Consequence worth stating: this REPLACES what `scripts/seed-demo-homepage.ts`
 * writes for Priya. Run that one after this one if you want her homepage back.
 *
 * ── WHAT IT PRODUCES, AND WHY EACH PIECE EXISTS ─────────────────────────────
 *
 * TWO LANES, SEEDED SEPARATELY AND NEVER COPIED FROM EACH OTHER
 * (`docs/design/provider-billing-attribution-model.md`):
 *
 *   §A attributed usage (`v_complete_usage`), all three arms:
 *     arm 1 `attribution_record`  — the ~32 OTel emitters, project-tagged, per model
 *     arm 2 `unaccounted_usage`   — the API−OTel gap, one row per (teammate, day,
 *                                   tool), wholly tagged or wholly untagged
 *     arm 3 `v_teammate_usage_daily` — the ingest-only surfaces (Claude Chat /
 *                                   Office / Copilot agent), untaggable by
 *                                   construction (mig 0101)
 *
 *   §B billed (`v_finance_*`):
 *     Anthropic — `actual_spend`, one row per (teammate, day, tool), carrying the
 *                 provider's own `raw_payload` so the normalised layer is DERIVED
 *     Copilot   — `copilot_pool_bill`, per (month, provider org), pooled per cost
 *                 centre, with license / overage / unclassified net lines
 *
 * The two lanes are related the way the real system relates them — §A is §B
 * decomposed across arms and tags, PLUS self-billed spend that has no invoice
 * behind it, MINUS nothing — but neither is computed from the other by a ratio.
 * The apportionment factor `f = min(1, T_otel/T_api)` that
 * `target-state-data-architecture.md` §5 deleted appears nowhere here.
 *
 * THE NORMALISED LAYER IS DERIVED, NOT FAKED. `provider_usage_fact` is written by
 * calling the REAL worker (`runProviderTransform`) over the seeded provider
 * payloads — `actual_spend.raw_payload` for `provider='anthropic'`,
 * `reconciliation_record.raw` for `provider='github'`. So the fixture exercises
 * the actual path, the measure-exclusivity and github-money-grain CHECKs are
 * genuinely satisfied, and the Behavioural-exposure card reads rows that arrived
 * the way production's will.
 *
 * DELIBERATE STRUCTURE, so the cards have something to show:
 *   - concentration     — per-person weight is 1/rank, which puts the top 10% on
 *                         ~62% of spend (the prototype publishes 63%)
 *   - a weekday cycle   — Sat/Sun at ~20% of a weekday, so the 7-day trailing
 *                         mean the trend cards overlay has a cycle to cancel
 *   - a growth ramp     — ~+40% across the window, so the trend has a direction
 *   - budget coverage   — all four segments carry mass, and they FOOT because
 *                         they are FILTER aggregates over one scan
 *   - budget RAG        — every cost centre's allocation is derived from its own
 *                         generated burn and a chosen utilisation, so under /
 *                         near / over / none all appear
 *   - unplaced people   — 12 teammates under a non-cost-owning holding node, so
 *                         the "Unassigned" region card and the NULL-cost-centre
 *                         finance bucket both exist
 *   - exempt + self-billed — one whole cost centre is `chargeback_exempt`, and 14
 *                         people run on personal subscriptions with no
 *                         `actual_spend` at all. Those are the two named reasons
 *                         Finance's usage-vs-bill gap exists.
 *
 * WHAT IT DOES NOT PRODUCE, and cannot: spend with NO teammate. All three arms of
 * `v_complete_usage` read `teammate_id NOT NULL` sources, so the prototype's
 * "not matched to a person" coverage segment has no row shape behind it at this
 * commit. The shipped fourth segment is `untaggableUsd` (arm 3), which this
 * fixture does populate. See the report accompanying this change.
 *
 * ── RUN ─────────────────────────────────────────────────────────────────────
 *
 *   npm run db:seed                              # once — this builds ON TOP of it
 *   npx tsx --env-file=.env scripts/seed-reporting-fixture.ts
 *
 * or, with DATABASE_URL already exported:  npm run db:seed:reporting-fixture
 *
 * It prints its own reconciliation checks and EXITS NON-ZERO if any fail, so a
 * fixture that does not foot is a failed run rather than a puzzling screenshot.
 *
 * Deterministic: one PRNG seed, so two runs on the same day produce the same
 * estate and a screenshot diff means a code change.
 */
import { createHash, randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type postgres from 'postgres'
import { createDbClient } from '../drizzle/connect'
import * as schema from '../drizzle/schema'
import { currentServerDeployEnv, isDemoCapableEnv } from '../shared/env/deploy-env'
import { costCentreBudgetState } from '../shared/reports/types'
import { runProviderTransform } from '../server/workers/provider-transform'
import { reconcileUnaccountedUsage } from '../server/usage/unaccounted-reconciliation'

// ── identity of everything this script owns ─────────────────────────────────

/** Stamped into `source` on every STRUCTURAL row, so the wipe is exact. */
const MARK = 'reporting-fixture'
/**
 * `actual_spend.source` cannot be the marker: `armFor` routes on it, and only
 * `anthropic-analytics-api[:<org>]` reaches the Anthropic transform arm. The
 * suffix keeps the row identifiable without leaving the claimed namespace.
 */
const ANTHROPIC_SOURCE = 'anthropic-analytics-api:reporting-fixture'
const GH_ENTERPRISE_REF = 'reporting-fixture-enterprise'
const GH_SOURCE = `copilot-consumption:${GH_ENTERPRISE_REF}`

/** Days of daily history. 60+ is a hard floor: the per-developer card returns
 *  `deltas: null` under 60 points, and the trend cards need a shape. */
const DAYS_BACK = 75

/** Company-wide attributed usage per day at the MIDPOINT of the window, USD.
 *  ~207 people × ~$425/month lands near the prototype's implied full month. */
const DAILY_TARGET_USD = 2_900
/** Multiplier at the window's start and end — the growth the trend cards show. */
const RAMP_START = 0.78
const RAMP_END = 1.3

/** Sun..Sat. The cycle the 7-day trailing mean exists to cancel. */
const WEEKDAY_FACTOR = [0.16, 1.05, 1.12, 1.15, 1.1, 0.94, 0.24]

/** GitHub's flat AI-credit rate, mirroring `adapters/github.ts`. */
const AIC_USD_RATE = 0.04
/** Copilot Enterprise per-seat list, used for the pooled licence line. */
const COPILOT_SEAT_USD = 39

/*
 * Blended $/Mtok per model. Real prices, so tokens are DERIVED from money at a
 * rate that makes the Behavioural-exposure card's two bars tell the truth:
 * frontier takes most of the money for a small share of the volume BECAUSE it
 * costs 25× what economy does, not because a share was typed in.
 */
const MODELS = [
  { name: 'claude-fable-5', usdPerMtok: 30, tier: 'frontier' },
  { name: 'claude-opus-5', usdPerMtok: 22.5, tier: 'frontier' },
  { name: 'claude-opus-4-8', usdPerMtok: 18, tier: 'frontier' },
  { name: 'claude-sonnet-5', usdPerMtok: 4.5, tier: 'mid' },
  { name: 'claude-haiku-4-5', usdPerMtok: 0.9, tier: 'economy' },
] as const
type TierKey = 'frontier' | 'mid' | 'economy'
const FRONTIER = MODELS.filter((m) => m.tier === 'frontier')
const MID = MODELS.filter((m) => m.tier === 'mid')
const ECONOMY = MODELS.filter((m) => m.tier === 'economy')

/** Copilot's model axis. Carries INTERACTIONS only — mig 0120 forbids a GitHub
 *  row holding both a model and money, because the credits sit at day grain. */
const COPILOT_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'claude-sonnet-4-5']

/*
 * ── the deterministic drift day (S1, 07-model-axis-subtraction-build.md D3) ──
 *
 * One persona, one day, handcrafted so ONE model's OTel EXCEEDS its API figure
 * (`otel_m > api_m` — client-computed OTel cost drifting above provider cents)
 * while the day TOTAL still has a positive residual. This is the shape the
 * writer's floor + descending cap exists for: fable floors to 0, and
 * Σ floored (16 + 5 = 21) exceeds R (28 − 10 = 18), so the cap truncates the
 * LAST-ranked cell (haiku 5 → 2) rather than rescaling anything. The
 * `report()` self-check asserts the resulting children byte-for-byte, so a
 * cap-ordering regression fails the fixture run, not just the test suite.
 */
const DRIFT_SPLIT = [
  { model: 'claude-fable-5', apiUsd: 2, otelUsd: 5 }, // the drift: OTel > API → floors to 0
  { model: 'claude-sonnet-5', apiUsd: 20, otelUsd: 4 }, // floored 16 — allocated whole
  { model: 'claude-haiku-4-5', apiUsd: 6, otelUsd: 1 }, // floored 5 — truncated to the remaining 2
] as const

// ── deterministic PRNG ──────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260803)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo)
const round2 = (n: number): number => Math.round(n * 100) / 100

// ── the two safety gates ────────────────────────────────────────────────────

/**
 * Refuse anywhere that is not a developer's own machine. Both gates are
 * fail-CLOSED and neither can be overridden.
 *
 * GATE 1 — `currentServerDeployEnv() === 'local'`. `classifyDeployEnv` returns
 * 'local' only when `NUXT_DEPLOY_ENV` is empty AND `NODE_ENV !== 'production'`;
 * every deployed container sets `NUXT_DEPLOY_ENV`, and an unrecognised or
 * dropped value classifies to 'unknown', not to 'local'. This is the same
 * boundary `dev-login.post.ts` trusts to gate minting an admin session, so it is
 * the project's established one. It is STRICTER than `isDemoCapableEnv`, which
 * also admits 'sandbox' — sandbox is deployed, and this fixture is not for it.
 *
 * GATE 2 — the DATABASE_URL host must not be a fully-qualified name. Managed
 * Postgres is always an FQDN (`*.postgres.database.azure.com`,
 * `*.rds.amazonaws.com`); a loopback address or a compose service name never is.
 * An INDEPENDENT signal, so a mis-set env var alone cannot open the door.
 */
function assertLocalOnly(url: string): void {
  const env = currentServerDeployEnv()
  if (env !== 'local') {
    console.error(
      `\nREFUSING TO RUN.\n` +
        `  deploy env resolved to '${env}', and this fixture is local-only.\n` +
        `  It deletes every spend row in a four-month range and writes tens of\n` +
        `  thousands of synthetic ones. There is no override flag, by design.\n` +
        (isDemoCapableEnv(env)
          ? `  ('${env}' is demo-capable for the narrower seeders, but not for this one.)\n`
          : ''),
    )
    process.exit(1)
  }
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    console.error('\nREFUSING TO RUN: DATABASE_URL is not a parseable URL.\n')
    process.exit(1)
    return
  }
  const bare = host.replace(/^\[|\]$/g, '')
  /*
   * An IPv6 host has no dot, so `[2001:db8::1]` passed this check and would have
   * deleted a four-month range on a remote database; and `127.0.0.2` is loopback
   * yet was refused. The whole 127/8 block is loopback; a host with a dot OR a
   * colon is addressable somewhere; what is left is a bare compose name.
   * (Found in coverage-estate.ts by external review — fixed in both, because
   * this file is where the guard was copied FROM.)
   */
  const loopback = bare === 'localhost' || /^127\./.test(bare) || bare === '::1'
  if (!loopback && (bare.includes('.') || bare.includes(':'))) {
    console.error(
      `\nREFUSING TO RUN.\n` +
        `  DATABASE_URL host '${host}' is a fully-qualified name, which is what a\n` +
        `  managed/remote Postgres looks like. Local dev is loopback or a compose\n` +
        `  service name. There is no override flag, by design.\n`,
    )
    process.exit(1)
  }
}

// ── bulk insert ─────────────────────────────────────────────────────────────

type Sql = postgres.Sql<Record<string, unknown>>

/**
 * Multi-row INSERT with EXPLICIT per-column casts.
 *
 * postgres.js' `sql(rows, ...cols)` helper infers parameter types from the
 * JavaScript values, which silently mis-types `date`, `uuid` and `jsonb` columns
 * on a heterogeneous fixture. Naming the cast per column removes the inference
 * from the loop entirely. Chunked so the parameter count stays well under
 * Postgres' 65535 limit.
 */
async function bulkInsert(
  sql: Sql,
  table: string,
  cols: readonly string[],
  casts: readonly string[],
  rows: readonly unknown[][],
): Promise<number> {
  if (rows.length === 0) return 0
  const perRow = cols.length
  const chunk = Math.max(1, Math.floor(60_000 / perRow))
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const params: unknown[] = []
    const tuples = slice.map((r) => {
      const ph = r.map((v, c) => {
        params.push(v)
        return `$${params.length}${casts[c] ? `::${casts[c]}` : ''}`
      })
      return `(${ph.join(',')})`
    })
    await sql.unsafe(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`,
      params as never[],
    )
  }
  return rows.length
}

// ── dates ───────────────────────────────────────────────────────────────────

const dayKey = (d: Date): string => d.toISOString().slice(0, 10)
function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + n)
  return out
}
const monthKey = (iso: string): string => iso.slice(0, 7)

// ── the estate's shape ──────────────────────────────────────────────────────

interface CostCentreSpec {
  regionCode: string
  code: string
  name: string
  headcount: number
  /**
   * Target burn ÷ allocation for the CURRENT month, which is exactly what the
   * cost-centre card renders (`costCentreBudgetState`: ok < 0.8 ≤ warn < 1.0 ≤
   * over). `null` = no allocation at all, so the card reads "No budget set".
   */
  ccTarget: number | null
  /** Every `actual_spend` row for this centre's people is `chargeback_exempt`. */
  exempt?: boolean
}

const COST_CENTRES: CostCentreSpec[] = [
  { regionCode: 'apac', code: 'apac-cto', name: 'APAC · CTO', headcount: 14, ccTarget: 1.12 },
  { regionCode: 'apac', code: 'apac-mpo', name: 'APAC · Modern Platform & Operations', headcount: 17, ccTarget: 0.88 },
  { regionCode: 'apac', code: 'apac-aiad', name: 'APAC · AI Apps & Data', headcount: 24, ccTarget: 0.63 },
  { regionCode: 'apac', code: 'apac-ms', name: 'APAC · Managed Services', headcount: 15, ccTarget: 0.41 },
  { regionCode: 'apac', code: 'apac-presales', name: 'APAC · Presales', headcount: 14, ccTarget: 0.94 },
  { regionCode: 'north-america', code: 'na-fieldeng', name: 'NA · Field Engineering', headcount: 18, ccTarget: 0.72 },
  { regionCode: 'north-america', code: 'na-modernwork', name: 'NA · Modern Work', headcount: 14, ccTarget: 1.04 },
  { regionCode: 'north-america', code: 'na-security', name: 'NA · Security', headcount: 13, ccTarget: null },
  { regionCode: 'north-america', code: 'na-partner', name: 'NA · Partner Solutions', headcount: 13, ccTarget: 0.55 },
  { regionCode: 'emea', code: 'emea-cto', name: 'EMEA · CTO', headcount: 14, ccTarget: 0.86 },
  { regionCode: 'emea', code: 'emea-dataai', name: 'EMEA · Data & AI', headcount: 13, ccTarget: 0.68 },
  { regionCode: 'emea', code: 'emea-cloud', name: 'EMEA · Cloud Platform', headcount: 11, ccTarget: 0.35, exempt: true },
]

/** People with no resolvable cost-owning ancestor — the "Unassigned" region card
 *  and the NULL-cost-centre finance bucket in one cohort. */
const UNPLACED_HEADCOUNT = 12
/** Fixture people dropped into the base seed's DEMO practices, so that region is
 *  not left as nine teammates against APAC's eighty-four. */
const DEMO_HEADCOUNT = 6

interface ProjectSpec {
  code: string
  name: string
  cc: string
  type: 'billable' | 'pursuit' | 'internal'
  /** Burn ÷ budget for this project alone, before the per-centre normalisation
   *  described in `deriveAllocations`. `null` = deliberately unbudgeted. */
  projTarget: number | null
}

const PROJECTS: ProjectSpec[] = [
  { code: 'FX-TSS', name: 'TokenScope Support', cc: 'apac-cto', type: 'internal', projTarget: 0.87 },
  { code: 'FX-ITL', name: 'Internal Tooling', cc: 'apac-cto', type: 'internal', projTarget: null },
  { code: 'FX-DPM', name: 'Data Platform Migration', cc: 'apac-mpo', type: 'billable', projTarget: 1.14 },
  { code: 'FX-INC', name: 'Incident Response', cc: 'apac-mpo', type: 'internal', projTarget: 0.62 },
  { code: 'FX-AIP', name: 'APAC Internal Projects', cc: 'apac-aiad', type: 'internal', projTarget: 0.97 },
  { code: 'FX-CZ', name: 'Customer Zero', cc: 'apac-aiad', type: 'pursuit', projTarget: null },
  { code: 'FX-SBX', name: 'Sandbox Experiments', cc: 'apac-aiad', type: 'internal', projTarget: 0.44 },
  { code: 'FX-FSP', name: 'Foundation Scholarship Portal', cc: 'apac-ms', type: 'billable', projTarget: 0.71 },
  { code: 'FX-Q2P', name: 'APAC Q2 Solutions Presales', cc: 'apac-presales', type: 'pursuit', projTarget: 1.06 },
  { code: 'FX-NFE', name: 'NA Field Enablement', cc: 'na-fieldeng', type: 'internal', projTarget: null },
  { code: 'FX-CXD', name: 'Client X Delivery', cc: 'na-fieldeng', type: 'billable', projTarget: 0.48 },
  { code: 'FX-CPR', name: 'Copilot Rollout', cc: 'na-modernwork', type: 'internal', projTarget: 0.83 },
  { code: 'FX-SAR', name: 'Security Audit Remediation', cc: 'na-security', type: 'billable', projTarget: null },
  { code: 'FX-PDE', name: 'Partner Demo Environments', cc: 'na-partner', type: 'pursuit', projTarget: 0.71 },
  { code: 'FX-ATL', name: 'Atlas', cc: 'emea-cto', type: 'billable', projTarget: 1.21 },
  { code: 'FX-DOC', name: 'Docs Refresh', cc: 'emea-cto', type: 'internal', projTarget: null },
  { code: 'FX-EPS', name: 'EMEA Presales Support', cc: 'emea-dataai', type: 'pursuit', projTarget: 0.79 },
  { code: 'FX-BRC', name: 'Billing Reconciliation', cc: 'emea-dataai', type: 'internal', projTarget: 0.55 },
  { code: 'FX-OAU', name: 'Onboarding Automation', cc: 'emea-cloud', type: 'billable', projTarget: 0.34 },
  { code: 'FX-MGA', name: 'Migration Assist', cc: 'demo-delta', type: 'billable', projTarget: 0.9 },
]

const GIVEN = [
  'Ahmed', 'Amila', 'Aoife', 'Arjun', 'Astrid', 'Bianca', 'Callum', 'Camila', 'Chen', 'Dana',
  'Diego', 'Elena', 'Emeka', 'Fatima', 'Felix', 'Grace', 'Hana', 'Hiroshi', 'Ingrid', 'Isabel',
  'Jonas', 'Kaito', 'Kwame', 'Lars', 'Lena', 'Liam', 'Lucia', 'Malik', 'Marta', 'Mateo',
  'Mei', 'Nadia', 'Niamh', 'Omar', 'Oskar', 'Paulo', 'Petra', 'Rafael', 'Rania', 'Ravi',
  'Rohan', 'Sanjay', 'Sarah', 'Simone', 'Sofia', 'Tomas', 'Tariq', 'Uma', 'Viktor', 'Wei',
  'Yara', 'Yuki', 'Zainab', 'Zoe', 'Bruno', 'Clara', 'Dmitri', 'Esther', 'Farid', 'Greta',
]
const FAMILY = [
  'Andersen', 'Bakker', 'Brennan', 'Chen', 'Correia', 'Duarte', 'Ferreira', 'Fitzgerald', 'Gallagher',
  'Haddad', 'Hawkshaw', 'Ibrahim', 'Ivanova', 'Jensen', 'Kowalski', 'Kimura', 'Laurent', 'Lindqvist',
  'Marshall', 'Mbeki', 'Mukherji', 'Nakamura', 'Novak', 'Okafor', 'Osei', 'Petrov', 'Raghunathan',
  'Rahman', 'Ramirez', 'Rossi', 'Santos', 'Schmidt', 'Sikalo', 'Silva', 'Sorensen', 'Tanaka',
  'Vogt', 'Whitfield', 'Yilmaz', 'Youssef', 'Zhang', 'Ziegler', 'Novotny', 'Karlsson', 'Moreau',
]

interface Person {
  id: string
  email: string
  name: string
  /**
   * The dimension STAMPED ON SPEND ROWS. `null` for the unplaced cohort — that
   * is what "we never resolved a placement at ingest" looks like in the ledger,
   * and it is the column every region rollup groups on.
   */
  regionId: string | null
  /** `teammate.region_id` is NOT NULL, so the directory always names one, even
   *  for someone whose spend is unresolved. Never used as a reporting dimension. */
  homeRegionId: string
  orgUnitId: string
  couId: string | null
  /** NULL dimensions on every spend row — the "Unassigned"/unplaced cohort. */
  unplaced: boolean
  rank: number
  /** Share of the company's daily spend, normalised over the population. */
  share: number
  activeP: number
  emitter: boolean
  /** Personal subscription: real §A work, no `actual_spend` behind it. */
  selfBilled: boolean
  exempt: boolean
  /** Fraction of a day's claude-code money OTel actually saw (emitters only). */
  otelShare: number
  /** Probability an untagged provider-recorded day gets tagged to a project. */
  taggingRate: number
  tierMix: Record<TierKey, number>
  projectIds: string[]
  usesChat: boolean
  usesOffice: boolean
  usesCopilot: boolean
  usesCopilotAgent: boolean
  /** Which Copilot provider org their seat sits in (index into the org list). */
  ghOrg: number
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    process.exit(1)
    return
  }
  assertLocalOnly(url)

  const sql = createDbClient(url, { max: 1, idle_timeout: 10 })
  const db = drizzle(sql, { schema }) as unknown as PostgresJsDatabase<typeof schema>
  const t0 = Date.now()

  // The window. `rangeEnd` runs to the end of the CURRENT month so the wipe
  // catches future-dated rows that still land inside the current report month.
  const today = new Date(`${dayKey(new Date())}T00:00:00.000Z`)
  const rangeStart = addDays(today, -DAYS_BACK)
  const currentMonth = dayKey(today).slice(0, 7)
  const rangeEndExclusive = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
  )
  const days: Date[] = []
  for (let d = new Date(rangeStart); d <= today; d = addDays(d, 1)) days.push(new Date(d))
  const months = [...new Set(days.map((d) => monthKey(dayKey(d))))]

  console.warn(
    `[fixture] window ${dayKey(rangeStart)} → ${dayKey(today)} (${days.length} days, ` +
      `months ${months.join(', ')}); wipe range ends ${dayKey(rangeEndExclusive)}`,
  )

  // ────────────────────────────────────────────────────────────── clean slate
  await wipe(sql, dayKey(rangeStart), dayKey(rangeEndExclusive))

  // ───────────────────────────────────────────────────────────────────── org
  const regions = new Map<string, string>()
  for (const r of await sql<{ id: string; code: string }[]>`SELECT id::text, code FROM region`) {
    regions.set(r.code, r.id)
  }
  for (const code of ['apac', 'emea', 'north-america', 'demo']) {
    if (!regions.has(code)) throw new Error(`region '${code}' missing — run \`npm run db:seed\` first`)
  }
  const regionParents = new Map<string, { id: string; path: string }>()
  for (const r of await sql<{ code: string; id: string; path: string }[]>`
      SELECT rg.code, ou.id::text, ou.path::text AS path
        FROM org_unit ou JOIN region rg ON rg.id = ou.region_id
       WHERE ou.code = 'default' AND ou.parent_id IS NULL`) {
    regionParents.set(r.code, { id: r.id, path: r.path })
  }

  // Cost centres, one org_unit each under its region's default BU. They are
  // cost-owning, so `v_org_unit_cost_owner` resolves a member to the CENTRE
  // rather than to the region root above it (nearest ancestor wins).
  const ccUnits = new Map<string, { id: string; regionId: string; name: string }>()
  const ouRows: unknown[][] = []
  for (const cc of COST_CENTRES) {
    const parent = regionParents.get(cc.regionCode)
    if (!parent) throw new Error(`no default BU for region '${cc.regionCode}'`)
    const id = randomUUID()
    const label = cc.code.replace(/[^a-z0-9]/g, '_')
    ccUnits.set(cc.code, { id, regionId: regions.get(cc.regionCode)!, name: cc.name })
    ouRows.push([
      id, regions.get(cc.regionCode)!, parent.id, `${parent.path}.${label}`,
      cc.code, cc.name, 'practice', true, MARK,
    ])
  }
  /*
   * The holding node is TOP-LEVEL on purpose. `v_org_unit_cost_owner` LEFT JOINs
   * every cost-owning ANCESTOR — parenting this under a region's default BU
   * (which is cost-owning) would home its members to that BU and there would be
   * no NULL bucket anywhere. `unit_type='holding'` also satisfies mig 0110's
   * CHECK that a holding node is never cost-owning.
   */
  const unplacedId = randomUUID()
  ouRows.push([
    unplacedId, regions.get('apac')!, null, 'fx_unplaced',
    'fx-unplaced', 'Unplaced', 'holding', false, MARK,
  ])
  await bulkInsert(
    sql, 'org_unit',
    ['id', 'region_id', 'parent_id', 'path', 'code', 'display_name', 'unit_type', 'is_cost_owning_unit', 'source'],
    ['uuid', 'uuid', 'uuid', 'ltree', 'text', 'text', 'text', 'boolean', 'text'],
    ouRows,
  )

  // The base seed's DEMO practices, so the fixture population reaches them too.
  const demoUnits = await sql<{ id: string; code: string; region_id: string }[]>`
    SELECT ou.id::text, ou.code, ou.region_id::text AS region_id
      FROM org_unit ou JOIN region rg ON rg.id = ou.region_id
     WHERE rg.code = 'demo' AND ou.code IN ('delta', 'echo', 'foxtrot')`
  for (const u of demoUnits) {
    ccUnits.set(`demo-${u.code}`, { id: u.id, regionId: u.region_id, name: `DEMO · ${u.code}` })
  }

  // ─────────────────────────────────────────────────────── provider identities
  const [ghEnterprise] = await sql<{ id: string }[]>`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode,
                                     billing, included_allowance_usd, flat_seat_price_usd)
    VALUES ('github', ${GH_ENTERPRISE_REF}, 'Fixture Enterprise', 'indicative', 'tracked', 20, ${COPILOT_SEAT_USD})
    RETURNING id::text`
  const ghEnterpriseId = ghEnterprise!.id

  /*
   * Five mapped GitHub orgs plus ONE unmapped. The unmapped org is the point:
   * Copilot chargeback homes through the org→cost-centre map, never through
   * Entra placement, so an org nobody has mapped becomes a VISIBLE unallocated
   * row on the Finance table rather than being spread across the mapped ones.
   */
  const GH_ORG_CCS = ['apac-cto', 'apac-aiad', 'na-fieldeng', 'emea-cto', 'na-modernwork', null]
  const ghOrgs: { id: string; ccCode: string | null; couId: string | null; regionId: string | null }[] = []
  for (const [i, ccCode] of GH_ORG_CCS.entries()) {
    const cc = ccCode ? ccUnits.get(ccCode)! : null
    const [row] = await sql<{ id: string }[]>`
      -- api_kind is NULL for every non-Anthropic provider (provider_org_api_kind_chk).
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing,
                                provider_enterprise_id, region_id, cost_owning_unit_id)
      VALUES ('github', ${`fx-org-${i}`}, ${ccCode ? `Fixture · ${ccCode}` : 'Fixture · unmapped org'},
              'indicative', 'tracked', ${ghEnterpriseId}::uuid,
              ${cc?.regionId ?? null}::uuid, ${cc?.id ?? null}::uuid)
      RETURNING id::text`
    ghOrgs.push({ id: row!.id, ccCode, couId: cc?.id ?? null, regionId: cc?.regionId ?? null })
  }

  // ─────────────────────────────────────────────────────────────── population
  const people = buildPopulation(regions, ccUnits, unplacedId)
  const existing = await sql<{ id: string; email: string; display_name: string | null; region_id: string; org_unit_id: string }[]>`
    SELECT id::text, email, display_name, region_id::text AS region_id, org_unit_id::text AS org_unit_id
      FROM teammate WHERE is_active AND source <> ${MARK} ORDER BY email`
  const couOf = await sql<{ org_unit_id: string; cost_owning_unit_id: string | null }[]>`
    SELECT org_unit_id::text, cost_owning_unit_id::text FROM v_org_unit_cost_owner`
  const couByOu = new Map(couOf.map((r) => [r.org_unit_id, r.cost_owning_unit_id]))

  // Existing seed personas join the population at scattered ranks — Priya, Mara
  // and Owen are the personas the parity walk signs in as, so they must carry
  // spend, and they must not all be at the top of the concentration curve.
  const EXISTING_RANKS = [3, 11, 24, 41, 63, 88, 121, 152, 181]
  const merged: Person[] = [...people]
  for (const [i, e] of existing.entries()) {
    merged.push(
      makePerson({
        id: e.id,
        email: e.email,
        name: e.display_name ?? e.email,
        regionId: e.region_id,
        homeRegionId: e.region_id,
        orgUnitId: e.org_unit_id,
        couId: couByOu.get(e.org_unit_id) ?? null,
        unplaced: false,
        rank: EXISTING_RANKS[i] ?? 190 + i,
      }),
    )
  }
  // Re-rank the merged population 1..N so the 1/rank weight is over everyone.
  merged.sort((a, b) => a.rank - b.rank)
  merged.forEach((p, i) => { p.rank = i + 1 })
  /*
   * w_r = 1/(r + 0.15) — very close to a pure 1/rank, whose partial sums are
   * harmonic: H(21)/H(207) ≈ 0.62, H(10)/H(207) ≈ 0.50, H(2)/H(207) ≈ 0.25. The
   * prototype publishes 26% / 48% / 63% for the top 1% / 5% / 10%, so the curve
   * is chosen to land there rather than tuned until it did.
   *
   * The realised split comes out a little flatter, because the Chat, Office and
   * Copilot lanes below are only weakly rank-weighted — casual surfaces really
   * are spread more evenly than Claude Code is. That is left alone: the
   * Concentration card needs the spend to be genuinely unequal, not to hit three
   * decimal places.
   */
  const rawW = merged.map((p) => 1 / (p.rank + 0.15))
  const sumW = rawW.reduce((a, b) => a + b, 0)
  merged.forEach((p, i) => { p.share = rawW[i]! / sumW })

  await writeFixtureTeammates(sql, people)

  // ──────────────────────────────────────────────────────────────── projects
  const projectIds = new Map<string, { id: string; couId: string; regionId: string }>()
  const projRows: unknown[][] = []
  for (const p of PROJECTS) {
    const cc = ccUnits.get(p.cc)
    if (!cc) throw new Error(`project ${p.code} names unknown cost centre ${p.cc}`)
    const id = randomUUID()
    projectIds.set(p.code, { id, couId: cc.id, regionId: cc.regionId })
    projRows.push([
      id, p.code, createHash('sha256').update(p.code).digest('hex'), p.name, p.type,
      cc.regionId, cc.id, true, true, MARK,
    ])
  }
  await bulkInsert(
    sql, 'project',
    ['id', 'code', 'code_hash', 'display_name', 'type', 'region_id', 'cost_owning_unit_id', 'is_authorised', 'is_onboarded', 'source'],
    ['uuid', 'text', 'text', 'text', 'text', 'uuid', 'uuid', 'boolean', 'boolean', 'text'],
    projRows,
  )

  // Everyone's project list comes from their OWN cost centre, so a project's
  // tagged spend and its cost centre's burn are about the same people.
  const projByCc = new Map<string, string[]>()
  for (const p of PROJECTS) {
    const arr = projByCc.get(p.cc) ?? []
    arr.push(projectIds.get(p.code)!.id)
    projByCc.set(p.cc, arr)
  }
  const ccCodeByUnitId = new Map([...ccUnits].map(([code, u]) => [u.id, code]))
  const assignRows: unknown[][] = []
  for (const p of merged) {
    const ccCode = p.couId ? ccCodeByUnitId.get(p.couId) : undefined
    const pool = (ccCode ? projByCc.get(ccCode) : undefined) ?? []
    if (pool.length === 0) continue
    const n = Math.min(pool.length, 1 + Math.floor(rnd() * 2.4))
    const chosen = new Set<string>()
    while (chosen.size < n) chosen.add(pick(pool))
    p.projectIds = [...chosen]
    for (const pid of p.projectIds) {
      assignRows.push([randomUUID(), pid, p.id, `[${dayKey(rangeStart)}T00:00:00+00,)`, 'member', MARK])
    }
  }
  await bulkInsert(
    sql, 'project_assignment',
    ['id', 'project_id', 'teammate_id', 'effective', 'role', 'source'],
    ['uuid', 'uuid', 'uuid', 'tstzrange', 'text', 'text'],
    assignRows,
  )

  // Cost-centre owners, so the Cost centre scope has someone behind each card.
  const ownerRows: unknown[][] = []
  for (const [ccCode, unit] of ccUnits) {
    const member = merged.find((p) => p.couId === unit.id && !p.unplaced)
    if (!member) continue
    if (ccCode.startsWith('demo-')) continue
    ownerRows.push([randomUUID(), unit.id, member.id])
  }
  await bulkInsert(sql, 'cou_owner', ['id', 'org_unit_id', 'teammate_id'], ['uuid', 'uuid', 'uuid'], ownerRows)

  // Report-access grants (mig 0129): roles no longer confer elevated report
  // access on their own, so the fixture's finance/across surfaces need real
  // grant rows or the visual walk opens on a baseline 403. NEW fixture
  // teammates (writeFixtureTeammates, below) are always plain 'developer' —
  // this only ever touches EXISTING org-wide-role personas already in the base
  // seed (Mara/global-finops today; a platform-admin demo row if one is ever
  // added). ON CONFLICT against the partial active-grant index keeps this
  // re-runnable, the same discipline the rate-card/governance-setting
  // re-inserts above use for rows this script does not own the deletion of.
  const orgWideExisting = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM teammate
    WHERE role IN ('global-finops', 'platform-admin') AND source <> ${MARK}`
  for (const person of orgWideExisting) {
    for (const permission of ['operational', 'finance'] as const) {
      await sql`
        INSERT INTO report_access_grant (teammate_id, permission, granted_by)
        VALUES (${person.id}::uuid, ${permission}, NULL)
        ON CONFLICT (teammate_id, permission) WHERE revoked_at IS NULL DO NOTHING`
    }
  }

  // ────────────────────────────────────────────────────────────────── spend
  const gen = generateSpend(merged, days, projectIds, ghOrgs, ghEnterpriseId)
  console.warn(
    `[fixture] generated: ${gen.attribution.length} attribution, ${gen.unaccounted.length} unaccounted, ` +
      `${gen.actualSpend.length} actual_spend, ${gen.recon.length} reconciliation`,
  )

  await bulkInsert(
    sql, 'instance_attestation',
    ['instance_id', 'principal_oid', 'principal_email', 'teammate_id', 'tool', 'session_token_hash',
     'ts_start', 'region_id', 'org_unit_id', 'cost_owning_unit_id', 'attestation_state', 'identity_state'],
    ['uuid', 'text', 'text', 'uuid', 'text', 'text', 'timestamptz', 'uuid', 'uuid', 'uuid', 'text', 'text'],
    gen.instances,
  )
  await bulkInsert(
    sql, 'attribution_record',
    ['id', 'instance_id', 'teammate_id', 'project_id', 'region_id', 'org_unit_id', 'cost_owning_unit_id',
     'tool', 'model', 'token_type', 'tokens', 'cost_usd', 'fidelity_tier', 'cost_basis', 'ts_event',
     'claude_session_id', 'activity', 'identity_state', 'billing_lane', 'source_run_id'],
    ['uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'uuid', 'text', 'text', 'text', 'bigint', 'numeric',
     'text', 'text', 'timestamptz', 'text', 'text', 'text', 'text', 'text'],
    gen.attribution,
  )
  await bulkInsert(
    sql, 'unaccounted_usage',
    ['id', 'teammate_id', 'region_id', 'org_unit_id', 'day', 'tool', 'cost_usd', 'tokens', 'project_id', 'activity', 'source'],
    ['uuid', 'uuid', 'uuid', 'uuid', 'date', 'text', 'numeric', 'bigint', 'uuid', 'text', 'text'],
    gen.unaccounted,
  )
  await bulkInsert(
    sql, 'actual_spend',
    ['id', 'teammate_id', 'date', 'tool', 'input_tokens', 'output_tokens', 'cost_usd', 'source',
     'raw_payload', 'chargeback_exempt', 'region_id', 'org_unit_id', 'cost_owning_unit_id',
     'dimension_source', 'provider_enterprise_id'],
    ['uuid', 'uuid', 'date', 'text', 'bigint', 'bigint', 'numeric', 'text', 'jsonb', 'boolean',
     'uuid', 'uuid', 'uuid', 'text', 'uuid'],
    gen.actualSpend,
  )
  await bulkInsert(
    sql, 'reconciliation_record',
    ['id', 'teammate_id', 'provider', 'enterprise_ref', 'period_date', 'category', 'scope',
     'region_id', 'org_unit_id', 'cost_owning_unit_id', 'actual_qty', 'actual_unit_type', 'actual_usd',
     'otel_attributed_usd', 'delta_usd', 'spend_class', 'indicative_reason', 'disposition', 'status',
     'raw', 'provider_org_id', 'provider_enterprise_id'],
    ['uuid', 'uuid', 'text', 'text', 'date', 'text', 'text', 'uuid', 'uuid', 'uuid', 'numeric', 'text',
     'numeric', 'numeric', 'numeric', 'text', 'text', 'text', 'text', 'jsonb', 'uuid', 'uuid'],
    gen.recon,
  )

  // ─────────────────────────────────────────────────────────────── budgets
  const allocRows = deriveAllocations(gen, projectIds, ccUnits, months, currentMonth)
  const [audit] = await sql<{ id: string }[]>`
    INSERT INTO audit_event (event_type, actor_system, subject_kind, payload)
    VALUES ('allocation-created', ${MARK}, 'project', ${JSON.stringify({ fixture: MARK })}::jsonb)
    RETURNING id::text`
  await bulkInsert(
    sql, 'allocation',
    ['id', 'scope_type', 'scope_id', 'budget_usd', 'effective', 'allocation_kind', 'audit_event_id', 'source'],
    ['uuid', 'text', 'uuid', 'numeric', 'tstzrange', 'text', 'uuid', 'text'],
    allocRows.map((a) => [
      randomUUID(), 'project', a.projectId, a.budgetUsd.toFixed(2),
      `[${a.month}-01T00:00:00+00,${a.nextMonth}-01T00:00:00+00)`, 'baseline', audit!.id, MARK,
    ]),
  )

  // ──────────────────────────────────────────────── Copilot pooled bill (§B)
  const poolRows = buildCopilotPoolBill(gen, ghOrgs, ghEnterpriseId, months)
  await bulkInsert(
    sql, 'copilot_pool_bill',
    ['id', 'month', 'provider_enterprise_id', 'provider_org_id', 'cost_owning_unit_id', 'seats',
     'license_net_usd', 'included_allowance_usd', 'usage_gross_usd', 'overage_net_usd',
     'unclassified_net_usd', 'raw_payload'],
    ['uuid', 'date', 'uuid', 'uuid', 'uuid', 'integer', 'numeric', 'numeric', 'numeric', 'numeric',
     'numeric', 'jsonb'],
    poolRows,
  )

  // ───────────────────────────── the normalised layer, through the REAL worker
  const startingAt = dayKey(rangeStart)
  const endingAt = dayKey(today)
  for (const source of [ANTHROPIC_SOURCE, GH_SOURCE]) {
    const res = await runProviderTransform(db, { startingAt, endingAt, source })
    console.warn(
      `[fixture] provider-transform ${source}: read ${res.sourceRowsRead}, ` +
        `upserted ${res.factRowsUpserted}, pruned ${res.factRowsPruned}`,
    )
  }

  // ── the model-residual children, through the REAL writer (mig 0123) ────────
  // Scoped to the drift persona ON PURPOSE: the rest of the estate seeds its
  // arm-2 rows directly (with fixture-only shapes like NULL-dimension rows the
  // real writer would restamp), so a whole-estate recompute would rewrite the
  // estate this script just constructed. One persona is enough for S1 — the
  // children are derived by the shipping code path, the drift day exercises
  // the floor + descending cap, and the report() checks below are non-vacuous.
  // Whole-estate children arrive with S2, whose views read them.
  if (gen.drift) {
    const rec = await reconcileUnaccountedUsage(db, {
      startDate: startingAt,
      endDate: endingAt,
      teammateId: gen.drift.teammateId,
    })
    console.warn(
      `[fixture] unaccounted-reconcile (drift persona ${gen.drift.teammateId.slice(0, 8)}): ` +
        `${rec.rowsUpserted} parents recomputed, $${rec.totalUnaccountedUsd.toFixed(2)} unaccounted`,
    )
  }

  await report(sql, dayKey(rangeStart), currentMonth, months, gen.drift)
  console.warn(`[fixture] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await sql.end()
}

// ── clean slate ─────────────────────────────────────────────────────────────

/**
 * Delete the fixture's own structural rows, and EVERY spend row in the owned
 * date range whoever wrote it (see the module header for why the range, not the
 * marker, is the unit of ownership on the spend tables).
 *
 * Order is FK order. `audit_event` is deliberately absent: mig 0001's
 * `audit_event_no_update` trigger blocks DELETE as well as UPDATE, so the one
 * row each run inserts is left behind by design rather than by omission.
 */
async function wipe(sql: Sql, from: string, toExclusive: string): Promise<void> {
  await sql`DELETE FROM provider_usage_fact WHERE source IN (${ANTHROPIC_SOURCE}, ${GH_SOURCE})`
  /*
   * RANGE **OR** ENTITY, on every dated spend table — and both halves are
   * load-bearing.
   *
   * The range is the module header's rule: this fixture owns every spend row in
   * its window whoever wrote it, because the coverage estate writes through the
   * real ingest path and carries no marker.
   *
   * But THE WINDOW SLIDES. `from` is `today - 75`, so a run today owns a window
   * four days to the right of a run four days ago, and that earlier run's rows
   * in the uncovered sliver survive — then block the structural deletes below on
   * an FK. Reproduced 2026-08-10 against an estate last seeded 2026-08-06: 231
   * attribution rows across 05-23…05-26 held `instance_attestation` (via
   * `attribution_record_session_id_fkey`, which keeps its pre-migration name —
   * the column is `instance_id`), and unaccounted rows held `project`.
   *
   * Range-ownership cannot express "whatever an EARLIER me wrote". Entity
   * ownership can: a row hanging off a fixture teammate, project or instance is
   * fixture-owned at ANY date. Neither test subsumes the other, so both run.
   * The instance predicate needs two arms of its own — the fixture mints
   * instances under `principal_oid = MARK`, while the coverage estate mints
   * them FOR fixture teammates through the emit path, carrying the teammate's
   * own oid.
   */
  await sql`DELETE FROM attribution_record
             WHERE (ts_event >= ${from}::date AND ts_event < ${toExclusive}::date)
                OR teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})
                OR project_id IN (SELECT id FROM project WHERE source = ${MARK})
                OR instance_id IN (SELECT instance_id FROM instance_attestation
                                    WHERE principal_oid = ${MARK}
                                       OR teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK}))`
  await sql`DELETE FROM unaccounted_usage
             WHERE (day >= ${from}::date AND day < ${toExclusive}::date)
                OR source = ${MARK}
                OR teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})
                OR project_id IN (SELECT id FROM project WHERE source = ${MARK})`
  /*
   * These three carry the fixture's own MARKER, which is a STRICTLY better
   * ownership test than the teammate/project one above and the reason the check
   * suite caught what the FKs did not: the sliver left behind on 2026-08-10 held
   * 25 `actual_spend` rows for teammates the fixture does NOT own (the base
   * seed's), so no entity predicate reached them — but every one carried
   * `ANTHROPIC_SOURCE`. They survived, `provider_usage_fact` was rebuilt from
   * the read the transform actually made, and conservation came out $506.37
   * apart. A silent $506 is exactly what an unfaithful fixture looks like.
   *
   * `actual_spend` is teammate-grained — no project column to test.
   */
  await sql`DELETE FROM actual_spend
             WHERE (date >= ${from}::date AND date < ${toExclusive}::date)
                OR source = ${ANTHROPIC_SOURCE}
                OR teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})`
  await sql`DELETE FROM reconciliation_record
             WHERE (period_date >= ${from}::date AND period_date < ${toExclusive}::date)
                OR enterprise_ref = ${GH_ENTERPRISE_REF}
                OR teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})
                OR project_id IN (SELECT id FROM project WHERE source = ${MARK})`
  /*
   * MONTH FLOOR, not `from`. `copilot_pool_bill.month` is dated to the 1st, so a
   * range starting mid-month leaves that month's row behind — and the next run
   * then fails on the provider_org FK rather than quietly double-counting, which
   * is how this was found. Every other spend table here is day-grained.
   */
  await sql`DELETE FROM copilot_pool_bill
             WHERE month >= date_trunc('month', ${from}::date)::date AND month < ${toExclusive}::date`
  // The cold aggregates are derived from the ledger this fixture just replaced,
  // so a stale row would be an aggregate of deleted spend. `v_effective_spend`
  // reads them, and the archiving flag is off locally, so they rebuild empty.
  await sql`DELETE FROM spend_session_daily
             WHERE (period_start >= ${from}::date AND period_start < ${toExclusive}::date)
                OR teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})
                OR project_id IN (SELECT id FROM project WHERE source = ${MARK})`
  await sql`DELETE FROM spend_rollup_daily
             WHERE (period_start >= ${from}::date AND period_start < ${toExclusive}::date)
                OR teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})
                OR project_id IN (SELECT id FROM project WHERE source = ${MARK})`

  // Orphaned instances: every attribution row that referenced them is gone.
  await sql`DELETE FROM instance_attestation_health
             WHERE instance_id IN (SELECT instance_id FROM instance_attestation WHERE principal_oid = ${MARK})`
  await sql`DELETE FROM instance_attestation WHERE principal_oid = ${MARK}`

  /*
   * Allocations follow the same RANGE-ownership rule as the spend they qualify,
   * not the marker. The base seed writes a $12,500 current-month budget against
   * a demo project that carries ~$19 of spend; left in place it is 80% of the
   * cost-centre scope's "total allocation" rollup and drags "utilised overall"
   * to a meaningless figure. A budget covering a period whose spend this fixture
   * replaced is not a budget for anything that still exists.
   */
  await sql`DELETE FROM allocation
             WHERE effective && tstzrange(${from}::timestamptz, ${toExclusive}::timestamptz, '[)')`
  await sql`DELETE FROM session_assignment WHERE source = ${MARK}`
  await sql`DELETE FROM project_assignment WHERE source = ${MARK}`
  await sql`DELETE FROM repo_project_map WHERE project_id IN (SELECT id FROM project WHERE source = ${MARK})`
  await sql`DELETE FROM project WHERE source = ${MARK}`
  await sql`DELETE FROM cou_owner WHERE teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})
               OR org_unit_id IN (SELECT id FROM org_unit WHERE source = ${MARK})`
  await sql`DELETE FROM teammate_identity_map WHERE teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})`
  /*
   * Instances attest to a teammate with a plain FK and NO cascade, so any
   * enrolment bound to a fixture teammate blocks the delete outright
   * (`session_attestation_teammate_id_fkey`, hit on the 2026-08-06 reseed).
   *
   * The seed itself mints none — these arrive when something EMITS as a fixture
   * teammate, which the coverage estate's fake-LAW path does. The wipe has to
   * clear them because it owns the teammate row they hang off; scoped through
   * that same `source = MARK` subquery, so a real enrolment is never in range.
   */
  await sql`DELETE FROM instance_attestation
             WHERE teammate_id IN (SELECT id FROM teammate WHERE source = ${MARK})`
  await sql`DELETE FROM teammate WHERE source = ${MARK}`
  // provider_org.cost_owning_unit_id FKs an org_unit with NO cascade, so the
  // provider identities go BEFORE the units they are mapped to.
  await sql`DELETE FROM provider_org WHERE external_org_id LIKE 'fx-org-%' AND provider = 'github'`
  await sql`DELETE FROM provider_enterprise WHERE external_id = ${GH_ENTERPRISE_REF}`
  await sql`DELETE FROM org_unit WHERE source = ${MARK}`
}

// ── population ──────────────────────────────────────────────────────────────

function makePerson(base: {
  id: string
  email: string
  name: string
  regionId: string | null
  homeRegionId: string
  orgUnitId: string
  couId: string | null
  unplaced: boolean
  rank: number
}): Person {
  /*
   * Behaviour is a function of RANK, not random: heavy users are heavy because
   * they work most days on frontier models, which is also why they are heavy.
   * A random assignment would decouple the concentration curve from the model
   * mix and the two cards would tell unrelated stories.
   */
  const heavy = Math.exp(-base.rank / 55)
  /*
   * Money shares, not token shares. Weighted by who actually spends, this lands
   * near the prototype's Behavioural-exposure bands (frontier 67.5% / mid 20% /
   * economy 8.6% of billed spend). The TOKEN shares invert on their own, because
   * tokens are derived from money at each model's real $/Mtok — that inversion
   * is the whole point of the card's two bars and must not be typed in.
   */
  const frontier = 0.3 + 0.38 * heavy + between(-0.05, 0.05)
  const economy = 0.28 - 0.16 * heavy + between(-0.04, 0.04)
  const mid = Math.max(0.05, 1 - frontier - economy)
  return {
    ...base,
    share: 0,
    activeP: Math.min(0.93, 0.22 + 0.68 * heavy),
    emitter: false,
    selfBilled: false,
    exempt: false,
    otelShare: between(0.55, 0.92),
    /*
     * How often a provider-recorded day gets tagged from the worklist. Wide, so
     * the "needs tagging" story has both diligent people and people who have
     * never opened it, and centred high enough that the budget-coverage card
     * lands near the prototype's 58% budgeted rather than on today's real-estate
     * figure (under 5%) — this is a DESIGN fixture, and a card drawn at 5%
     * coverage tells a reviewer nothing about the layout.
     */
    taggingRate: between(0.5, 0.96),
    tierMix: { frontier, mid, economy },
    projectIds: [],
    usesChat: rnd() < 0.4,
    usesOffice: rnd() < 0.1,
    usesCopilot: rnd() < 0.48,
    usesCopilotAgent: rnd() < 0.2,
    ghOrg: Math.floor(rnd() * 6),
  }
}

function buildPopulation(
  regions: ReadonlyMap<string, string>,
  ccUnits: ReadonlyMap<string, { id: string; regionId: string; name: string }>,
  unplacedId: string,
): Person[] {
  const out: Person[] = []
  let n = 0
  const mkName = (): { name: string; slug: string } => {
    const g = pick(GIVEN)
    const f = pick(FAMILY)
    n += 1
    return { name: `${g} ${f}`, slug: `${g}.${f}`.toLowerCase().replace(/[^a-z.]/g, '') + `${n}` }
  }
  const add = (
    orgUnitId: string,
    couId: string | null,
    regionId: string | null,
    homeRegionId: string,
    unplaced: boolean,
    exempt: boolean,
  ): void => {
    const { name, slug } = mkName()
    const id = randomUUID()
    const p = makePerson({
      id,
      email: `fx.${slug}@example.com`,
      name,
      regionId,
      homeRegionId,
      orgUnitId,
      couId,
      unplaced,
      rank: 0,
    })
    p.exempt = exempt
    out.push(p)
  }

  for (const cc of COST_CENTRES) {
    const unit = ccUnits.get(cc.code)!
    for (let i = 0; i < cc.headcount; i += 1) {
      add(unit.id, unit.id, unit.regionId, unit.regionId, false, cc.exempt === true)
    }
  }
  for (const code of ['demo-delta', 'demo-echo', 'demo-foxtrot']) {
    const unit = ccUnits.get(code)
    if (!unit) continue
    for (let i = 0; i < Math.ceil(DEMO_HEADCOUNT / 3); i += 1) {
      add(unit.id, unit.id, unit.regionId, unit.regionId, false, false)
    }
  }
  // The unplaced cohort: `teammate.region_id` is NOT NULL so the directory must
  // name one, but their SPEND rows carry NULL dimensions — which is what "we
  // never resolved a placement at ingest" actually looks like in the data.
  const unplacedHome = regions.get('apac')!
  for (let i = 0; i < UNPLACED_HEADCOUNT; i += 1) add(unplacedId, null, null, unplacedHome, true, false)

  // Rank by a heavy-tailed draw, then let rank drive everything else.
  const scored = out.map((p) => ({ p, s: Math.pow(rnd(), 2.6) }))
  scored.sort((a, b) => b.s - a.s)
  scored.forEach((x, i) => { x.p.rank = i + 1 })

  /*
   * ~32 OTel emitters out of 207 — the prototype's "28 of 207 enrolled". Mostly
   * the heavy end (early adopters are the heavy users) with a scattered tail, so
   * the tagged share is not perfectly rank-ordered.
   *
   * `!p.unplaced` is STRUCTURAL, not a preference: arm 1 (`attribution_record`)
   * and `instance_attestation` both declare `region_id` / `org_unit_id` NOT
   * NULL, so an unplaced person cannot have an OTel row to begin with. Their
   * usage reaches §A through arms 2 and 3, whose dimension columns are nullable
   * — which is precisely why the "Unassigned" bucket is reachable there and
   * nowhere else.
   */
  for (const p of out) {
    p.emitter = !p.unplaced && (p.rank <= 24 || (p.rank <= 130 && p.rank % 13 === 0))
  }
  // Personal subscriptions: real work on the §A lane with no invoice behind it.
  for (const p of out) p.selfBilled = p.rank % 14 === 5 && p.rank > 20
  return out
}

async function writeFixtureTeammates(sql: Sql, people: Person[]): Promise<void> {
  await bulkInsert(
    sql, 'teammate',
    ['id', 'entra_oid', 'email', 'display_name', 'region_id', 'org_unit_id', 'role', 'is_active', 'source', 'joined_at'],
    ['uuid', 'text', 'text', 'text', 'uuid', 'uuid', 'text', 'boolean', 'text', 'timestamptz'],
    people.map((p) => [
      p.id, `fixture-oid-${p.id}`, p.email, p.name,
      // The DIRECTORY region, which is never null. The unplaced cohort's NULLs
      // live on the SPEND rows — the dimension reporting actually groups on.
      p.homeRegionId,
      p.orgUnitId, 'developer', true, MARK, new Date(Date.now() - 400 * 86400_000).toISOString(),
    ]),
  )
}

// ── spend generation ────────────────────────────────────────────────────────

interface Generated {
  instances: unknown[][]
  attribution: unknown[][]
  unaccounted: unknown[][]
  actualSpend: unknown[][]
  recon: unknown[][]
  /** project → month → attributed §A spend carrying that project's tag. */
  projectMonth: Map<string, Map<string, number>>
  /** cost centre unit id → month → burn AS THE COST-CENTRE CARD MEASURES IT
   *  (`v_complete_usage.cost_owning_unit_id`, so arm 2 is structurally absent). */
  ccMonth: Map<string, Map<string, number>>
  /** GitHub org index → month → gross AI-credit consumption, USD. */
  ghOrgMonth: Map<number, Map<string, number>>
  /** GitHub org index → seats (distinct Copilot users). */
  ghOrgSeats: Map<number, Set<string>>
  /** The handcrafted DRIFT_SPLIT day: whose claude-code lane seeds otel_m > api_m
   *  for one model. `main` runs the REAL reconciliation writer for exactly this
   *  teammate, so `unaccounted_usage_model` children are derived, not faked. */
  drift: { teammateId: string; day: string } | null
}

function generateSpend(
  people: Person[],
  days: Date[],
  projectIds: Map<string, { id: string; couId: string; regionId: string }>,
  ghOrgs: { id: string; couId: string | null; regionId: string | null }[],
  ghEnterpriseId: string,
): Generated {
  const g: Generated = {
    instances: [], attribution: [], unaccounted: [], actualSpend: [], recon: [],
    projectMonth: new Map(), ccMonth: new Map(), ghOrgMonth: new Map(), ghOrgSeats: new Map(),
    drift: null,
  }
  /*
   * project id -> its cost-owning unit. THE §A HOMING RULE, and the reason this
   * map exists at all: `cost_owning_unit_id` is the cost centre of the PROJECT a
   * row was tagged to, never the spender's own centre. Both production writers
   * derive it that way and leave it NULL when there is no project
   * (complete-spend.ts:201-205), so an untagged row that still homes somewhere is
   * a row production cannot write — and a fixture full of them hides every
   * defect that only appears when usage is untagged.
   */
  const projectCouOf = new Map<string, string>()
  for (const { id, couId } of projectIds.values()) projectCouOf.set(id, couId)

  // The drift persona: deterministic — the heaviest placed, provider-billed
  // emitter (people is rank-sorted). Placed + provider-billed matters: the real
  // writer restamps region/org dims from the teammate row and orphans keys with
  // no API backing, so this choice leaves the rest of the estate untouched.
  const driftPersona = people.find((p) => p.emitter && !p.selfBilled && !p.unplaced && p.couId !== null) ?? null
  const driftDayIso = days.length >= 9 ? dayKey(days[days.length - 8]!) : null
  if (driftPersona && driftDayIso) g.drift = { teammateId: driftPersona.id, day: driftDayIso }

  // One enrolment per emitter — an instance is a DEVICE, not a session, so it is
  // long-lived and every day's records hang off the same one.
  const instanceOf = new Map<string, string>()
  for (const p of people) {
    if (!p.emitter) continue
    const iid = randomUUID()
    instanceOf.set(p.id, iid)
    g.instances.push([
      iid, MARK, p.email, p.id, 'claude-code', `fx-${iid}`,
      days[0]!.toISOString(), p.regionId, p.orgUnitId, p.couId, 'unassigned', 'confirmed',
    ])
  }

  const bump = (m: Map<string, Map<string, number>>, k: string, mk: string, v: number): void => {
    const inner = m.get(k) ?? new Map<string, number>()
    inner.set(mk, (inner.get(mk) ?? 0) + v)
    m.set(k, inner)
  }
  const bumpNum = (m: Map<number, Map<string, number>>, k: number, mk: string, v: number): void => {
    const inner = m.get(k) ?? new Map<string, number>()
    inner.set(mk, (inner.get(mk) ?? 0) + v)
    m.set(k, inner)
  }

  for (const [di, day] of days.entries()) {
    const iso = dayKey(day)
    const mk = monthKey(iso)
    const ramp = RAMP_START + (RAMP_END - RAMP_START) * (di / Math.max(1, days.length - 1))
    const wd = WEEKDAY_FACTOR[day.getUTCDay()]!
    const companyDay = DAILY_TARGET_USD * ramp * wd

    for (const p of people) {
      // ── the drift day replaces this persona's whole day with DRIFT_SPLIT ──
      // Handcrafted operands, no randomness: the claude-code lanes carry
      // exactly the API/OTel per-model figures the header constant documents,
      // so the writer's floor + cap outcome is byte-predictable and the
      // report() self-check can assert it.
      if (g.drift && p.id === g.drift.teammateId && iso === g.drift.day) {
        const iid = instanceOf.get(p.id)!
        const session = randomUUID()
        for (const d of DRIFT_SPLIT) {
          const spec = MODELS.find((m) => m.name === d.model)!
          g.attribution.push([
            randomUUID(), iid, p.id, null,
            // SCHEMA-FAITHFUL: project_id is NULL here, so cost_owning_unit_id
            // MUST be NULL too. `cost_owning_unit_id` on the §A lane means "the
            // cost centre of the PROJECT this was tagged to" — both writers
            // derive it from the project and leave it NULL when there is none
            // (complete-spend.ts:201-205). Homing it on the PERSON, as this
            // fixture did, produces a row production cannot write, and makes the
            // empty cost-centre page structurally unreachable locally.
            p.regionId, p.orgUnitId, null,
            'claude-code', d.model, 'output',
            Math.max(1, Math.round((d.otelUsd / spec.usdPerMtok) * 1_000_000)),
            d.otelUsd.toFixed(6),
            'tier-1', 'measured', `${iso}T10:12:00.000Z`,
            session, 'research', 'confirmed', 'provider-billed', MARK,
          ])
        }
        g.actualSpend.push(anthropicSpendRow(
          p, iso, 'claude-code', 'claude_code',
          new Map(DRIFT_SPLIT.map((d) => [d.model, d.apiUsd] as [string, number])),
          p.regionId, p.orgUnitId, p.couId,
        ))
        const apiUsd = DRIFT_SPLIT.reduce((a, d) => a + d.apiUsd, 0)
        const otelUsd = DRIFT_SPLIT.reduce((a, d) => a + d.otelUsd, 0)
        // The parent fill row, seeded at the value the writer will recompute
        // (API 28 − OTel 10 = 18; tokens from the same per-model rates both
        // lanes use). Untagged, so the drift day rides the normal worklist.
        const tok = (usd: number, rate: number): number => Math.max(1, Math.round((usd / rate) * 1_000_000))
        const gapTokens = DRIFT_SPLIT.reduce((a, d) => {
          const rate = MODELS.find((m) => m.name === d.model)!.usdPerMtok
          return a + tok(d.apiUsd, rate) - tok(d.otelUsd, rate)
        }, 0)
        g.unaccounted.push([
          randomUUID(), p.id, p.regionId, p.orgUnitId, iso, 'claude-code',
          (apiUsd - otelUsd).toFixed(6), Math.max(0, gapTokens), null, null, MARK,
        ])
        /*
         * NO ccMonth bump. These rows are written with cost_owning_unit_id
         * NULL — they carry no project, so they reach no cost centre. Bumping
         * the PERSON's centre here would size that centre's budgets against
         * burn it never receives.
         */
        continue
      }

      // Everyone's activity is gated on the same weekday shape, so the cycle is
      // in the HEADCOUNT as well as the amounts — which is what makes the
      // "active developers" line seasonal too.
      if (rnd() > p.activeP * (0.35 + 0.65 * wd)) continue

      // Expected daily ÷ activity probability, so thinning the days does not
      // thin the totals: the person's share of the company day is preserved.
      const codeUsd = round2(
        (companyDay * p.share) / Math.max(0.05, p.activeP) * between(0.55, 1.65),
      )
      if (codeUsd < 0.5) continue

      // ── the model split. Money first, tokens derived at the model's own rate.
      const split = splitByTier(codeUsd, p.tierMix)
      const rid = p.unplaced ? null : p.regionId
      const oid = p.unplaced ? null : p.orgUnitId
      const cid = p.unplaced ? null : p.couId

      // ── §A arm 1: what OTel saw (emitters only) ──────────────────────────
      let otelUsd = 0
      if (p.emitter) {
        otelUsd = round2(codeUsd * p.otelShare)
        const iid = instanceOf.get(p.id)!
        const session = randomUUID()
        const tagged = p.projectIds.length > 0 && rnd() < 0.86
        const projectId = tagged ? pick(p.projectIds) : null
        const otelSplit = splitByTier(otelUsd, p.tierMix)
        for (const [model, usd] of otelSplit) {
          if (usd < 0.01) continue
          const spec = MODELS.find((m) => m.name === model)!
          g.attribution.push([
            randomUUID(), iid, p.id, projectId,
            // arm 1's dims are NOT NULL in the schema; the unplaced cohort has
            // no OTel at all (see `buildPopulation`), so this is always real.
            // cost_owning_unit_id follows the PROJECT (never the person), and is
            // NULL when the row carries no project — the writers' rule, so the
            // fixture can only contain rows production could have written.
            p.regionId, p.orgUnitId, projectId ? (projectCouOf.get(projectId) ?? null) : null,
            'claude-code', model, 'output',
            Math.max(1, Math.round((usd / spec.usdPerMtok) * 1_000_000)),
            usd.toFixed(6),
            'tier-1', 'measured', `${iso}T${String(9 + (di % 8)).padStart(2, '0')}:12:00.000Z`,
            session, projectId ? null : pick(['research', 'documentation', 'refactor']),
            'confirmed', p.selfBilled ? 'self-billed' : 'provider-billed', MARK,
          ])
          if (projectId) bump(g.projectMonth, projectId, mk, usd)
        }
        /*
         * ccMonth follows the SAME key these rows were WRITTEN with — the
         * PROJECT's cost centre, and nothing when the day is untagged.
         *
         * `deriveAllocations` sizes every centre's budgets from this map, while
         * the product (and the fixture's own RAG self-check) aggregate
         * `v_complete_usage.cost_owning_unit_id`. Bumping the PERSON's centre
         * here left the two on different bases the moment the write basis moved
         * to the project: budgets were derived from burn a centre no longer
         * receives, so the intended `ccTarget` ratios could not be hit and NO
         * centre reached `over`. The generator's bookkeeping has to key on what
         * it writes, or the plan it derives is a plan for different data.
         */
        const arm1Cou = projectId ? (projectCouOf.get(projectId) ?? null) : null
        if (arm1Cou) bump(g.ccMonth, arm1Cou, mk, otelUsd)
      }

      // ── §A arm 2: the API−OTel gap, one row, one tagging decision ────────
      const gapUsd = round2(codeUsd - otelUsd)
      if (gapUsd > 0.01) {
        const tagged = p.projectIds.length > 0 && rnd() < p.taggingRate
        const projectId = tagged ? pick(p.projectIds) : null
        const gapTokens = [...splitByTier(gapUsd, p.tierMix)].reduce(
          (a, [model, usd]) => a + (usd / MODELS.find((m) => m.name === model)!.usdPerMtok) * 1_000_000,
          0,
        )
        g.unaccounted.push([
          randomUUID(), p.id, rid, oid, iso, 'claude-code', gapUsd.toFixed(6),
          Math.round(gapTokens), projectId, null, MARK,
        ])
        if (projectId) bump(g.projectMonth, projectId, mk, gapUsd)
      }

      // ── §B: the Anthropic bill for the same day ──────────────────────────
      // Self-billed people are ABSENT here: personal subscription, no invoice.
      if (!p.selfBilled) {
        g.actualSpend.push(
          anthropicSpendRow(p, iso, 'claude-code', 'claude_code', split, rid, oid, cid),
        )
      }

      // ── §A arm 3 + §B: the ingest-only Claude surfaces ───────────────────
      // The 2026-08-02 wire capture (docs/design/provider-wire-captures/
      // 2026-08-02-provider-wire-shape.json) proves the cost report carries
      // `model` on EVERY row — 255/255, on every product including
      // `product: 'chat'` — and the usage report likewise (85/85). So these
      // lanes seed WITH a model, exactly like claude-code: the earlier
      // `model: null` shape was the fixture's invention, not the wire's. They
      // remain untaggable by construction (mig 0101) — a model dimension does
      // not make an ingest-only lane a worklist item.
      if (p.usesChat && rnd() < 0.55) {
        const chatUsd = round2(codeUsd * between(0.08, 0.42) + between(0.4, 3))
        g.actualSpend.push(
          anthropicSpendRow(p, iso, 'claude-ai', 'chat', new Map([[pick(MODELS).name, chatUsd]]), rid, oid, cid),
        )
        if (p.couId) bump(g.ccMonth, p.couId, mk, chatUsd)
      }
      if (p.usesOffice && rnd() < 0.3) {
        const offUsd = round2(between(0.3, 4.5))
        g.actualSpend.push(
          anthropicSpendRow(p, iso, 'claude-office', 'office_agent', new Map([[pick(MODELS).name, offUsd]]), rid, oid, cid),
        )
        if (p.couId) bump(g.ccMonth, p.couId, mk, offUsd)
      }

      // ── Copilot ───────────────────────────────────────────────────────────
      if (p.usesCopilot && rnd() < 0.62) {
        const credits = Math.round(between(4, 120) * (0.4 + 1.6 * Math.exp(-p.rank / 70)))
        const usd = round2(credits * AIC_USD_RATE)
        if (usd > 0.02) {
          const org = ghOrgs[p.ghOrg]!
          const seats = g.ghOrgSeats.get(p.ghOrg) ?? new Set<string>()
          seats.add(p.id)
          g.ghOrgSeats.set(p.ghOrg, seats)
          bumpNum(g.ghOrgMonth, p.ghOrg, mk, usd)

          // The §B ledger row, plus the model + CLI-token dimensions the
          // App-mode NDJSON record carries. The transform reads exactly this.
          const otelCli = p.emitter ? round2(usd * between(0.3, 0.7)) : 0
          g.recon.push([
            randomUUID(), p.id, 'github', GH_ENTERPRISE_REF, iso, 'copilot_interactive', 'teammate',
            rid, oid, cid, credits, 'ai-credits', usd.toFixed(6), otelCli.toFixed(6),
            (usd - otelCli).toFixed(6), 'indicative', 'copilot-pre-billing', 'untagged', 'applied',
            JSON.stringify(copilotRecord(p, iso, credits)), org.id, ghEnterpriseId,
          ])
          // §A: Copilot CLI is NOT in the ingest-only set, so its usage lane is
          // the reconciliation gap — exactly as it is for claude-code.
          const gap = round2(usd - otelCli)
          if (gap > 0.01) {
            g.unaccounted.push([
              randomUUID(), p.id, rid, oid, iso, 'copilot-cli', gap.toFixed(6), 0,
              p.projectIds.length > 0 && rnd() < p.taggingRate * 0.6 ? pick(p.projectIds) : null,
              null, MARK,
            ])
          }
        }
      }
      if (p.usesCopilotAgent && rnd() < 0.35) {
        const credits = Math.round(between(3, 60))
        const usd = round2(credits * AIC_USD_RATE)
        if (usd > 0.02) {
          const org = ghOrgs[p.ghOrg]!
          bumpNum(g.ghOrgMonth, p.ghOrg, mk, usd)
          g.recon.push([
            randomUUID(), p.id, 'github', GH_ENTERPRISE_REF, iso, 'copilot_coding_agent', 'teammate',
            rid, oid, cid, credits, 'ai-credits', usd.toFixed(6), '0', usd.toFixed(6),
            'indicative', 'copilot-pre-billing', 'ingest_only', 'applied',
            JSON.stringify(copilotRecord(p, iso, credits)), org.id, ghEnterpriseId,
          ])
          // arm 3: copilot-agent IS ingest-only, so it reaches §A through
          // v_teammate_usage_daily and can never be tagged.
          if (p.couId) bump(g.ccMonth, p.couId, mk, usd)
        }
      }
    }
  }
  return g
}

/** Money split across models by the person's tier mix. Deterministic per call. */
function splitByTier(usd: number, mix: Record<TierKey, number>): Map<string, number> {
  const total = mix.frontier + mix.mid + mix.economy
  const out = new Map<string, number>()
  const put = (model: string, v: number): void => {
    if (v < 0.005) return
    out.set(model, round2((out.get(model) ?? 0) + v))
  }
  // One frontier and one economy/mid model per day: a developer does not spread
  // a day's work across five models, and every extra model is another row
  // through the transform's per-row upsert.
  put(pick(FRONTIER).name, (usd * mix.frontier) / total)
  put(pick(MID).name, (usd * mix.mid) / total)
  put(pick(ECONOMY).name, (usd * mix.economy) / total)
  return out
}

/**
 * One `actual_spend` row carrying the provider's OWN payload shape, so
 * `runProviderTransform` can derive the normalised layer from it.
 *
 * `{day, usage[], cost[]}` is verbatim what `analytics-poller.ts:591` writes.
 * `amount` is a CENTS string (`centsStringToUsd`), and the cost rows sum to
 * `cost_usd` — that equality IS the conservation the Anthropic arm claims, so a
 * fixture that broke it would make the worker's own invariant untestable here.
 */
function anthropicSpendRow(
  p: Person,
  iso: string,
  tool: string,
  product: string,
  split: Map<string, number>,
  regionId: string | null,
  orgUnitId: string | null,
  couId: string | null,
): unknown[] {
  const usage: unknown[] = []
  const cost: unknown[] = []
  let inTok = 0
  let outTok = 0
  let totalUsd = 0
  for (const [model, usd] of split) {
    totalUsd += usd
    /*
     * THE CONTEXT-WINDOW BAND RIDES BOTH REPORTS, because the poller asks both
     * for it: `usageGroupBy = ['product','model','context_window']` and
     * `costGroupBy = [...,'context_window']` (analytics-poller.ts:492-493, the
     * canon's "add it to both reports or neither" — W0a D3).
     *
     * Seeding NULL here was the fixture asserting a stale premise — that the
     * dimension "is not in the current group_by, so production has never
     * received one". It IS in group_by. The consequence was that the context
     * card read 100% unbanded on EVERY persona, and the walk reported it as a
     * defect five times over: a product bug manufactured entirely by the seed.
     *
     * The band is the PROVIDER's vocabulary ('0-200k' / '200k+' today, theirs
     * to extend) and the transform takes it verbatim (provider-transform.ts:
     * 289-299), so the string is written exactly as the wire spells it.
     *
     * Long-context work skews to the frontier tier, which is why the split is
     * conditioned on the model rather than flat: an economy model answering a
     * 200k+ prompt is the rare shape, not the median one. `rnd()` is the
     * module's seeded generator, so the estate is reproducible.
     */
    const frontier = MODELS.find((m) => m.name === model)?.tier === 'frontier'
    const contextWindow = rnd() < (frontier ? 0.34 : 0.09) ? '200k+' : '0-200k'
    cost.push({
      product,
      model,
      context_window: contextWindow,
      actor: { email: p.email, deleted: false },
      amount: Math.round(usd * 100).toString(),
      cost_type: 'tokens',
      currency: 'USD',
    })
    // Every product's rows carry a model AND a usage (token) row — the
    // 2026-08-02 wire capture observed both reports' `model` at 100% across
    // every product seen (chat | claude_code | research). The old
    // `model: null` chat/office shape is retired with it.
    const spec = MODELS.find((m) => m.name === model)!
    const tok = Math.max(1, Math.round((usd / spec.usdPerMtok) * 1_000_000))
    const out = Math.round(tok * 0.34)
    const uncached = tok - out
    inTok += uncached
    outTok += out
    usage.push({
      product,
      model,
      // The SAME band as the cost row above: one grain member, not two. A usage
      // row banded differently from its cost row would split the fact grain and
      // make the join the canon warns about strictly harder.
      context_window: contextWindow,
      actor: { email: p.email, deleted: false },
      uncached_input_tokens: uncached,
      output_tokens: out,
      cache_read_input_tokens: Math.round(tok * 1.9),
      cache_creation: {
        ephemeral_5m_input_tokens: Math.round(tok * 0.22),
        ephemeral_1h_input_tokens: Math.round(tok * 0.04),
      },
      requests: Math.max(1, Math.round(tok / 24_000)),
    })
  }
  return [
    randomUUID(), p.id, iso, tool, inTok, outTok, totalUsd.toFixed(6), ANTHROPIC_SOURCE,
    JSON.stringify({ day: iso, usage, cost }), p.exempt, regionId, orgUnitId, couId,
    'ingest-snapshot', null,
  ]
}

/** The App-mode NDJSON record the GitHub arm reads out of `reconciliation_record.raw`. */
function copilotRecord(p: Person, iso: string, credits: number): unknown {
  const models = COPILOT_MODELS.filter(() => rnd() < 0.55)
  if (models.length === 0) models.push(COPILOT_MODELS[0]!)
  return {
    login: `fx-${p.email.split('@')[0]}`,
    periodDate: iso,
    credits,
    record: {
      ai_credits_used: credits,
      totals_by_model_feature: models.map((m) => ({
        model: m,
        feature: 'chat',
        user_initiated_interaction_count: Math.max(1, Math.round(credits * between(0.3, 1.4))),
      })),
      ...(rnd() < 0.24
        ? {
            totals_by_cli: {
              token_usage: {
                prompt_tokens_sum: Math.round(credits * between(900, 4200)),
                output_tokens_sum: Math.round(credits * between(120, 700)),
              },
            },
          }
        : {}),
    },
  }
}

// ── budgets ─────────────────────────────────────────────────────────────────

/**
 * Allocations DERIVED from the burn that was actually generated.
 *
 * The budget is a PLAN figure, so deriving it from measured burn and a chosen
 * utilisation is legitimate — no money figure here comes from a ratio, and no
 * spend row was scaled to reach a target. What it buys is that both
 * against-budget surfaces show all their states on real data:
 *
 *   - the COST-CENTRE card renders `burn(window) / Σ allocation(now())`, where
 *     burn is `v_complete_usage.cost_owning_unit_id` — so arm 2 is structurally
 *     absent from it. `k` normalises each centre's project allocations so the
 *     card lands exactly on `ccTarget`.
 *   - the PROJECT column renders `project usd / that project's budget`, over the
 *     tagged §A spend, which is a DIFFERENT population. After `k` those ratios
 *     are `projTarget / k` — the spread survives any positive scale, so both
 *     surfaces show under / near / over without either one being fudged.
 *
 * One allocation per (project, month), effective for exactly that month, so the
 * current month's row satisfies `effective @> now()` (what the cost-centre cards
 * read) and every month's row overlaps its own window (what budget coverage
 * reads).
 */
function deriveAllocations(
  gen: Generated,
  projectIds: Map<string, { id: string; couId: string; regionId: string }>,
  ccUnits: Map<string, { id: string; regionId: string; name: string }>,
  months: string[],
  currentMonth: string,
): { projectId: string; month: string; nextMonth: string; budgetUsd: number }[] {
  const nextMonthOf = (mk: string): string => {
    const [y, m] = mk.split('-').map(Number) as [number, number]
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }
  const out: { projectId: string; month: string; nextMonth: string; budgetUsd: number }[] = []
  const budgeted = new Set<string>()

  for (const cc of COST_CENTRES) {
    if (cc.ccTarget === null) continue // "No budget set" — the fourth RAG state.
    const unit = ccUnits.get(cc.code)!
    const specs = PROJECTS.filter((p) => p.cc === cc.code && p.projTarget !== null)
    if (specs.length === 0) continue

    // `k` is fixed on the CURRENT month and applied to every month, so switching
    // months moves the burn, not the plan's shape.
    const rawNow = specs.reduce((a, s) => {
      const pid = projectIds.get(s.code)!.id
      const burn = gen.projectMonth.get(pid)?.get(currentMonth) ?? 0
      return a + burn / s.projTarget!
    }, 0)
    const ccBurnNow = gen.ccMonth.get(unit.id)?.get(currentMonth) ?? 0
    const wantNow = ccBurnNow / cc.ccTarget
    const k = rawNow > 0 && wantNow > 0 ? wantNow / rawNow : 1

    for (const mk of months) {
      for (const s of specs) {
        const pid = projectIds.get(s.code)!.id
        const burn = gen.projectMonth.get(pid)?.get(mk) ?? 0
        const budget = (burn / s.projTarget!) * k
        // A $0 allocation is NOT a budget (`usage-coverage.ts`), so a project
        // with no burn in a month gets a floor rather than a zero — otherwise
        // its spend would move into the tagged-no-budget bucket for that month
        // and the coverage story would flicker month to month.
        out.push({ projectId: pid, month: mk, nextMonth: nextMonthOf(mk), budgetUsd: Math.max(50, round2(budget)) })
        budgeted.add(s.code)
      }
    }
  }

  /*
   * Projects whose cost centre is DISCOVERED rather than DECLARED. The DEMO
   * units are read out of the database (see `ccUnits`), so they never appear in
   * COST_CENTRES — and the loop above iterates COST_CENTRES. `FX-MGA` declares
   * `projTarget: 0.9`, i.e. it is SPECIFIED to carry a budget, and got none: the
   * one project that asks for a budget was the one the loop structurally could
   * not reach.
   *
   * It is also the only spend-bearing project of the demo DEVELOPER persona, so
   * the first page a reviewer signs in to rendered "Budgeted · 0 budgets ·
   * $0.00" while carrying the whole month's money in a sub-line. The other five
   * unbudgeted projects declare `projTarget: null` and are meant to be exactly
   * that — the "no budget set" state has to come from somewhere.
   *
   * No `k` scaling here: `k` exists only to make a DECLARED `ccTarget` come out
   * right, and these centres declare none. The project's own target IS the plan.
   */
  for (const s of PROJECTS) {
    if (s.projTarget === null || budgeted.has(s.code)) continue
    const ref = projectIds.get(s.code)
    if (!ref) continue
    for (const mk of months) {
      const burn = gen.projectMonth.get(ref.id)?.get(mk) ?? 0
      out.push({
        projectId: ref.id,
        month: mk,
        nextMonth: nextMonthOf(mk),
        budgetUsd: Math.max(50, round2(burn / s.projTarget)),
      })
    }
  }
  return out
}

// ── Copilot pooled bill ─────────────────────────────────────────────────────

/**
 * The pooled §B bill, per (month, GitHub org) — a READ of a bill, in fixture
 * form: `license_net_usd`, `overage_net_usd` and `unclassified_net_usd` are the
 * three net lines the worker reads, and `v_finance_bill_totals_month` sums
 * exactly those three. Nothing is recomputed from `seats × rate` downstream, so
 * Σ chargeback = Σ bill holds by construction.
 *
 * `copilot_overage_allocation` is deliberately left EMPTY: seeding one would
 * switch `v_finance_copilot_pool_chargeback` to its allocation arm for that
 * (enterprise, month) and drop the pool-bill overage, and the fixture would then
 * reconcile only if the allocation happened to sum to the same figure.
 */
function buildCopilotPoolBill(
  gen: Generated,
  ghOrgs: { id: string; couId: string | null; regionId: string | null }[],
  ghEnterpriseId: string,
  months: string[],
): unknown[][] {
  const rows: unknown[][] = []
  for (const mk of months) {
    for (const [i, org] of ghOrgs.entries()) {
      const gross = round2(gen.ghOrgMonth.get(i)?.get(mk) ?? 0)
      const seats = gen.ghOrgSeats.get(i)?.size ?? 0
      if (seats === 0 && gross === 0) continue
      const license = round2(seats * COPILOT_SEAT_USD)
      const included = round2(seats * 20)
      const overage = round2(Math.max(0, gross - included))
      // Lines the reader saw, alerted on and deliberately never charges. Small,
      // present, and never inside a chargeable figure (GITHUB_CHARGEABLE_LANES).
      const unclassified = round2(gross * 0.021)
      rows.push([
        randomUUID(), `${mk}-01`, ghEnterpriseId, org.id, org.couId, seats,
        license.toFixed(2), included.toFixed(2), gross.toFixed(2), overage.toFixed(2),
        unclassified.toFixed(2),
        JSON.stringify({ fixture: true, month: mk, gross_credits_usd: gross }),
      ])
    }
  }
  return rows
}

// ── verification ────────────────────────────────────────────────────────────

/**
 * Prove the fixture reconciles, on the DB, before anybody looks at a screenshot.
 *
 * These are the identities the cards assert on their face. A fixture that
 * satisfies them is one where a mismatch on screen is a product defect; a
 * fixture that does not is one where we would debug the page and find the data.
 */
async function report(
  sql: Sql,
  from: string,
  currentMonth: string,
  months: string[],
  drift: { teammateId: string; day: string } | null,
): Promise<void> {
  const monthStart = `${currentMonth}-01`
  const prevMonth = months[months.length - 2] ?? months[0]!

  const [scale] = await sql<{ people: string; regions: string; ccs: string; projects: string; ar: string; uu: string; as: string; rr: string; puf: string }[]>`
    SELECT (SELECT count(*) FROM teammate WHERE is_active)::text AS people,
           (SELECT count(*) FROM region)::text AS regions,
           (SELECT count(*) FROM org_unit WHERE is_cost_owning_unit AND retired_at IS NULL)::text AS ccs,
           (SELECT count(*) FROM project WHERE retired_at IS NULL)::text AS projects,
           (SELECT count(*) FROM attribution_record)::text AS ar,
           (SELECT count(*) FROM unaccounted_usage)::text AS uu,
           (SELECT count(*) FROM actual_spend)::text AS as,
           (SELECT count(*) FROM reconciliation_record)::text AS rr,
           (SELECT count(*) FROM provider_usage_fact)::text AS puf`
  console.warn(
    `\n[fixture] SCALE  people=${scale!.people} regions=${scale!.regions} cost-centres=${scale!.ccs} ` +
      `projects=${scale!.projects}\n` +
      `                rows  attribution=${scale!.ar} unaccounted=${scale!.uu} actual_spend=${scale!.as} ` +
      `reconciliation=${scale!.rr} provider_usage_fact=${scale!.puf}`,
  )

  const checks: { name: string; ok: boolean; detail: string }[] = []
  const near = (a: number, b: number, eps = 0.02): boolean => Math.abs(a - b) <= eps

  // 1 — budget coverage: the four parts partition the headline.
  for (const [label, start, end] of [
    ['current month', monthStart, `${nextMonth(currentMonth)}-01`],
    ['previous month', `${prevMonth}-01`, `${nextMonth(prevMonth!)}-01`],
  ] as const) {
    const [c] = await sql<{ total: string; b: string; t: string; u: string; x: string }[]>`
      WITH bp AS (
        SELECT DISTINCT al.scope_id AS project_id FROM allocation al
         WHERE al.scope_type = 'project' AND al.allocation_kind IN ('baseline','top-up')
           AND al.budget_usd > 0
           AND al.effective && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)'))
      SELECT COALESCE(SUM(u.cost_usd),0)::text AS total,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.project_id IS NOT NULL AND bp.project_id IS NOT NULL),0)::text AS b,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.project_id IS NOT NULL AND bp.project_id IS NULL),0)::text AS t,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.project_id IS NULL AND u.usage_provenance <> 'provider-usage'),0)::text AS u,
             COALESCE(SUM(u.cost_usd) FILTER (WHERE u.project_id IS NULL AND u.usage_provenance = 'provider-usage'),0)::text AS x
        FROM v_complete_usage u LEFT JOIN bp ON bp.project_id = u.project_id
       WHERE u.ts_event >= ${start}::timestamptz AND u.ts_event < ${end}::timestamptz`
    const total = Number(c!.total)
    const parts = Number(c!.b) + Number(c!.t) + Number(c!.u) + Number(c!.x)
    const pc = (v: string): string => (total > 0 ? `${((Number(v) / total) * 100).toFixed(1)}%` : 'n/a')
    checks.push({
      name: `coverage segments foot (${label})`,
      ok: near(total, parts) && total > 0,
      detail: `total $${total.toFixed(2)} · budgeted ${pc(c!.b)} · tagged-no-budget ${pc(c!.t)} · ` +
        `untagged ${pc(c!.u)} · untaggable ${pc(c!.x)}`,
    })
  }

  // 2 — region rows sum back to the attributed headline.
  const [reg] = await sql<{ total: string; rows: string; n: string }[]>`
    SELECT COALESCE(SUM(cost_usd),0)::text AS total,
           (SELECT COALESCE(SUM(s),0)::text FROM (
              SELECT SUM(cost_usd) AS s FROM v_complete_usage
               WHERE ts_event >= ${monthStart}::timestamptz GROUP BY region_id) q) AS rows,
           (SELECT count(DISTINCT COALESCE(region_id::text,'null'))::text FROM v_complete_usage
             WHERE ts_event >= ${monthStart}::timestamptz) AS n
      FROM v_complete_usage WHERE ts_event >= ${monthStart}::timestamptz`
  checks.push({
    name: 'region rows sum to attributed usage',
    ok: near(Number(reg!.total), Number(reg!.rows)),
    detail: `$${Number(reg!.total).toFixed(2)} across ${reg!.n} region buckets (incl. NULL = Unassigned)`,
  })

  // 3 — Σ chargeback = Σ bill, the identity the Finance hero renders red on.
  for (const mk of months) {
    const [f] = await sql<{ cb: string; bill: string }[]>`
      SELECT (SELECT COALESCE(SUM(charge_usd),0) FROM v_finance_chargeback_month
               WHERE period_month = ${`${mk}-01`}::date)::text AS cb,
             (SELECT COALESCE(SUM(bill_usd),0) FROM v_finance_bill_totals_month
               WHERE period_month = ${`${mk}-01`}::date)::text AS bill`
    checks.push({
      name: `Σ chargeback = Σ bill (${mk})`,
      ok: near(Number(f!.cb), Number(f!.bill), 0.05),
      detail: `chargeback $${Number(f!.cb).toFixed(2)} vs bill $${Number(f!.bill).toFixed(2)}`,
    })
  }

  // 4 — the normalised layer conserves against the ledger it derives from.
  const [cons] = await sql<{ fact: string; spend: string }[]>`
    SELECT (SELECT COALESCE(SUM(cost_usd),0) FROM provider_usage_fact
             WHERE provider = 'anthropic' AND source = ${ANTHROPIC_SOURCE})::text AS fact,
           (SELECT COALESCE(SUM(cost_usd),0) FROM actual_spend WHERE source = ${ANTHROPIC_SOURCE})::text AS spend`
  checks.push({
    name: 'provider_usage_fact conserves against actual_spend',
    ok: near(Number(cons!.fact), Number(cons!.spend), 0.05),
    detail: `facts $${Number(cons!.fact).toFixed(2)} vs actual_spend $${Number(cons!.spend).toFixed(2)}`,
  })

  // 5 — the tier bands are non-trivial, and both providers reached the lane.
  const bands = await sql<{ provider: string; models: string; spend: string; tokens: string; reqs: string }[]>`
    SELECT provider, count(DISTINCT model)::text AS models,
           COALESCE(SUM(cost_usd),0)::text AS spend,
           COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0)::text AS tokens,
           COALESCE(SUM(requests),0)::text AS reqs
      FROM provider_usage_fact GROUP BY provider ORDER BY provider`
  checks.push({
    /*
     * ⚠ THIS CHECK IS VACUOUS AND THE DEFECT BEHIND IT IS REAL. Reported by
     * external review 2026-08-07 and CONFIRMED by experiment: it groups EVERY
     * provider_usage_fact row in the database, so base-seed Anthropic and GitHub
     * rows satisfy it whatever this fixture wrote.
     *
     * Adding `WHERE source = ${MARK}` makes it FAIL on a clean database — which
     * is the proof: this fixture does not write both providers' facts under its
     * own marker, and the unscoped check has been hiding that. The scoping is
     * left OUT deliberately, because turning it on makes the seed exit 1 and
     * breaks the loop for everyone until the underlying gap is closed.
     *
     * Fixing it means making the fixture write what the check claims, then
     * scoping the check. Both, in one change — not the scoping alone.
     */
    name: 'provider_usage_fact carries both providers',
    ok: bands.length === 2,
    detail: bands
      .map((b) => `${b.provider}: ${b.models} models, $${Number(b.spend).toFixed(2)}, ${b.tokens} tok, ${b.reqs} req`)
      .join(' | '),
  })

  // 6 — concentration is genuinely skewed.
  const conc = await sql<{ cost: string }[]>`
    SELECT COALESCE(SUM(cost_usd),0)::text AS cost FROM v_complete_usage
     WHERE ts_event >= ${`${prevMonth}-01`}::timestamptz AND ts_event < ${`${nextMonth(prevMonth!)}-01`}::timestamptz
     GROUP BY teammate_id HAVING COALESCE(SUM(cost_usd),0) > 0 ORDER BY SUM(cost_usd) DESC`
  const vals = conc.map((r) => Number(r.cost))
  const tot = vals.reduce((a, b) => a + b, 0)
  const topShare = (p: number): number =>
    vals.slice(0, Math.max(1, Math.round(vals.length * p))).reduce((a, b) => a + b, 0) / tot
  checks.push({
    name: 'concentration is skewed',
    ok: vals.length >= 30 && topShare(0.1) > 0.45,
    detail: `${vals.length} people (${prevMonth}) · top 1% ${(topShare(0.01) * 100).toFixed(0)}% · ` +
      `top 5% ${(topShare(0.05) * 100).toFixed(0)}% · top 10% ${(topShare(0.1) * 100).toFixed(0)}%`,
  })

  // 7 — the cost-centre RAG states.
  const rag = await sql<{ name: string; burn: string; alloc: string }[]>`
    SELECT ou.display_name AS name,
           COALESCE((SELECT SUM(u.cost_usd) FROM v_complete_usage u
                      WHERE u.cost_owning_unit_id = ou.id
                        AND u.ts_event >= ${monthStart}::timestamptz),0)::text AS burn,
           COALESCE((SELECT SUM(a.budget_usd) FROM project p
                       JOIN allocation a ON a.scope_type='project' AND a.scope_id=p.id
                        AND a.allocation_kind IN ('baseline','top-up') AND a.effective @> now()
                      WHERE p.cost_owning_unit_id = ou.id),0)::text AS alloc
      FROM org_unit ou WHERE ou.source = ${MARK} AND ou.is_cost_owning_unit ORDER BY 1`
  // Classified by the SHIPPED function, not by re-typing 0.8 and 1.0 here. If
  // the product moves a threshold this check moves with it, which is the whole
  // value of the check — a fixture asserting its own copy of the bands would
  // keep passing while the card started rendering something else.
  const states = rag.map((r) => {
    const a = Number(r.alloc)
    return costCentreBudgetState(a > 0 ? Number(r.burn) / a : null)
  })
  checks.push({
    name: 'cost-centre RAG spans every state',
    ok: (['over', 'warn', 'ok', 'none'] as const).every((s) => states.includes(s)),
    detail: `${states.filter((s) => s === 'over').length} over · ${states.filter((s) => s === 'warn').length} warn · ` +
      `${states.filter((s) => s === 'ok').length} ok · ${states.filter((s) => s === 'none').length} none`,
  })

  // 8 — 60+ days of daily data, so the trend cards and the per-developer deltas
  //     have a window rather than a stub.
  const [dayspan] = await sql<{ n: string }[]>`
    SELECT count(DISTINCT (ts_event AT TIME ZONE 'UTC')::date)::text AS n
      FROM v_complete_usage WHERE ts_event >= ${from}::timestamptz`
  checks.push({
    name: '60+ days of daily data',
    ok: Number(dayspan!.n) >= 60,
    detail: `${dayspan!.n} distinct days with usage`,
  })

  // 9 — mig 0123 conservation: every parent WITH children foots EXACTLY —
  //     money at 6dp, tokens integer (design tests 1-2, as fixture
  //     self-checks). Non-vacuous by construction: main() ran the real writer
  //     for the drift persona, so zero parents-with-children is itself a FAIL.
  const [fam] = await sql<{ parents: string; broken: string }[]>`
    SELECT count(*)::text AS parents,
           count(*) FILTER (WHERE child_usd <> cost_usd OR child_tok <> tokens)::text AS broken
      FROM (
        SELECT u.id, u.cost_usd, u.tokens,
               SUM(m.cost_usd) AS child_usd, SUM(m.tokens) AS child_tok
          FROM unaccounted_usage u
          JOIN unaccounted_usage_model m ON m.unaccounted_usage_id = u.id
         GROUP BY u.id
      ) q`
  checks.push({
    name: 'model children foot to their parents exactly',
    ok: Number(fam!.parents) > 0 && Number(fam!.broken) === 0,
    detail: `${fam!.parents} parents carry children · ${fam!.broken} do not foot`,
  })

  // 10 — the drift day capped DETERMINISTICALLY (design D3): expectation is
  //      re-derived here from DRIFT_SPLIT by the documented rule (floor, then
  //      descending cap, ties by model name), so a writer that reorders or
  //      rescales fails the fixture run on its face.
  if (drift) {
    let remaining = DRIFT_SPLIT.reduce((a, d) => a + d.apiUsd - d.otelUsd, 0)
    const expected = DRIFT_SPLIT
      .map((d) => ({ model: d.model, f: Math.max(0, d.apiUsd - d.otelUsd) }))
      .sort((a, b) => b.f - a.f || a.model.localeCompare(b.model))
      .map((x) => {
        const take = Math.min(x.f, Math.max(0, remaining))
        remaining -= take
        return { model: x.model, usd: take }
      })
      .filter((x) => x.usd > 0)
    const got = await sql<{ model: string; cost: string }[]>`
      SELECT m.model, m.cost_usd::text AS cost
        FROM unaccounted_usage u
        JOIN unaccounted_usage_model m ON m.unaccounted_usage_id = u.id
       WHERE u.teammate_id = ${drift.teammateId}::uuid AND u.day = ${drift.day}::date
         AND u.tool = 'claude-code'
       ORDER BY m.cost_usd DESC, m.model`
    const matches =
      got.length === expected.length &&
      expected.every((e, i) => got[i]!.model === e.model && Number(got[i]!.cost) === e.usd)
    checks.push({
      name: 'drift day: floored + capped children, in order',
      ok: matches,
      detail:
        `expected ${expected.map((e) => `${e.model}=$${e.usd}`).join(' ')} · ` +
        `got ${got.map((r) => `${r.model}=$${Number(r.cost)}`).join(' ') || '(none)'} (${drift.day})`,
    })
  }

  console.warn('')
  let failed = 0
  for (const c of checks) {
    if (!c.ok) failed += 1
    console.warn(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name.padEnd(46)} ${c.detail}`)
  }
  console.warn('')
  if (failed > 0) {
    console.error(`[fixture] ${failed} reconciliation check(s) FAILED — the fixture is not self-consistent.`)
    process.exitCode = 1
  }
}

function nextMonth(mk: string): string {
  const [y, m] = mk.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
