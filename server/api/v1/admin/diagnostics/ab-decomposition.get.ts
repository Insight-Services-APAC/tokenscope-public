/*
 * GET /api/v1/admin/diagnostics/ab-decomposition — why does chargeable (§B) not
 * equal attributed (§A)?
 *
 * This is the OPERATOR SURFACE for the Workstream A gate in
 * docs/design/usage-completeness-and-provider-governance.md §1.1: "gate on a
 * full decomposition, not a subtraction". The gate has two halves, and only one
 * of them can be settled in a test:
 *
 *   CORRECTNESS — does the delta decompose to a zero residual? Proven locally
 *     against synthesised data by tests/integration/usage/ab-decomposition.test.ts.
 *   MAGNITUDE   — do non-Code surfaces actually DOMINATE the delta? That is a
 *     question about production numbers. Nobody can run SQL against Dev or
 *     production, so without this endpoint the question cannot be answered at
 *     all. Same reasoning as the sibling attribution-gaps probe: if a check
 *     matters enough to run, it belongs in the product.
 *
 * The `verdict` field below is the gate's answer, computed rather than left for
 * a human to eyeball a table of signed numbers and guess. Workstream A must NOT
 * ship on a `residual-non-zero` verdict (the decomposition is lying) nor on a
 * `non-code-dominates` verdict being absent.
 *
 * Read `non-code-does-not-dominate` carefully before treating it as a refutation.
 * On an estate that carries no non-Code spend at all it is a NULL RESULT: the
 * design's premise has nothing to bite on, not evidence against it. The Dev
 * estate is exactly that case today (four claude-code actual_spend rows, no
 * copilot_pool_bill rows), so its 0% share says nothing either way. Distinguish
 * the two by the size of the nonCodeSurfaces term itself, not by the verdict.
 *
 * It also carries the UNHOMED CAUSE SPLIT (server/usage/unhomed-causes.ts): the
 * card's unhomed line states a total and a consequence, and nothing about the
 * cause, so an operator cannot choose between four different remediations or
 * size any of them. Same argument as above — the question is about production
 * numbers nobody can query, so the answer belongs in the product.
 *
 * RBAC: global-finops ONLY — deliberately narrower than the sibling diagnostics
 * probes, which admit a region admin. The reason is at the requireRole call.
 *
 * NOT WIDENED for the cause split, even though two of the four remediations it
 * names belong to a REGION ADMIN who cannot read this page. The endpoint cannot
 * be region-scoped (see the requireRole comment), and "the fix has a different
 * owner" is not a reason to hand a region admin every other region's money. The
 * panel says the work must be handed over instead. A region-scoped drill would
 * be a separate slice with its own scoping argument.
 */
import { defineEventHandler } from 'h3'
import { z } from 'zod'
import { consola } from 'consola'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getValidated } from '../../../../utils/validated-body'
import { classifyProbeError } from '../../../../utils/redact-probe-error'
import { getReportVisibilityMode } from '../../../../auth/report-scope'
import {
  computeAbDecomposition,
  AB_DECOMPOSITION_TERMS,
  type AbDecompositionResult,
} from '../../../../usage/ab-decomposition'
import {
  computeUnhomedCauses,
  UNHOMED_WORKLIST_CAP,
  UNHOMED_HISTORY_MONTHS,
  type UnhomedProbeResult,
} from '../../../../usage/unhomed-causes'
import {
  REPORT_VISIBILITY_LABELS,
  REPORT_VISIBILITY_DESCRIPTIONS,
  REPORT_VISIBILITY_PERSONAS,
  DEFAULT_REPORT_VISIBILITY_MODE,
  reportGrants,
  grantsToScopes,
} from '../../../../../shared/auth/report-visibility'

/*
 * Month-aligned windows only, and the constraint is load-bearing rather than
 * laziness. §A filters on ts_event (a timestamptz) while §B filters on
 * period_month (a month-grained date), so a window that splits a month counts a
 * whole month of §B against a partial month of §A and the residual blows up for
 * a reason that has nothing to do with the decomposition being wrong. Rejecting
 * the input beats returning a confidently wrong number.
 */
