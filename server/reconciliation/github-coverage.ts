/*
 * GitHub enterprise-org coverage — LIVE computation (Workstream D, design §6).
 *
 * Ties together the three sources the design calls for:
 *   1. the enterprise's own org census (GithubCopilotClient.listInstallableOrganizations,
 *      App mode only — the capability probe below classifies granted/denied/unknown);
 *   2. the reconciliation App's per-org installation state (GithubAppAuth.orgInstallationDetail);
 *   3. our own provider_org rows (DB-read here, never inferred).
 *
 * and classifies every org via the PURE precedence table in coverage.ts. This module
 * does the DB reads + live network probes; coverage.ts never touches either.
 *
 * SECRETS NEVER LEAVE THIS MODULE. Every value this module returns is a login, a uuid,
 * a boolean, a count, or a classified enum — never a PAT/App-key/installation-token, and
 * never a raw provider error body (a thrown probe error is caught and reduced to the
 * fixed 'probe-failed' / capability 'unknown' vocabulary before it can propagate).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import {
  classifyOrgCoverage,
  summariseEnterpriseCoverage,
  type CoverageState,
  type EnterpriseCoverageSummary,
  type OrgInstallationState,
} from './coverage'
import { resolveEnterpriseCredential, MissingGithubAppKeyError } from './credentials'
import { GithubAppAuth } from './adapters/github-app-auth'
import { GithubCopilotClient } from './adapters/github-client'

// Widened db (the credentials.ts / github.ts convention) so this accepts both the
// schema-typed getDb() handle and the RLS-bound request tx.
type Db = PostgresJsDatabase<Record<string, unknown>>

/** The enterprise row this module needs (mirrors GithubEnterpriseRow in github-health.ts). */
export interface CoverageEnterpriseRow {
  enterpriseId: string
  externalId: string
  githubAppId: string | null
}

/** Why an enterprise-level census could not be obtained this pass. */
export type CensusUnavailableReason =
  | 'not-app-mode' // no github_app_id configured — the enterprise has never opted into the App
  | 'no-credential' // App mode intended, but no App key is wired
  | 'key-malformed' // the wired App key does not decode/parse
  | 'capability-denied' // the App lacks "Enterprise organization installations: read" (401/403)
  | 'capability-unknown' // a transient failure (egress/5xx/parse) — not proven denied

export interface EnterpriseCoverageCensus {
  available: boolean
  /** The pull hit its pagination hard cap — a PREFIX, not the whole enterprise. */
  capped: boolean
  reason: CensusUnavailableReason | null
  /** The raw census size this pass. Null unless `available` (regardless of `capped` —
   *  the raw count is still informative even when it cannot serve as a denominator). */
  orgCount: number | null
}

export interface OrgCoverageObservation {
  org: string
  state: CoverageState
  /** The provider_org row this org resolved to, for the admin UI's remediation link. */
  providerOrgId: string | null
}

export interface EnterpriseCoverageResult {
  enterpriseId: string
  externalId: string
  census: EnterpriseCoverageCensus
  orgs: OrgCoverageObservation[]
  summary: EnterpriseCoverageSummary
  /** True when MAX_ORG_PROBES_PER_PASS was hit — some known/census orgs were left
   *  unclassified THIS pass (they retain whatever was last persisted for them, or are
   *  simply absent if never observed before). A future sweep/recheck makes progress on
   *  the remainder; this is the "bounded" half of "bounded coverage sweep". */
  probesCapped: boolean
}

/** A capability probe's classified outcome — never a raw provider error. */
export type CapabilityProbeResult =
  | { status: 'granted'; organizations: Array<{ id: number; login: string }>; capped: boolean }
  | { status: 'denied' }
  | { status: 'unknown'; reason: string }

/**
 * Extract the real upstream HTTP status from a thrown createError, the SAME
 * pattern-match technique classifyGithubHealthError / discover-orgs.post.ts use (the
 * client wraps every failure in a 502 envelope whose `data.detail` carries "…HTTP
 * <n>" — the envelope's own `data.status` is only the fallback). Never reads/returns
 * anything else from the error (no body text, no header values).
 */
