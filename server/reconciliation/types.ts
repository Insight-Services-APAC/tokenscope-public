/*
 * Reconciliation engine — the FROZEN platform-agnostic contract.
 *
 * Both adapters (Anthropic = Stream A, GitHub = Stream B) implement `Adapter`
 * and emit `ReconciledLine[]`; the engine consumes them and never branches on
 * `provider`. Changes to these types are coordinated through the engine owner
 * (Stream A) — see docs/design/reconciliation-engine.md §6 and the Phase-1
 * split. Do NOT widen this in an adapter branch.
 */

export type ReconcileProvider = 'anthropic' | 'github'

/** The native billable unit a line is reconciled in. USD is display/booking only. */
export type UnitType = 'tokens' | 'ai-credits'

/** The money-vs-signal class (the finance_reportable gate is `!== 'indicative'`). */
export type SpendClass = 'billed' | 'estimated' | 'indicative'

export type IndicativeReason =
  | 'personal-subscription'
  // GENERAL finance-exclusion primitive: an org configured as exempt from the
  // finance/chargeback report (already paid directly — e.g. credit card / NFR).
  // 'nfr-demo' is the legacy partner-specific spelling, kept for backward-compat
  // (pre-existing reconciliation_record rows). The adapter now EMITS
  // 'chargeback-exempt'. See adapters/github.ts §finance-exclusion.
  | 'chargeback-exempt'
  | 'nfr-demo'
  | 'unknown-org'
  | 'copilot-pre-billing'

/*
 * Cost categories. `copilot_coding_agent` (Cloud Agent) is OTel-invisible and
 * ingest-only (never a walk-back); `web_search`/`code_execution`/`priority_tier`
 * are Anthropic org-grain. See §8.5.
 */
export type ReconcileCategory =
  | 'model_tokens'
  | 'copilot_interactive'
  | 'copilot_coding_agent'
  | 'web_search'
  | 'code_execution'
  | 'priority_tier'

/*
 * Who/what the billed line is against, resolved SERVER-SIDE by the adapter
 * (Anthropic: actor email -> teammate; GitHub: login -> SSO email -> teammate
 * via the seats/SCIM roster). Lines whose subject cannot be resolved to a
 * teammate are NOT emitted — they carry forward to the next sync (§10 L-1),
 * never silently dropped or mis-attributed.
 */
export type ReconcileSubject =
  | { kind: 'teammate'; teammateId: string }
  // Org-grain lines with no per-user signal (web_search/code_execution): rolled
  // at the cost-owning unit, surfaced not pro-rata'd onto developers (§8.5).
  | { kind: 'org'; costOwningUnitId: string | null }

/*
 * One normalised billed line for (subject, enterprise, day, category). Reconcile
 * in the NATIVE unit; `amountUsd` is the booked figure (= quantity * rate). For
 * credit providers (GitHub) `facets` carries gross/discount/net.
 */
export interface ReconciledLine {
  provider: ReconcileProvider
  /** Credential scope: anthropic org id | github enterprise slug. */
  enterpriseRef: string
  /** GitHub seat.organization (the license org); null for Anthropic. */
  licenseOrg: string | null
  /** UTC day, YYYY-MM-DD. */
  periodDate: string
  subject: ReconcileSubject
  category: ReconcileCategory
  unit: { quantity: number; unitType: UnitType }
  /** Credit providers only: gross (billable), discount (pool), net (overage). */
  facets?: { gross: number; discount: number; net: number }
  /** Authoritative per-unit USD rate (GitHub: grossAmount/grossQuantity). Decimal string. */
  rateUsdPerUnit: string
  /** Booked USD = quantity * rateUsdPerUnit. Decimal string. */
  amountUsd: string
  spendClass: SpendClass
  indicativeReason?: IndicativeReason
  /** Verbatim provider payload — preserved for audit and late-binding. */
  raw: unknown
}

export interface AdapterPullOptions {
  /** Inclusive UTC day, YYYY-MM-DD. */
  startDate: string
  /** Inclusive UTC day, YYYY-MM-DD. */
  endDate: string
}

/*
 * One Adapter instance is bound to one credential scope (an Anthropic org or a
 * GitHub enterprise). It owns auth, endpoint shape, pagination, identity
 * resolution, and normalisation — and emits provider-neutral `ReconciledLine[]`.
 */
export interface Adapter {
  readonly provider: ReconcileProvider
  /** Credential scope: anthropic org id | github enterprise slug. */
  readonly enterpriseRef: string
  pull(opts: AdapterPullOptions): Promise<ReconciledLine[]>
}

/** Engine outcome for one run (worker_run.rows_affected = recordsWritten). */
export interface ReconcileResult {
  linesProcessed: number
  recordsWritten: number
  over: number
  under: number
  matched: number
  /** Lines whose subject teammate no longer exists — carried forward, not written. */
  skippedUnresolved: number
  /** Lines with a non-finite amount/rate — rejected so no NaN reaches the ledger. */
  skippedInvalid: number
}