const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM (e.g. 2026-05)')

/** The current calendar month, UTC — the newest month that can be asked about. */
function currentUtcMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

const querySchema = z
  .object({
    from: monthSchema,
    to: monthSchema.optional(),
  })
  .transform((q) => ({ from: q.from, to: q.to ?? q.from }))
  .refine((q) => q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  /*
   * NO FUTURE MONTHS. A month that has not happened yet holds no rows, and every
   * surface downstream would then describe that absence in FINANCE language: the
   * decomposition renders $0.00 against $0.00 with a "no delta" verdict, the
   * split calls the window an empty month, and the trend labels five prior months
   * plus a nonexistent one "billed nothing", "open" and therefore remediable.
   * None of that is a reading of the estate — it is a reading of a month that
   * does not exist yet. The only honest answer is to refuse the question, so the
   * card shows its load error rather than a confident set of zeros.
   *
   * The current (partial) month is fine and is NOT rejected: it exists, it is
   * simply incomplete, and the trend already marks it "still in progress".
   */
  .refine((q) => q.to <= currentUtcMonth(), {
    message:
      'month must not be in the future — a month that has not happened has nothing to decompose',
    path: ['to'],
  })

/** First instant of a YYYY-MM, UTC. */
function monthStartIso(month: string): string {
  return `${month}-01T00:00:00.000Z`
}

/** First instant of the month AFTER a YYYY-MM, UTC — the exclusive end. */
function monthEndIso(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const y2 = m === 12 ? y + 1 : y
  const m2 = m === 12 ? 1 : m + 1
  return `${y2}-${String(m2).padStart(2, '0')}-01T00:00:00.000Z`
}

export type AbDecompositionVerdict =
  | 'residual-non-zero'
  | 'no-delta'
  | 'non-code-dominates'
  | 'non-code-does-not-dominate'

/**
 * The gate's answer.
 *
 * "Dominates" means the non-Code term accounts for more of the delta than every
 * other term put together, measured on ABSOLUTE contributions. Absolute matters:
 * terms are signed, and on a signed sum a large positive and a large negative
 * cancel to a small delta, which would let a term look dominant merely because
 * the others happened to offset each other.
 */
export function classifyDecomposition(result: AbDecompositionResult): {
  verdict: AbDecompositionVerdict
  nonCodeShareOfExplained: number | null
} {
  if (Number(result.residual) !== 0) {
    return { verdict: 'residual-non-zero', nonCodeShareOfExplained: null }
  }
  /*
   * The VERDICT is decided in exact integer micro-dollars, not floats. Every
   * amount is numeric(14,6) on the wire, so the true scaled value is an
   * INTEGER number of micros and the conversion below recovers it exactly.
   *
   * "Recovers", not "is lossless" — the distinction is the whole argument, and
   * an earlier version of this comment got it wrong. `Number(v) * 1e6` is a
   * float product and IS inexact. What makes it safe is that the error is
   * bounded far below the rounding threshold: Number(v) carries relative error
   * <= 2^-53, the multiply adds one more, so for |value| up to numeric(14,6)'s
   * ceiling (1e14 micros) the absolute error is <= ~0.022 micros against the
   * 0.5 that Math.round must beat. No half-cases can arise to spoil it, because
   * an input with at most six decimals cannot land on X.5 micros. The bound
   * holds until |value| reaches 2^53/1e6, about $9 billion — nine thousand
   * times the largest estate this could plausibly meet.
   *
   * Do NOT "fix" this by reaching for usdToMicros() in server/usage/
   * span-costing.ts. That helper parses the decimal string exactly, which is
   * strictly better in isolation, but it enforces MAX_COST_MICROS — the
   * STORABILITY bound of a single attribution_record row — and returns null
   * above it. These are estate-wide AGGREGATES of such rows, so that bound is
   * semantically wrong here and would turn a large-but-valid estate into a
   * failed probe.
   *
   * This matters at exactly one point, and it is the point the whole gate turns
   * on: a term worth exactly half the absolute total. In float, terms summing to
   * a true 50% can land on 0.5000000000000001, which passes a strict `> 0.5` and
   * flips the verdict to "non-Code dominates" on a tie. Deciding a gate by the
   * last bit of a float is not a decision anyone can reproduce or defend.
   *
   * The returned SHARE stays a float: it is a reporting figure rendered as a
   * rounded percentage and never feeds back into money or into the verdict.
   */
  const micro = (v: string): bigint => BigInt(
    Math.round(Number(v) * 1_000_000),
  )
  const absTotal = AB_DECOMPOSITION_TERMS.reduce((acc, t) => {
    const m = micro(result.terms[t])
    return acc + (m < 0n ? -m : m)
  }, 0n)
  if (absTotal === 0n) {
    return { verdict: 'no-delta', nonCodeShareOfExplained: null }
  }
  const nonCodeAbs = ((m) => (m < 0n ? -m : m))(micro(result.terms.nonCodeSurfaces))
  // Strictly MORE than half: 2 * |nonCode| > total, in integers.
  const dominates = 2n * nonCodeAbs > absTotal
  return {
    verdict: dominates ? 'non-code-dominates' : 'non-code-does-not-dominate',
    nonCodeShareOfExplained: Number(nonCodeAbs) / Number(absTotal),
  }
}

export default defineEventHandler(async (event) => {
  /*
   * global-finops (and platform-admin, which satisfies every gate) ONLY —
   * deliberately NARROWER than the sibling diagnostics probes, which admit a
   * region `admin`.
   *
   * This endpoint is estate-wide and cannot be made region-scoped: §B's Copilot
   * arm is a per-ORG pooled invoice with no teammate and therefore no region, so
   * filtering by region would drop those lanes from §B while §A kept its rows and
   * the residual would go non-zero for a reason that is an artefact of the filter.
   * A decomposition is a statement about a whole estate or it is nothing.
   *
   * That is a constraint on the DATA, not a licence to widen who reads it. A
   * region admin is region-scoped by design, so admitting one here would hand
   * them every other region's money. The earlier version of this handler let
   * `admin` in and explained the cross-region exposure in a comment as though
   * explaining it made it acceptable. When the shape of the data conflicts with
   * the scope of the role, the role loses.
   */
  await requireRole(event, 'global-finops')
  const q = await getValidated(event, querySchema)

  const window = { startIso: monthStartIso(q.from), endIso: monthEndIso(q.to) }

  return withRequestRls(event, async (db) => {
    try {
      /*
       * Deliberately NOT region-scoped, unlike the sibling attribution-gaps
       * probe. §B's Copilot arm is a per-ORG pooled invoice with no teammate and
       * therefore no region; slicing it by region would drop those lanes from §B
       * while §A kept its region-scoped rows, and the residual would be non-zero
       * for a reason that is an artefact of the filter rather than a real gap.
       * A decomposition is a statement about a whole estate or it is nothing.
       * Because it cannot be region-scoped, it is restricted to global-finops
       * (the role gate above) rather than opened to region admins.
       */
      const result = await computeAbDecomposition(db, window)
      const { verdict, nonCodeShareOfExplained } = classifyDecomposition(result)

      /*
       * The cause split behind `diagnostics.unhomedChargeUsd`. A probe that
       * cannot read its split must say "no reading" on that section only, never
       * blind the decomposition above it (the same per-card defensiveness the
       * diagnostics page is built on).
       *
       * WHY A NESTED TRANSACTION AND NOT JUST A try/catch. Everything here runs
       * inside `withRequestRls`'s transaction, and a failed statement ABORTS a
       * PostgreSQL transaction: every command after it returns "current
       * transaction is aborted" until the transaction ends. A bare catch
       * therefore swallows the error and the NEXT read — the visibility grants
       * below — fails anyway, so the endpoint 500s and the containment this
       * comment used to promise never existed. Nothing tested it, which is
       * exactly how a claim like that survives. Nested = SAVEPOINT: drizzle
       * rolls back to it and the enclosing transaction stays usable.
       *
       * The window is the SAME one the decomposition just ran, so the split
       * decomposes the figure the card is already showing rather than a second
       * one computed somewhere else. The history anchors on `to` — the newest
       * month in view — so the selected month is always in the series.
       */
      let unhomed: UnhomedProbeResult | null = null
      let unhomedError: string | null = null
      let unhomedErrorCorrelationId: string | null = null
      try {
        unhomed = await db.transaction(async (sp) => computeUnhomedCauses(sp, window, q.to))
        if (!unhomed.reconciles) {
          // Same bar as the §A/§B residual: a split that does not add back to
          // the figure it decomposes is not a smaller problem than a broken
          // decomposition, and it must not sit silently in a JSON field.
          consola.warn('[ab-decomposition] unhomed split does not reconcile', {
            from: q.from,
            to: q.to,
            residual: unhomed.residualUsd,
          })
        }
      } catch (err) {
        const c = classifyProbeError(err, 'diagnostics:unhomed-causes')
        unhomedError = c.reason
        unhomedErrorCorrelationId = c.correlationId
      }

      /*
       * The POLICY CAPABILITY MATRIX for the ACTIVE mode: what each persona in
       * `REPORT_VISIBILITY_PERSONAS` WOULD be granted under the mode this
       * instance currently runs. Six static personas through `reportGrants` —
       * it reads no teammate, no ownership and no region, so it says nothing
       * about who exists, who holds the role, or whether anyone is watching a
       * given cost centre. The panel labels it as capability for that reason;
       * an earlier version told the operator to judge "who would ever notice"
       * from it, which this cannot answer.
       *
       * Deliberately NOT the three-mode matrix: /admin/policies/report-visibility
       * already renders that, live from the same primitive, and a second copy
       * inside a diagnostics card is a second thing to keep in step.
       */
      const visibilityMode = await getReportVisibilityMode(event, db)
      const visibility = {
        mode: visibilityMode,
        label: REPORT_VISIBILITY_LABELS[visibilityMode],
        description: REPORT_VISIBILITY_DESCRIPTIONS[visibilityMode],
        isDefault: visibilityMode === DEFAULT_REPORT_VISIBILITY_MODE,
        defaultMode: DEFAULT_REPORT_VISIBILITY_MODE,
        personas: REPORT_VISIBILITY_PERSONAS.map((p) => ({
          key: p.key,
          label: p.label,
          scopes: grantsToScopes(
            reportGrants(visibilityMode, { role: p.role, ownsCostCentre: p.ownsCostCentre }),
          ),
        })),
      }

      if (verdict === 'residual-non-zero') {
        // Loud: a non-zero residual means the decomposition has stopped being
        // exhaustive against real data, which is exactly the condition the gate
        // exists to catch. It must not sit silently in a JSON field.
        consola.warn('[ab-decomposition] non-zero residual', {
          from: q.from,
          to: q.to,
          residual: result.residual,
        })
      }

      return {
        reachable: true,
        window: { from: q.from, to: q.to, ...window },
        ...result,
        termOrder: AB_DECOMPOSITION_TERMS,
        verdict,
        nonCodeShareOfExplained,
        unhomed,
        unhomedError,
        unhomedErrorCorrelationId,
        unhomedWorklistCap: UNHOMED_WORKLIST_CAP,
        unhomedHistoryMonths: UNHOMED_HISTORY_MONTHS,
        visibility,
      }
    } catch (err) {
      // Mirrors the sibling diagnostics probes: a failed probe reports itself
      // rather than 500-ing the page, so one bad query never blinds the rest.
      const { reason, correlationId } = classifyProbeError(err, 'diagnostics:ab-decomposition')
      return {
        reachable: false,
        error: reason,
        errorCorrelationId: correlationId,
        window: { from: q.from, to: q.to, ...window },
      }
    }
  })
})