function extractUpstreamStatus(err: unknown): number | null {
  const e = err as { data?: { status?: number; detail?: string } } | null
  const detail = String(e?.data?.detail ?? '')
  const m = /HTTP (\d{3})/.exec(detail)
  if (m) return Number(m[1])
  return typeof e?.data?.status === 'number' ? e.data.status : null
}

/**
 * Capability probe (requirement 3): does the reconciliation App actually have
 * "Enterprise organization installations: read" on this enterprise? Classifies the
 * outcome into granted / denied / unknown — NEVER throws, NEVER returns a raw error.
 *   - granted: the pull succeeded (organizations + whether the pagination cap was hit).
 *   - denied: a 401/403 — the permission is not granted (an actionable admin fix:
 *     re-approve the App installation with the permission).
 *   - unknown: anything else (egress/5xx/parse/deadline) — a TRANSIENT failure, never
 *     conflated with a proven denial (mirrors the github-health H1 principle: never
 *     default an unclassifiable failure to an auth/config claim).
 */
export async function probeInstallableOrganizationsCapability(
  client: Pick<GithubCopilotClient, 'listInstallableOrganizations'>,
): Promise<CapabilityProbeResult> {
  try {
    const result = await client.listInstallableOrganizations()
    return { status: 'granted', organizations: result.organizations, capped: result.pagesCapped }
  } catch (err) {
    const status = extractUpstreamStatus(err)
    if (status === 401 || status === 403) return { status: 'denied' }
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'unknown', reason: status != null ? `HTTP ${status}` : msg.slice(0, 200) }
  }
}

// Bound on how many per-org installation-detail probes ONE computation pass performs
// (module header "bounded"). Distinct from the census's own 10,000-org pagination cap:
// even a fully-paginated census could still name thousands of orgs, and a sequential
// per-org HTTP probe for every one of them in a single request/tick is not viable. Orgs
// beyond the bound are left unclassified THIS pass — probesCapped signals it, and the
// persisted "latest observation" model (coverage-store.ts) means a later sweep/recheck
// makes incremental progress rather than needing to redo the whole enterprise at once.
const MAX_ORG_PROBES_PER_PASS = 500

/** Known provider_org facts for one org login, read from the DB (never inferred). */
interface KnownOrgRow {
  providerOrgId: string
  linkedEnterpriseId: string | null
  costOwningUnitId: string | null
}

/**
 * Read every provider_org row relevant to this computation: rows already linked to
 * THIS enterprise (so a stale/suspended/not-onboarded org we track is never missed even
 * if it fell out of the census), UNIONed with any row sharing a login with a census
 * org (so a census org mistakenly linked to a DIFFERENT enterprise is caught —
 * `mislinked`). Keyed by lowercased org login (provider_org's canonical casing, mig 0064).
 */
async function loadKnownOrgRows(db: Db, enterpriseId: string, censusLogins: string[]): Promise<Map<string, KnownOrgRow>> {
  // A plain JS array bound via `${censusLogins}` expands to comma-separated scalar
  // params (an IN-list shape), NOT a native Postgres array — ANY() then fails
  // ("requires array on right side"). Build a real ARRAY[...] literal instead (the
  // same sql.join precedent server/reporting/cost-centres.ts already uses), explicitly
  // ::text[]-typed so an EMPTY census (nothing granted yet) still type-checks.
  const loginsArray =
    censusLogins.length > 0
      ? sql`ARRAY[${sql.join(censusLogins.map((l) => sql`${l}`), sql`, `)}]::text[]`
      : sql`ARRAY[]::text[]`
  const rows = await db.execute<{
    id: string
    org_login: string
    provider_enterprise_id: string | null
    cost_owning_unit_id: string | null
  }>(sql`
    SELECT id::text AS id,
           lower(external_org_id) AS org_login,
           provider_enterprise_id::text AS provider_enterprise_id,
           cost_owning_unit_id::text AS cost_owning_unit_id
    FROM provider_org
    WHERE provider = 'github'
      AND (
        provider_enterprise_id = ${enterpriseId}::uuid
        OR lower(external_org_id) = ANY(${loginsArray})
      )
  `)
  const map = new Map<string, KnownOrgRow>()
  for (const r of rows) {
    map.set(r.org_login, {
      providerOrgId: r.id,
      linkedEnterpriseId: r.provider_enterprise_id,
      costOwningUnitId: r.cost_owning_unit_id,
    })
  }
  return map
}

