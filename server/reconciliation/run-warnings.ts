/*
 * Derive human-readable warnings from a persisted worker_run.result (jsonb).
 *
 * Generic + key-probing (not a per-worker switch) so it's robust to a NULL result
 * (legacy rows, pre-0042), an unknown worker, or a partial shape -> always returns an
 * array, never throws. Shared by the worker-runs list + detail endpoints.
 */
export function deriveRunWarnings(result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  const r = result as Record<string, unknown>
  const num = (k: string): number =>
    typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : 0
  const warnings: string[] = []
  // reconciliation-sync
  if (num('scopesErrored') > 0) warnings.push(`${num('scopesErrored')} scope(s) errored`)
  if (num('scopesSkippedNoCredential') > 0)
    warnings.push(`${num('scopesSkippedNoCredential')} scope(s) missing credentials`)
  if (num('scopesSkippedNoAdapter') > 0)
    warnings.push(`${num('scopesSkippedNoAdapter')} scope(s) without a registered adapter`)
  // identity-sync
  if (num('resolversErrored') > 0)
    warnings.push(`${num('resolversErrored')} identity resolver(s) errored`)
  // reconciliation engine (when a worker surfaces these directly)
  if (num('skippedInvalid') > 0)
    warnings.push(`${num('skippedInvalid')} line(s) skipped as invalid`)
  if (num('skippedUnresolved') > 0)
    warnings.push(`${num('skippedUnresolved')} line(s) skipped (teammate unresolved)`)
  // Credential-mode mirror (reconciliation-sync). An enterprise opted into the GitHub
  // App whose key is unwired silently falls back to PAT mode; the counter exists so
  // that downgrade is "visible in operator surfaces, not silent" — which is only true
  // if THIS prober dispatches on it, since the runs-list badge is the operator surface
  // that claim refers to.
  if (num('githubCredentialMirrorWarnings') > 0)
    warnings.push(
      `${num('githubCredentialMirrorWarnings')} enterprise(s) silently using PAT mode despite an App key`,
    )
  // Seat-roster truncation, as aggregated by reconciliation-sync. COUNTS, not the
  // per-enterprise booleans CopilotBillResult carries: copilot-bill is not its own
  // registry worker, so only ReconcileSyncResult is ever persisted as
  // worker_run.result. Probing the booleans here read a key that is never written.
  // A truncated pull means seatsTotal understates reality, which suppresses the
  // seat-convergence prune and makes any seat-count comparison misleading.
  if (num('copilotSeatPagesCapped') > 0)
    warnings.push(
      `${num('copilotSeatPagesCapped')} enterprise(s) hit the seat pagination cap — roster truncated, seat counts understated`,
    )
  if (num('copilotSeatPageShort') > 0)
    warnings.push(
      `${num('copilotSeatPageShort')} enterprise(s) ended the seat pull on a short page — roster may be incomplete`,
    )
  // copilot-pool-bill (§B pooled chargeback). This worker ISOLATES a failing
  // (enterprise, month) — it increments a counter, logs, and continues — so the run
  // still finishes 'success'. Without these probes a §B billing read that fails for
  // EVERY enterprise is invisible in every operator surface: the runs list shows a
  // green ok, the warnings badge is empty, worker logs are NSP-locked, and the GitHub
  // Verify probe has no billing stage (its ladder stops at metrics). The result is an
  // empty copilot_pool_bill that looks indistinguishable from "nothing was chargeable".
  // Unit-neutral wording on purpose: this ONE counter is incremented at two
  // sites with two different units — once per ENTERPRISE when credential
  // resolution fails before the month loop (copilot-pool-bill.ts:583), and once
  // per (enterprise, MONTH) when a billing report pull fails inside it
  // (copilot-pool-bill.ts:608). Calling the total "enterprise-month(s)" reads as
  // a precise quantity that is wrong in the first case, and an operator sizing
  // the gap from it would under-estimate. Say "failure(s)" until the counters are
  // split.
  if (num('enterprisesErrored') > 0)
    warnings.push(
      `${num('enterprisesErrored')} pooled billing read failure(s) — pooled chargeback under-books until re-run`,
    )
  if (num('enterprisesSkippedNoCredential') > 0)
    warnings.push(
      `${num('enterprisesSkippedNoCredential')} enterprise(s) skipped with no wired credential — pooled bill not read`,
    )
  // unsettledOrgMonths is explicitly "named to match run-warnings extraction" in
  // CopilotPoolBillResult, but that extraction was never written until now.
  if (num('unsettledOrgMonths') > 0)
    warnings.push(
      `${num('unsettledOrgMonths')} org-month(s) unsettled (usage present but no licence charge read) — licence cost missing from pooled chargeback`,
    )
  if (num('unclassifiedOrgMonths') > 0)
    warnings.push(
      `${num('unclassifiedOrgMonths')} org-month(s) carry unclassified Copilot spend — unclassified money is NEVER charged`,
    )
  // github-coverage-sweep (Workstream D, design §6). Anything but 'connected' raises a
  // run warning per the design table — surfaced here so the runs-list badge, worker
  // logs being NSP-locked, and the GitHub Verify probe's coverage stage all agree on
  // the same signal rather than requiring three separate places to notice a gap.
  if (num('nonConnectedOrgs') > 0)
    warnings.push(
      `${num('nonConnectedOrgs')} GitHub org(s) are not connected (mislinked/stale/not-installed/suspended/not-onboarded/coverage-unknown) — see the admin Reconciliation → Providers Coverage column`,
    )
  if (num('censusUnknownEnterprises') > 0)
    warnings.push(
      `${num('censusUnknownEnterprises')} GitHub enterprise(s) have no denominator this pass (census unavailable/capped/stale) — coverage completeness cannot be claimed`,
    )
  if (num('coverageComputeErrors') > 0)
    warnings.push(
      `${num('coverageComputeErrors')} enterprise(s) failed a coverage compute (our side, not a classified provider state) — coverage may be stale until re-run`,
    )
  return warnings
}
