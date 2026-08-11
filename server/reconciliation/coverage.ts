/*
 * GitHub enterprise-org coverage — the seven-state precedence-ordered truth table
 * (Workstream D, ADR-0011 D13 as amended by
 * docs/design/usage-completeness-and-provider-governance.md §6).
 *
 * Compares three sources for one target enterprise: the enterprise's own org census
 * (`GET /enterprises/{ent}/apps/installable_organizations`), the reconciliation App's
 * per-org installation state, and our `provider_org` rows. A naive five-state model
 * (`connected`, `not-installed`, `suspended`, `not-onboarded`, `stale`) is NOT a
 * partition: a suspended installation on an unhomed org matches two states at once,
 * and a `provider_org` row pointing at a DIFFERENT enterprise, an installation of a
 * DIFFERENT App, or a failed capability probe match none of the five. This module is
 * therefore a precedence-ordered waterfall — evaluate top-to-bottom, first match wins
 * — not an independent-predicate classifier.
 *
 *   1. mislinked          provider_org row belongs to another enterprise      (config error)
 *   2. coverage-unknown   census unavailable, or installation is another App  (cannot classify)
 *   3. stale              in provider_org, absent from the enterprise census
 *   4. not-installed      in census, no installation of THIS App
 *   5. suspended          installation of THIS App exists but is suspended
 *   6. not-onboarded      installed, but no provider_org row or no CoU
 *   7. connected          everything above passed
 *
 * Row 2's "census unavailable" clause is the census-dependent HALF of that row (an
 * org that WOULD be `stale`/`not-installed` but cannot be told apart without a
 * census — see the paragraph below); it is not a blanket "no census ⇒ every org is
 * coverage-unknown" rule. `different-app`/a failed installation probe are unconditional
 * triggers for row 2 regardless of census.
 *
 * CENSUS-INDEPENDENT vs CENSUS-DEPENDENT (§6 "authoritative fallback"). `mislinked`,
 * `suspended`, `not-onboarded`, and `connected` are determinable from installation
 * state plus our own rows alone, for an org we already know about — they remain
 * reportable per org even when the census is down. `stale` and `not-installed` are
 * BOTH defined by the census (whether the org currently belongs to the enterprise) —
 * without one, a bare 404 on the org's installation is undecidable (did it leave, or
 * is it just not installed?) and must fall back to `coverage-unknown` rather than be
 * guessed either way.
 *
 * ENTERPRISE COMPLETENESS IS A SEPARATE CLAIM FROM PER-ORG OBSERVATIONS. This module
 * exposes `classifyOrgCoverage` (one org's state — always computable) and
 * `summariseEnterpriseCoverage` (the enterprise-level roll-up, whose `denominator` is
 * `null` whenever a complete, uncapped census was not obtained THIS pass). A fresh or
 * empty enterprise with no census, no installations, and no `provider_org` rows must
 * never render "0 of 0 orgs — complete": that is the exact false-confidence failure
 * this workstream exists to prevent. Degraded mode can confirm gaps it finds; it can
 * never confirm their absence.
 *
 * Pure + framework-free: no DB, no network, no I/O. The caller (coverage-compute.ts)
 * gathers the facts (DB reads + live probes) and this module only classifies them —
 * so the precedence table is unit-testable in total isolation and the exhaustiveness
 * of the seven states is independent of how the facts were gathered.
 */

/** The seven-state coverage classification, in PRECEDENCE order (see module header). */
export type CoverageState =
  | 'mislinked'
  | 'coverage-unknown'
  | 'stale'
  | 'not-installed'
  | 'suspended'
  | 'not-onboarded'
  | 'connected'

/** Every state, in precedence order — the exhaustive enumeration tests pin against. */
export const COVERAGE_STATES: readonly CoverageState[] = [
  'mislinked',
  'coverage-unknown',
  'stale',
  'not-installed',
  'suspended',
  'not-onboarded',
  'connected',
]

/**
 * The reconciliation App's installation state for ONE org, as resolved by
 * `GithubAppAuth`'s rich installation-detail method (github-app-auth.ts):
 *   - 'not-found'    the App has no installation on this org (a clean 404)
 *   - 'suspended'    an installation of OUR App exists but is suspended
 *   - 'different-app' an installation exists but belongs to a different App id
 *   - 'active'       an installation of OUR App exists and is not suspended
 *   - 'probe-failed' the probe itself could not be trusted (egress/auth/parse
 *                    failure, or the deadline backstop) — never a positive claim
 */