/** Last probe time per org. Bounded sweeps prioritize never-observed, then
 * oldest-observed orgs so repeated passes advance through fleets larger than
 * MAX_ORG_PROBES_PER_PASS instead of re-probing the same lexical prefix. */
async function loadCoverageObservationTimes(db: Db, enterpriseId: string): Promise<Map<string, number>> {
  const rows = await db.execute<{ org_login: string; observed_at: string }>(sql`
    SELECT lower(org_login) AS org_login, observed_at::text AS observed_at
    FROM provider_org_coverage
    WHERE provider_enterprise_id = ${enterpriseId}::uuid
  `)
  return new Map(rows.map((r) => [r.org_login, new Date(r.observed_at).getTime()]))
}

/** Probe one org's installation state, reducing any throw to 'probe-failed' — a
 *  transport/upstream failure classifies as unclassifiable, never as a positive claim. */
async function probeOrgInstallation(appAuth: GithubAppAuth, org: string): Promise<OrgInstallationState> {
  try {
    const detail = await appAuth.orgInstallationDetail(org)
    return detail.status
  } catch (err) {
    consola.warn(`[github-coverage] installation probe failed for org '${org}': ${err instanceof Error ? err.message : String(err)}`)
    return 'probe-failed'
  }
}

export interface ComputeCoverageOpts {
  resolveCredential?: typeof resolveEnterpriseCredential
  /** Override for tests — builds the App-mode client + auth from a resolved credential. */
  buildClient?: (args: { externalId: string; appId: string; value: string }) => {
    client: Pick<GithubCopilotClient, 'listInstallableOrganizations'>
    appAuth: GithubAppAuth
  }
  maxOrgProbes?: number
}

/**
 * Compute LIVE coverage for one GitHub enterprise. Never throws (every failure reduces
 * to a classified census/installation state); never returns a secret.
 *
 * A PAT-mode enterprise (no github_app_id) short-circuits to
 * `census.reason = 'not-app-mode'` with no per-org probing at all — the entire
 * coverage concept (an "installation" to check, an "installable_organizations" census)
 * is an App-only capability, so there is nothing to compute without one.
 */
