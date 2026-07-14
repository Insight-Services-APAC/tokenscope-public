/*
 * Shared per-(teammate, day) ReconciledLine builder — the standardisation seam for the
 * usage adapters (Anthropic = Stream A, GitHub/Copilot = Stream B). Both reconcile per-user
 * per-day usage into the SAME shape: resolve an actor to a teammate, then emit one line per
 * (teammate, day, category) in the native unit with a booked USD figure. This centralises
 * the subject wrapping + the decimal-string formatting (rate 8dp, amount 6dp) so the two
 * adapters — and any future provider — cannot drift in how a teammate line is assembled.
 *
 * It deliberately does NOT unify the providers' DIFFERENT internals (Anthropic's dual API
 * kinds + usage/cost join + org-grain tool costs; GitHub's metrics report) — only the final
 * line assembly. Org-grain lines (subject:{kind:'org'}) are NOT built here; an adapter that
 * needs them constructs them inline (they are rare and provider-specific).
 */
import type {
  ReconciledLine,
  ReconcileProvider,
  ReconcileCategory,
  SpendClass,
  IndicativeReason,
  UnitType,
} from '../types'

export interface TeammateLineInput {
  provider: ReconcileProvider
  /** Credential scope: anthropic org id | github enterprise slug. */
  enterpriseRef: string
  /** UTC day, YYYY-MM-DD. */
  periodDate: string
  teammateId: string
  category: ReconcileCategory
  /** Native billable quantity (tokens or ai-credits). */
  quantity: number
  unitType: UnitType
  /** Booked USD as a raw number; formatted to 6dp here. */
  amountUsd: number
  /*
   * Authoritative per-unit USD rate as a raw number. Omit to derive it as
   * amountUsd/quantity (0 when quantity is 0). Always formatted to 8dp.
   */
  rateUsdPerUnit?: number
  spendClass: SpendClass
  indicativeReason?: IndicativeReason
  /** GitHub license org; null/omitted for Anthropic. */
  licenseOrg?: string | null
  /** Credit providers only (GitHub): gross (billable) / discount (pool) / net (overage). */
  facets?: { gross: number; discount: number; net: number }
  /** Verbatim provider payload — preserved for audit and late-binding. */
  raw: unknown
}

/**
 * Assemble one provider-neutral per-(teammate, day) ReconciledLine. amountUsd is emitted
 * at 6dp. The rate is emitted at 8dp when supplied explicitly (GitHub passes the
 * authoritative grossAmount/grossQuantity or the flat $0.01); when omitted it is DERIVED as
 * `quantity > 0 ? (amountUsd / quantity).toFixed(8) : '0'` — the exact rule both adapters
 * already used, so a zero-quantity line still books `'0'` (not `'0.00000000'`) and existing
 * reconciliation_record rows do not shift. Optional facets / indicativeReason attach only
 * when present so token lines (no facets) stay minimal.
 */
export function reconciledTeammateLine(input: TeammateLineInput): ReconciledLine {
  const rateUsdPerUnit =
    input.rateUsdPerUnit !== undefined
      ? input.rateUsdPerUnit.toFixed(8)
      : input.quantity > 0
        ? (input.amountUsd / input.quantity).toFixed(8)
        : '0'
  const line: ReconciledLine = {
    provider: input.provider,
    enterpriseRef: input.enterpriseRef,
    licenseOrg: input.licenseOrg ?? null,
    periodDate: input.periodDate,
    subject: { kind: 'teammate', teammateId: input.teammateId },
    category: input.category,
    unit: { quantity: input.quantity, unitType: input.unitType },
    rateUsdPerUnit,
    amountUsd: input.amountUsd.toFixed(6),
    spendClass: input.spendClass,
    raw: input.raw,
  }
  if (input.facets) line.facets = input.facets
  if (input.indicativeReason) line.indicativeReason = input.indicativeReason
  return line
}
