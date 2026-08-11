/*
 * GitHub coverage — persistence (Workstream D, requirement 5: "persist only the
 * minimal latest observation needed for transition detection/operator UI").
 *
 * Writes/reads the two mig-0108 tables (drizzle/schema/github-coverage.ts). This is
 * the ONLY module that touches them — the sweep worker (github-coverage-sweep.ts) and
 * the admin routes (coverage.get.ts / coverage-recheck.post.ts) both go through it, so
 * "an expired observation reads as unknown, never as still-complete/still-connected"
 * (requirement 5) is enforced in exactly one place.
 *
 * LATEST-OBSERVATION ONLY: one row per (enterprise, org) and one row per enterprise —
 * a fresh persist REPLACES the prior observation outright (upsert), never appends a
 * history row. Transition detection (for the sweep's dedup/alerting) reads the PRIOR
 * row before this write replaces it.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type { CoverageState } from './coverage'
import type { CensusUnavailableReason, EnterpriseCoverageResult } from './github-coverage'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** How long a persisted observation is trusted before a reader must treat it as
 *  unknown (requirement 5). Set to comfortably outlive TWO missed sweep ticks at the
 *  worker's hourly cadence (registry.ts) — one delayed run must not flap the UI to
 *  "unknown"; a genuinely stalled sweep must not silently read as still-current
 *  forever. */
export const DEFAULT_COVERAGE_OBSERVATION_TTL_MS = 3 * 60 * 60 * 1000

export interface PersistedEnterpriseCensus {
  /** FALSE whenever the observation is missing or has expired, regardless of what was
   *  last observed — never present a stale row as still-available. */
  available: boolean
  capped: boolean
  reason: CensusUnavailableReason | null
  /** The last observed raw census size. Null whenever unavailable OR stale (a stale
   *  count is not a trustworthy denominator either). */
  orgCount: number | null
  observedAt: string | null
  /** True when a row exists but its expires_at has passed — the UI's "last known …,
   *  but this reading is stale" signal, distinct from "never observed at all". */
  stale: boolean
}

export interface PersistedOrgObservation {
  org: string
  /** The state to ACT on: 'coverage-unknown' whenever the observation is stale,
   *  otherwise the last-observed state verbatim (requirement 5: never render an
   *  expired observation as still connected/complete). */
  state: CoverageState
  /** The RAW last-observed state even when stale, for operator context ("was
   *  suspended as of 3 hours ago") — never used as the acted-on state above. */
  lastObservedState: CoverageState
  providerOrgId: string | null
  observedAt: string
  stale: boolean
}

export interface PersistedEnterpriseCoverage {
  enterpriseId: string
  census: PersistedEnterpriseCensus
  orgs: PersistedOrgObservation[]
}

/**
 * Persist a freshly-computed EnterpriseCoverageResult (github-coverage.ts) as the new
 * latest observation. Upserts the census row and one row per observed org — an org
 * NOT in `result.orgs` this pass keeps whatever was last persisted for it (this pass
 * may have been probe-bounded; see EnterpriseCoverageResult.probesCapped) rather than
 * being deleted, so a bounded pass never destroys still-valid recent data for the
 * orgs it didn't get to.
 */
