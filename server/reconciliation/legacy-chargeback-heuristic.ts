/*
 * LEGACY — pre-activation GitHub chargeback heuristic.
 *
 * This module exists ONLY so the governance cutover (server/governance/cutover.ts)
 * can (a) compute what today's heuristic-driven verdict IS, for the preflight
 * equivalence check, and (b) let the resolver (server/governance/verdict.ts)
 * reproduce that EXACT behaviour for any money path while the governance cutover
 * is not yet activated — i.e. it is the ROLLBACK SEAM. Per
 * docs/design/usage-completeness-and-provider-governance.md §8.1/§8.4 and ADR-0011
 * D1/D2: "Governance that changes money is stored as data... Configuration and
 * name heuristics may not decide chargeability" — this heuristic is exactly what
 * that decision deletes, but deleting the CODE outright would make rollback (before
 * any closed period uses the new regime) impossible, so it stays, quarantined here.
 *
 * DO NOT call these functions directly from any money path. The single sanctioned
 * caller is `server/governance/verdict.ts`'s resolver, which is the ONLY place
 * that branches on activation state — so no caller can ever blend the legacy and
 * governance regimes. Once GitHub's cutover has been activated in production and
 * stayed activated through a full closed period (the rollback window has passed),
 * this module — and the `activated ? ... : legacy(...)` branch that reads it — is
 * deleted outright in a follow-up cleanup (see the rollout runbook,
 * docs/development/workstream-b-governance-rollout.md).
 *
 * Behaviour is verbatim what server/reconciliation/adapters/github.ts contained
 * before Workstream B (moved, not rewritten, so the preflight's "old verdict"
 * computation is provably identical to what has been live in production).
 */

/*
 * §finance-exclusion — GENERAL finance/chargeback exclusion, keyed by GitHub ORG.
 *
 * The PRIMITIVE (owner decision 2026-06-22): track ALL spend, but exclude a
 * CONFIGURABLE SET OF GITHUB ORGS from the finance/chargeback report — because that
 * spend is already paid directly (e.g. credit card, or a genuine NFR/partner-demo
 * enterprise). "NFR" is a PARTNER-only LABEL, not the mechanism: a partner-NFR org is
 * simply one entry in the exempt set. Per-user exclusion is a later option — NOT now.
 *
 * Mechanism: an org in the exempt set reconciles as `indicative` (reason
 * 'chargeback-exempt') -> excluded from v_finance_reportable_spend (the cross-charge
 * gate is `spend_class <> 'indicative'`, mig 0039). An org NOT in the set is
 * chargeback-eligible.
 *
 * Config: NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS (comma-separated org logins,
 * case-insensitive). BACKWARD-COMPAT: the legacy NUXT_GITHUB_NFR_DEMO_ORGS is read as a
 * fallback alias (union of both) so an existing deployment keeps working unchanged.
 *
 * Name heuristic (always on): a conservative demo/NFR name match classes obvious
 * demo/NFR orgs exempt so the seeded partner-demo enterprise (whose every org is an NFR
 * demo) is excluded out of the box. The explicit config is UNIONed with it, NOT a
 * replacement: an org is exempt if it is configured OR matches the heuristic. This means
 * (a) a demo/NFR org omitted from the list is still exempt (no silent mis-charge), and
 * (b) there is NO negative override — a prod org legitimately named "*-demo"/"*-nfr"
 * cannot be made chargeable via config; rename the org or adjust the heuristic instead.
 */
export const CHARGEBACK_EXEMPT_HEURISTIC = /(?:^|[-_ ])(?:demo|nfr)(?:[-_ )]|$)/i

/*
 * The configured set of finance/chargeback-exempt GitHub orgs (lowercased). Reads
 * NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS and unions in the legacy NUXT_GITHUB_NFR_DEMO_ORGS
 * (backward-compat alias) so neither var silently shadows the other.
 */
export function chargebackExemptOrgSet(): Set<string> {
  const out = new Set<string>()
  for (const raw of [process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS, process.env.NUXT_GITHUB_NFR_DEMO_ORGS]) {
    if (!raw) continue
    for (const s of raw.split(',')) {
      const v = s.trim().toLowerCase()
      if (v) out.add(v)
    }
  }
  return out
}

/**
 * True if a license org is exempt from the finance/chargeback report.
 *
 * UNION, not replace: an org is exempt if it is explicitly configured OR matches the
 * nfr/demo name heuristic.
 */
export function isChargebackExemptOrg(licenseOrg: string | null, configured: Set<string>): boolean {
  if (!licenseOrg) return false
  return configured.has(licenseOrg.toLowerCase()) || CHARGEBACK_EXEMPT_HEURISTIC.test(licenseOrg)
}

/**
 * @deprecated Use {@link chargebackExemptOrgSet}. Retained as a backward-compat alias
 * (the general primitive replaces the partner-specific "NFR/demo" naming).
 */
export const nfrDemoOrgSet = chargebackExemptOrgSet

/**
 * @deprecated Use {@link isChargebackExemptOrg}. Backward-compat alias.
 */
export const isNfrDemoOrg = isChargebackExemptOrg

/*
 * §finance-exclusion at the ENTERPRISE grain — for the App-mode metrics path, which has NO
 * per-user license org (the users-1-day record carries no org), so the chargeback verdict is
 * decided once for the whole enterprise. Reads NUXT_GITHUB_CHARGEBACK_EXEMPT_ENTERPRISES
 * (comma-separated enterprise slugs, case-insensitive). Kept SEPARATE from the org-keyed set
 * so the §A/§B keying is EXPLICIT — an operator never shoehorns an enterprise slug into an
 * org list.
 */
export function chargebackExemptEnterpriseSet(): Set<string> {
  const out = new Set<string>()
  const raw = process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ENTERPRISES
  if (raw) {
    for (const s of raw.split(',')) {
      const v = s.trim().toLowerCase()
      if (v) out.add(v)
    }
  }
  return out
}

/**
 * True if a whole ENTERPRISE is finance/chargeback-exempt (App-mode metrics path, and the
 * governance-cutover preflight's "old verdict" for an App-mode or org-less enterprise). UNION
 * of the explicit config set and the demo/nfr name heuristic on the slug — the same safe
 * default the org path uses (a `*-demo` / `*-nfr` enterprise is exempt out of the box).
 *
 * LIMITATION (documented, not a bug): the metrics report carries no per-user license org, so
 * App mode applies ONE verdict to the ENTIRE enterprise. A MIXED enterprise (some orgs
 * exempt, some chargeable) cannot be split on this path — set the verdict explicitly via
 * NUXT_GITHUB_CHARGEBACK_EXEMPT_ENTERPRISES. The PAT path keeps per-org granularity via the
 * seat roster (isChargebackExemptOrg) — and it is exactly that per-org granularity vs this
 * single enterprise verdict that the governance cutover's mixed-enterprise detection exists
 * to reconcile (docs/design/usage-completeness-and-provider-governance.md §8.1).
 */
export function isChargebackExemptEnterprise(enterpriseRef: string, configured: Set<string>): boolean {
  return configured.has(enterpriseRef.toLowerCase()) || CHARGEBACK_EXEMPT_HEURISTIC.test(enterpriseRef)
}