export async function computeEnterpriseCoverage(
  db: Db,
  ent: CoverageEnterpriseRow,
  opts: ComputeCoverageOpts = {},
): Promise<EnterpriseCoverageResult> {
  const resolveCredential = opts.resolveCredential ?? resolveEnterpriseCredential
  const maxProbes = opts.maxOrgProbes ?? MAX_ORG_PROBES_PER_PASS
  const base = { enterpriseId: ent.enterpriseId, externalId: ent.externalId }

  const appMode = !!ent.githubAppId?.trim()
  if (!appMode) {
    return {
      ...base,
      census: { available: false, capped: false, reason: 'not-app-mode', orgCount: null },
      orgs: [],
      summary: summariseEnterpriseCoverage([], { censusAvailable: false, censusCapped: false, censusSize: 0 }),
      probesCapped: false,
    }
  }

  // Resolve the App credential. Config errors (no key / malformed key) are a DISTINCT
  // census-unavailable reason from a capability denial — an operator fixes them
  // differently (wire the key vs re-approve the App permission).
  let credential
  try {
    credential = await resolveCredential(db, { provider: 'github', externalId: ent.externalId })
  } catch (err) {
    if (err instanceof MissingGithubAppKeyError) {
      return {
        ...base,
        census: { available: false, capped: false, reason: 'no-credential', orgCount: null },
        orgs: [],
        summary: summariseEnterpriseCoverage([], { censusAvailable: false, censusCapped: false, censusSize: 0 }),
        probesCapped: false,
      }
    }
    throw err
  }
  if (!credential || credential.kind !== 'github-app' || !credential.appId) {
    // Either no row/secret resolved at all, or (defensively) a shape mismatch — an
    // App-mode enterprise whose credential did not resolve to an App credential is
    // exactly as uncoverable as one with no credential at all.
    return {
      ...base,
      census: { available: false, capped: false, reason: 'no-credential', orgCount: null },
      orgs: [],
      summary: summariseEnterpriseCoverage([], { censusAvailable: false, censusCapped: false, censusSize: 0 }),
      probesCapped: false,
    }
  }
  const appId = credential.appId
  const credentialValue = credential.value

  let appAuth: GithubAppAuth
  let client: Pick<GithubCopilotClient, 'listInstallableOrganizations'>
  try {
    if (opts.buildClient) {
      const built = opts.buildClient({ externalId: ent.externalId, appId, value: credentialValue })
      appAuth = built.appAuth
      client = built.client
    } else {
      appAuth = new GithubAppAuth(appId, credentialValue)
      client = GithubCopilotClient.withApp(ent.externalId, appAuth)
    }
  } catch (err) {
    // The App key resolved but failed to decode/parse (GithubAppAuth's own fail-loud
    // constructor assertion) — a config error, not a capability denial.
    if (/^github-app-auth:/.test(String((err as Error)?.message ?? ''))) {
      return {
        ...base,
        census: { available: false, capped: false, reason: 'key-malformed', orgCount: null },
        orgs: [],
        summary: summariseEnterpriseCoverage([], { censusAvailable: false, censusCapped: false, censusSize: 0 }),
        probesCapped: false,
      }
    }
    throw err
  }

  const capability = await probeInstallableOrganizationsCapability(client)
  const censusAvailable = capability.status === 'granted'
  const censusLogins = capability.status === 'granted' ? capability.organizations.map((o) => o.login.toLowerCase()) : []
  const censusSet = new Set(censusLogins)

  const known = await loadKnownOrgRows(db, ent.enterpriseId, censusLogins)

  // Universe = every census org ∪ every known row's login. Probe never-observed
  // orgs first, then the oldest observation, with login as the deterministic
  // tie-break. This is what makes a bounded pass actually resumable: a fleet
  // larger than maxProbes advances on the next sweep rather than re-reading the
  // same alphabetical prefix forever.
  const observedAt = await loadCoverageObservationTimes(db, ent.enterpriseId)
  const universe = [...new Set([...censusLogins, ...known.keys()])].sort((a, b) => {
    const aTime = observedAt.get(a)
    const bTime = observedAt.get(b)
    if (aTime == null && bTime != null) return -1
    if (aTime != null && bTime == null) return 1
    if (aTime !== bTime) return (aTime ?? 0) - (bTime ?? 0)
    return a.localeCompare(b)
  })

  let probesCapped = false
  const orgs: OrgCoverageObservation[] = []
  for (const org of universe) {
    if (orgs.length >= maxProbes) {
      probesCapped = true
      break
    }
    const row = known.get(org)
    const installation = await probeOrgInstallation(appAuth, org)
    const state = classifyOrgCoverage({
      providerOrgId: row?.providerOrgId ?? null,
      linkedEnterpriseId: row?.linkedEnterpriseId ?? null,
      costOwningUnitId: row?.costOwningUnitId ?? null,
      targetEnterpriseId: ent.enterpriseId,
      censusAvailable,
      inCensus: censusSet.has(org),
      installation,
    })
    orgs.push({ org, state, providerOrgId: row?.providerOrgId ?? null })
  }

  const census: EnterpriseCoverageCensus =
    capability.status === 'granted'
      ? { available: true, capped: capability.capped, reason: null, orgCount: capability.organizations.length }
      : {
          available: false,
          capped: false,
          reason: capability.status === 'denied' ? 'capability-denied' : 'capability-unknown',
          orgCount: null,
        }

  const summary = summariseEnterpriseCoverage(
    orgs.map((o) => o.state),
    {
      censusAvailable: census.available,
      // A pass that stopped early (probesCapped) is ALSO not a complete picture even
      // if the census pull itself was uncapped — the denominator must not claim
      // completeness for orgs this pass never got to classify.
      censusCapped: census.capped || probesCapped,
      censusSize: census.orgCount ?? 0,
    },
  )

  return { ...base, census, orgs, summary, probesCapped }
}
