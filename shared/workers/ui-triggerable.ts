/*
 * SINGLE SOURCE OF TRUTH for the worker names an admin may trigger on-demand from
 * the UI ("Run now"). Imported by BOTH sides so they can never drift:
 *   - the server safelist (server/workers/registry.ts → UI_TRIGGERABLE_WORKERS,
 *     the REAL gate the endpoint enforces), and
 *   - the admin page's picker (app/pages/admin/reconciliation.vue).
 * Server code imports this via a relative path; client code via `#shared/...`.
 *
 * The set is deliberately NARROWER than the full worker registry: only the
 * reconciliation / identity / placement family, whose runs an admin legitimately
 * needs to FORCE after onboarding a provider org, adding a credential, or moving a
 * teammate (e.g. re-run identity-sync so a freshly-onboarded org's seat-holders
 * bind to teammates instead of sitting "unresolved" until the nightly cron). Each
 * is idempotent / progressively-correct (safe to re-run) and single-flight-locked,
 * so a click during a cron run cleanly 409s rather than double-running.
 *
 * DELIBERATELY EXCLUDED: destructive / heavy / money-settling workers (soft-purge,
 * session-gc, pending-placement-gc, reconciliation-backfill, copilot-pool-bill,
 * ...) stay cron/HMAC-only — a one-click button is the wrong blast radius. Widen
 * only with the same "idempotent + an admin has a real reason to force it" bar.
 *
 * NOTE `aggregate-rollup` self-bootstraps a 90-day backfill when the aggregate
 * table is empty — a multi-minute run, not the lightweight tick the rest of the
 * set implies. Kept (idempotent, admin-forceable after a data fix) but heavier.
 */
export const UI_TRIGGERABLE_WORKER_NAMES = [
  'identity-sync',
  'reconciliation',
  'reconciliation-sync',
  'reconciliation-gap',
  'usage-reconciliation',
  'placement-sync',
  'region-reenrichment',
  // NOTE 'privileged-identity-cleanup' is DELIBERATELY absent — it can
  // deactivate teammates + revoke ownerships, so per this file's contract
  // (destructive workers stay cron/HMAC-only) it is not one-click-triggerable.
  'aggregate-rollup',
  'went-silent',
] as const

/*
 * Workers that WRITE the reconciliation ledger (reconciliation_record). The UI
 * double-confirms before firing one — a fat-finger on a ledger worker shouldn't be
 * a single click. A subset of the names above.
 *
 * Classified by what each ACTUALLY writes (not by name): `reconciliation-sync` runs
 * the engine that upserts+stamps reconciliation_record; `usage-reconciliation`
 * upserts the taggable unaccounted-usage records (§A). NOT `reconciliation` — that
 * only emits info-severity inbox items (untagged-backlog nudges), no ledger write —
 * so it is deliberately absent here.
 */
export const UI_MONEY_WORKER_NAMES: ReadonlySet<string> = new Set(['reconciliation-sync', 'usage-reconciliation'])