export type OrgInstallationState = 'not-found' | 'suspended' | 'different-app' | 'active' | 'probe-failed'

/**
 * The facts `classifyOrgCoverage` needs for ONE (org, target enterprise) pair.
 * Every field is a plain, independently-obtained fact — the function performs no
 * DB/network access and derives no fact from another; this keeps the precedence
 * waterfall auditable against the design table one condition at a time.
 */
export interface OrgCoverageFacts {
  /** `provider_org.id` for this org login, looked up GLOBALLY by (provider,
   *  external_org_id) — i.e. regardless of which enterprise it is linked to. `null`
   *  when no such row exists at all. */
  providerOrgId: string | null
  /** That row's `provider_enterprise_id`, or `null` when the row exists but carries
   *  no enterprise link (pre-two-level-registry rows), or no row exists. */
  linkedEnterpriseId: string | null
  /** That row's `cost_owning_unit_id`, or `null` when unset or no row exists. */
  costOwningUnitId: string | null
  /** The enterprise this classification is being evaluated FOR (`provider_enterprise.id`). */
  targetEnterpriseId: string
  /** Whether an authoritative census (however large) was obtained THIS pass — i.e.
   *  the enterprise's `installable_organizations` pull succeeded without a capability
   *  denial or a transient failure. May still be `true` when the pull hit its
   *  pagination hard cap; capping affects the ENTERPRISE-level denominator
   *  (`summariseEnterpriseCoverage`), not whether an individual org's membership can be
   *  read from the page(s) actually retrieved. */
  censusAvailable: boolean
  /** Whether this org appears in the (possibly partial) census pulled this pass.
   *  Meaningful only when `censusAvailable` is true. */
  inCensus: boolean
  /** The reconciliation App's installation state for this org (see {@link OrgInstallationState}). */
  installation: OrgInstallationState
}

/**
 * Classify ONE org's coverage against ONE target enterprise. A pure precedence
 * waterfall — evaluated top-to-bottom, exactly matching the module-header table.
 * Every branch is a single, independently-readable condition so a reviewer can check
 * it against the design table line by line.
 *
 * CENSUS AVAILABILITY GATES ONLY THE TWO STATES IT DEFINES. `stale` and
 * `not-installed` are the only states census-dependent by definition (§6 "authoritative
 * fallback") — without an available census they are SKIPPED (never asserted, never
 * guessed), falling through to the census-independent checks below them
 * (`suspended` / `not-onboarded` / `connected`), which remain fully assertable from
 * the installation probe and our own rows alone. A degraded (no-census) enterprise can
 * therefore still say "this KNOWN org is suspended" or "this KNOWN org is connected" —
 * a gap (or a clean bill) it positively found — while refusing to say "and there are
 * no others", which is the separate, enterprise-level denominator claim
 * ({@link summariseEnterpriseCoverage}) suppressed independently of this function.
 */
