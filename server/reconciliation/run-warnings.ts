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
  if (num('skippedInvalid') > 0) warnings.push(`${num('skippedInvalid')} line(s) skipped as invalid`)
  if (num('skippedUnresolved') > 0)
    warnings.push(`${num('skippedUnresolved')} line(s) skipped (teammate unresolved)`)
  return warnings
}