export async function persistEnterpriseCoverage(
  db: Db,
  result: EnterpriseCoverageResult,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<void> {
  const now = opts.now ?? new Date()
  const ttlMs = opts.ttlMs ?? DEFAULT_COVERAGE_OBSERVATION_TTL_MS
  const observedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()

  await db.execute(sql`
    INSERT INTO provider_enterprise_coverage_census
      (provider_enterprise_id, available, capped, unavailable_reason, org_count, observed_at, expires_at)
    VALUES (
      ${result.enterpriseId}::uuid, ${result.census.available}, ${result.census.capped},
      ${result.census.reason}, ${result.census.orgCount}, ${observedAt}::timestamptz, ${expiresAt}::timestamptz
    )
    ON CONFLICT (provider_enterprise_id) DO UPDATE SET
      available = EXCLUDED.available,
      capped = EXCLUDED.capped,
      unavailable_reason = EXCLUDED.unavailable_reason,
      org_count = EXCLUDED.org_count,
      observed_at = EXCLUDED.observed_at,
      expires_at = EXCLUDED.expires_at
  `)

  // One row per org, per-row upsert (simple + correct; bounded by
  // MAX_ORG_PROBES_PER_PASS — at most a few hundred sequential, trivially-indexed
  // writes per enterprise per tick, an accepted cost for a background worker).
  for (const org of result.orgs) {
    await db.execute(sql`
      INSERT INTO provider_org_coverage
        (provider_enterprise_id, org_login, state, provider_org_id, observed_at, expires_at)
      VALUES (
        ${result.enterpriseId}::uuid, ${org.org}, ${org.state}, ${org.providerOrgId}::uuid,
        ${observedAt}::timestamptz, ${expiresAt}::timestamptz
      )
      ON CONFLICT (provider_enterprise_id, org_login) DO UPDATE SET
        state = EXCLUDED.state,
        provider_org_id = EXCLUDED.provider_org_id,
        observed_at = EXCLUDED.observed_at,
        expires_at = EXCLUDED.expires_at
    `)
  }
}

interface CensusRow extends Record<string, unknown> {
  provider_enterprise_id: string
  available: boolean
  capped: boolean
  unavailable_reason: string | null
  org_count: number | null
  observed_at: string
  expires_at: string
}

interface OrgRow extends Record<string, unknown> {
  provider_enterprise_id: string
  org_login: string
  state: string
  provider_org_id: string | null
  observed_at: string
  expires_at: string
}

function censusFromRow(row: CensusRow | undefined, now: Date): PersistedEnterpriseCensus {
  if (!row) {
    return { available: false, capped: false, reason: null, orgCount: null, observedAt: null, stale: false }
  }
  const stale = new Date(row.expires_at).getTime() < now.getTime()
  return {
    // requirement 5: an expired observation is NEVER presented as still available.
    available: stale ? false : row.available,
    capped: row.capped,
    reason: (row.unavailable_reason as CensusUnavailableReason | null) ?? null,
    orgCount: stale ? null : row.org_count,
    observedAt: row.observed_at,
    stale,
  }
}

function orgFromRow(row: OrgRow, now: Date): PersistedOrgObservation {
  const stale = new Date(row.expires_at).getTime() < now.getTime()
  const lastObservedState = row.state as CoverageState
  return {
    org: row.org_login,
    // requirement 5: expired ⇒ unknown, never "still connected"/"still complete".
    state: stale ? 'coverage-unknown' : lastObservedState,
    lastObservedState,
    providerOrgId: row.provider_org_id,
    observedAt: row.observed_at,
    stale,
  }
}

/**
 * Read the latest persisted coverage for ONE enterprise. Never throws for "nothing
 * persisted yet" — that reads as `available: false, stale: false` (never observed),
 * distinct from `stale: true` (observed once, now expired) — both mean "no
 * completeness claim", but the UI/operator messaging differs ("never checked" vs
 * "checked N ago, recheck").
 */
export async function loadPersistedEnterpriseCoverage(
  db: Db,
  enterpriseId: string,
  opts: { now?: Date } = {},
): Promise<PersistedEnterpriseCoverage> {
  const now = opts.now ?? new Date()
  const censusRows = await db.execute<CensusRow>(sql`
    SELECT provider_enterprise_id::text AS provider_enterprise_id, available, capped, unavailable_reason,
           org_count, observed_at::text AS observed_at, expires_at::text AS expires_at
    FROM provider_enterprise_coverage_census WHERE provider_enterprise_id = ${enterpriseId}::uuid
  `)
  const orgRows = await db.execute<OrgRow>(sql`
    SELECT provider_enterprise_id::text AS provider_enterprise_id, org_login, state,
           provider_org_id::text AS provider_org_id, observed_at::text AS observed_at, expires_at::text AS expires_at
    FROM provider_org_coverage WHERE provider_enterprise_id = ${enterpriseId}::uuid ORDER BY org_login
  `)
  return {
    enterpriseId,
    census: censusFromRow([...censusRows][0], now),
    orgs: [...orgRows].map((r) => orgFromRow(r, now)),
  }
}

/**
 * Read the latest persisted coverage for EVERY github enterprise that has ever been
 * observed (a left join against provider_enterprise so an enterprise never swept shows
 * up with a "never observed" census rather than being silently absent). Powers the
 * admin banner (an aggregate across every enterprise) without a live network call.
 */
export async function loadAllPersistedCoverage(
  db: Db,
  opts: { now?: Date } = {},
): Promise<PersistedEnterpriseCoverage[]> {
  const now = opts.now ?? new Date()
  const entRows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM provider_enterprise WHERE provider = 'github' ORDER BY display_name, id
  `)
  const out: PersistedEnterpriseCoverage[] = []
  for (const r of entRows) {
    out.push(await loadPersistedEnterpriseCoverage(db, r.id, { now }))
  }
  return out
}