export function classifyOrgCoverage(facts: OrgCoverageFacts): CoverageState {
  const { providerOrgId, linkedEnterpriseId, costOwningUnitId, targetEnterpriseId, censusAvailable, inCensus, installation } = facts

  // 1. mislinked — a config error. Takes precedence over every live signal below:
  //    a row that thinks it belongs to a DIFFERENT enterprise is wrong regardless of
  //    what the census or the installation probe say.
  if (providerOrgId !== null && linkedEnterpriseId !== null && linkedEnterpriseId !== targetEnterpriseId) {
    return 'mislinked'
  }

  // 2. coverage-unknown — the installation probe itself could not be trusted: another
  //    App holds the installation (we cannot see our own state through it), or the
  //    probe failed transiently (egress/auth/parse/deadline). Never guess past this.
  if (installation === 'different-app' || installation === 'probe-failed') {
    return 'coverage-unknown'
  }

  // 3. stale — CENSUS-DEPENDENT, and unconditional on the installation state: we
  //    already track this org (a provider_org row exists), but an AVAILABLE census no
  //    longer lists it as a current member. Checked ahead of not-installed/suspended/
  //    not-onboarded/connected — an org that left the enterprise is stale whether its
  //    stranded installation still reads suspended, active, or not-found; the remedy
  //    is the same either way (remove the config), never "un-suspend" or "home it".
  //    SKIPPED (not asserted false) when the census is unavailable, per the module doc.
  if (censusAvailable && providerOrgId !== null && !inCensus) return 'stale'

  // 4. not-installed — CENSUS-DEPENDENT: a confirmed CURRENT census member, but the
  //    reconciliation App has no installation here at all. A bare 404 is undecidable
  //    without the census (did the org leave, or is it just not installed?), so it
  //    falls back to coverage-unknown rather than guess either census-dependent claim.
  if (installation === 'not-found') {
    if (!censusAvailable) return 'coverage-unknown'
    if (inCensus) return 'not-installed'
    // censusAvailable && !inCensus && providerOrgId === null: an org neither the
    // (available) census nor our own rows know about. Should not occur in practice —
    // nothing would construct this fact — but falls through to coverage-unknown
    // rather than fabricate a census-dependent claim either way.
    return 'coverage-unknown'
  }

  // 5. suspended — CENSUS-INDEPENDENT: an installation of THIS App exists but is
  //    suspended, true regardless of census availability.
  if (installation === 'suspended') return 'suspended'

  // installation === 'active' from here on.
  // 6. not-onboarded — CENSUS-INDEPENDENT: installed (active) and a current member
  //    when census is available, but there is no provider_org row, or the row is not
  //    linked to THIS enterprise (unlinked — mislinked-to-ANOTHER was already excluded
  //    at step 1), or the row has no cost-owning-unit home.
  if (providerOrgId === null || linkedEnterpriseId !== targetEnterpriseId || costOwningUnitId === null) {
    return 'not-onboarded'
  }

  // 7. connected — CENSUS-INDEPENDENT: every prior check passed (installed, not
  //    suspended, onboarded — linked + homed to a CoU).
  return 'connected'
}

/** Enterprise-level roll-up. Denominator is a SEPARATE claim from per-org states. */
export interface EnterpriseCoverageSummary {
  /**
   * The enterprise's total org count from an authoritative, UNCAPPED census this
   * pass — `null` whenever an "N of M" completeness claim cannot be honestly made
   * (no census obtained, or the census pull hit its pagination cap and is therefore
   * a prefix, not the whole enterprise). Never derived from the observed-org count,
   * which may include `stale` rows the census says have left — those must not
   * inflate M.
   */
  denominator: number | null
  /** How many of the observed orgs classify `connected`. Always ≤ denominator when
   *  denominator is non-null (every `connected` org is, by construction, a current
   *  census member). Countable regardless of denominator availability. */
  connected: number
  /** Per-state counts across every org actually observed this pass (always fully
   *  populated — 0 for a state with no members, never an absent key). */
  states: Record<CoverageState, number>
}

function zeroedStateCounts(): Record<CoverageState, number> {
  const out = {} as Record<CoverageState, number>
  for (const s of COVERAGE_STATES) out[s] = 0
  return out
}

/**
 * Roll up a set of already-classified org states into the enterprise-level summary.
 * `censusSize` is the actual count of orgs returned by the census pull (not the
 * length of `orgStates`, which may include extra `stale` rows the census does not
 * count as current members) — it is the authoritative "M" when `censusAvailable &&
 * !censusCapped`, and is ignored (denominator forced to `null`) otherwise.
 *
 * NEVER renders "0 of 0" by omission: an empty `orgStates` with `censusAvailable:
 * false` yields `denominator: null`, not `denominator: 0` — a null denominator is
 * the UI's signal to render "coverage unknown", not "0 of 0 — complete" (§6 R1-M5).
 */
export function summariseEnterpriseCoverage(
  orgStates: readonly CoverageState[],
  opts: { censusAvailable: boolean; censusCapped: boolean; censusSize: number },
): EnterpriseCoverageSummary {
  const states = zeroedStateCounts()
  for (const s of orgStates) states[s] += 1
  const denominator = opts.censusAvailable && !opts.censusCapped ? opts.censusSize : null
  return { denominator, connected: states.connected, states }
}

/** True for any state other than `connected` — the run-warning / banner / Verify-ladder trigger. */
export function isNonConnected(state: CoverageState): boolean {
  return state !== 'connected'
}
