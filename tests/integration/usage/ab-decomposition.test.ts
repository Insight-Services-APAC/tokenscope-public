// @vitest-environment node
/*
 * §A/§B decomposition TERM-RECOVERY test — the named acceptance test for
 * docs/design/usage-completeness-and-provider-governance.md §1.1, updated for
 * the migration-0101 (Workstream A) cutover: `v_complete_usage` now has a
 * third, ingest-only completeness arm (§3.1, A3), so the non-Code Claude
 * surfaces and `copilot-agent` are genuinely §A-visible for the first time.
 *
 * Asserts:
 *   1. Each term is recovered at EXACTLY its planted (post-cutover) value.
 *   2. residual === 0 (the decomposition is collectively exhaustive).
 *   3. `nonCodeSurfaces` and `copilotAgentUsage` — the two terms that used to
 *      carry the WHOLE gap pre-cutover — now read ZERO: the fix this gate
 *      exists to verify is closing exactly the terms it was built to name.
 *   4. The independent absence/double-count diagnostic pairs
 *      (`nonCodeSurfacesInSectionAUsd`/`Raw`,
 *      `codingAgentInSectionAUsd`/`Raw`) read EQUAL — the two newly-visible
 *      lanes are covered exactly once, not zero times and not twice.
 *   5. A REAL §A > §B case (negative delta) still balances with zero residual.
 *
 * PRE-CUTOVER EVIDENCE (retained — this is WHY Workstream A was approved; see
 * usage-completeness-and-provider-governance.md §1.1's "gate CLOSED" note).
 * Before migration 0101, this same fixture produced §A=$1148, §B=$1341,
 * delta=$193, with `nonCodeSurfaces`=$200 and `copilotAgentUsage`=$12 as PURE
 * §B-side sums (their lanes were structurally absent from every §A arm), and
 * the non-Code term was the single largest contributor to the gap (200 of 357
 * absolute, 56%) — the finding that justified building arm 3. That reading is
 * historical fact about the pre-cutover code, not a target this suite still
 * asserts; the code now always computes the post-cutover form below, on the
 * IDENTICAL fixture.
 *
 * FIXTURE ARITHMETIC (May 2026 — see known-outcome-fixture.ts for plantings;
 * every $ figure below is verified against a live run of `computeAbDecomposition`,
 * not hand-derived):
 *
 *   §A = v_complete_usage in [2026-05-01, 2026-06-01):
 *     arm 1 (attribution NOT quarantined, NOT an ingest-only tool):
 *       alice $350 (05-05) + bob $300 (05-06) + carol $200 (05-07) + bob $60 (05-12)
 *       + bob $50 (05-14, quarantine RESOLVED so it stays in §A)
 *       + bob $30 (05-16, quarantine reason is not api-uncorroborated)
 *       + copilot OTel $6 = $996
 *       alice quarantined $75 (05-09) -> EXCLUDED (open + api-uncorroborated)
 *     arm 2 (unaccounted cost > 0, NOT an ingest-only tool):
 *       dave $50 (cc) + alice $5 (cop) + bob $10 (cop) + erin $17 (cc, unhomed) + carol $11 (cc, 05-26 stale)
 *       + alice $28 (05-20: her OTel that day is quarantined, so the corroborated
 *         OTel the reconciliation nets against is $0 and the full API day
 *         materialises as unaccounted -- this is HOW quarantined-but-corroborated
 *         money returns to §A, and why the quarantine term nets to zero rather
 *         than the money being absent from both sides) = $121
 *       + carol $31 (05-24 chargeback-exempt: the worker does not filter exempt
 *         rows, so this materialises into §A through arm 2 while every §B lane
 *         filters it out -- one-directional, and the term names it) = $152
 *     arm 3 (0101, A3 — ingest-only tools ONLY: non-Code Claude + copilot-agent):
 *       alice $120 claude-ai + bob $80 claude-cowork (both non-exempt)
 *       + alice $19 claude-ai (EXEMPT — arm 3 carries it too; v_teammate_usage_daily's
 *         actual_spend branch has no exempt filter, same as arm 2's worker) = $219
 *       + carol $12 copilot_coding_agent (reconciliation_record, via
 *         v_teammate_usage_daily's copilot branch) = $12
 *       arm 3 TOTAL = $231
 *     §A TOTAL = $996 + $152 + $231 = $1379
 *
 *   §B = v_finance_chargeback_month in [2026-05-01, 2026-06-01), EXCLUDING the
 *   copilot-unclassified lane (never chargeable; see server/reporting/finance.ts):
 *     anthropic arm + copilot license $40 + copilot usage $8
 *     §B TOTAL = $1341 (UNCHANGED — v_finance_chargeback_month's definition did
 *     not change; only §A grew, because arm 3 is new)
 *
 *   DELTA = $1341 - $1379 = -$38 (NEGATIVE post-cutover: arm 3 added more new §A
 *   money than §B has ever billed differently for these lanes, since most of it
 *   is genuine, already-billed non-Code/coding-agent spend that simply had no
 *   §A home before)
 *
 *   The cost-neutral plantings (bob $50, bob $30, erin $17) each add the SAME
 *   amount to §A and §B, so they move neither the delta nor any term. They exist
 *   purely so that dropping a filter changes an answer: without them the
 *   quarantine predicates and the unhomed diagnostic were all unfalsifiable, and
 *   their mutations survived.
 *
 *   TERMS (mutually exclusive, collectively exhaustive):
 *     nonCodeSurfaces = $0    (POST-CUTOVER: a TRUE §B-minus-§A term, not a pure
 *                                 §B sum. §B non-Code = $200 (alice $120 + bob $80,
 *                                 both non-exempt — v_finance_bill_chargeback
 *                                 already filters exempt). §A-equivalent =
 *                                 Σ actual_spend non-Code NOT exempt = $120+$80 =
 *                                 $200 too. $200 − $200 = $0: the lane is now
 *                                 FULLY covered by arm 3, which is the point of
 *                                 shipping it. The exempt $19 is deliberately
 *                                 EXCLUDED from both operands here — it is
 *                                 `chargebackExemptUsage`'s money, not this
 *                                 term's, or it would be double-counted.)
 *     licenceLanes    = $40   (UNCHANGED — copilot-license seat SKUs, a PURE SUM;
 *                                 an idle licensed seat has NO §A counterpart)
 *     copilotAgentUsage = $0  (POST-CUTOVER: TRUE (raw − §A) term. raw = carol's
 *                                 $12 copilot_coding_agent figure, read from
 *                                 v_teammate_usage_daily exactly as before. §A =
 *                                 the SAME $12, now visible through v_complete_usage's
 *                                 arm 3. $12 − $12 = $0: fully covered.)
 *     copilotUsageGap = -$25 (UNCHANGED VALUE, unchanged CODE: its §A operand
 *                                 (copilot-cli + copilot-agent via v_complete_usage)
 *                                 grew by the SAME $12 that copilotAgentUsage
 *                                 shrank by, so `copUsageARow + copilotAgentUsage`
 *                                 — the quantity this term actually subtracts —
 *                                 is unchanged. See the residual-preserving
 *                                 algebra note in ab-decomposition.ts.)
 *     quarantine      = $0    (UNCHANGED — structurally zero, see below)
 *     floor           = -$15  (UNCHANGED -Σ max(0, corroborated OTel - API) per day: bob 05-12)
 *     chargebackExemptUsage = -$50 (POST-CUTOVER: was -$31 (carol's claude-code
 *                                 exempt day only). Migration 0101 narrows this
 *                                 term's exclusion list from
 *                                 [...NON_CODE_CLAUDE_TOOLS, copilot-cli, copilot-agent]
 *                                 to just [copilot-cli, copilot-agent]
 *                                 (=GITHUB_USAGE_TOOLS — the two tools whose §A
 *                                 truth is STILL reconciliation_record, never
 *                                 actual_spend). Alice's $19 exempt claude-ai row
 *                                 (planted as "term-neutral" pre-cutover, since
 *                                 the lane was absent from §A) now reaches §A via
 *                                 arm 3 while still being exempt-filtered out of
 *                                 §B — the identical one-directional shape
 *                                 claude-code has always had. -31 + -19 = -50.)
 *     populationDiff  = $0    (UNCHANGED — FK constraint -> structurally zero)
 *     homingLoss      = $0    (UNCHANGED — LEFT JOIN LATERAL -> structurally zero at global aggregate)
 *     unreconciledApiLag   = $23 (UNCHANGED — carol 05-22 API-only: no OTel row, no
 *                                 unaccounted row -- the worker has not caught up,
 *                                 so §B bills it and §A has nothing. NOT
 *                                 cost-neutral: it moves the delta by its own
 *                                 value, by design.)
 *     unreconciledApiStale = -$11 (UNCHANGED — carol 05-26: $11 of materialised unaccounted
 *                                 usage with no API or OTel behind it -- §A
 *                                 carrying more than the API now reports. Summed
 *                                 SEPARATELY from unreconciledApiLag rather than netted against
 *                                 it: as one signed number these two would report
 *                                 +$12 and neither phenomenon would be visible.)
 *     Σ terms = 0 + 40 + 0 - 25 + 0 - 15 - 50 + 0 + 0 + 23 - 11 = -$38 = delta ✓
 *
 *   Note the bookkeeping moved, not the money: pre-cutover, `nonCodeSurfaces` +
 *   `chargebackExemptUsage`'s non-Code share (0, excluded then) summed to $200.
 *   Post-cutover, `nonCodeSurfaces` (0) + `chargebackExemptUsage`'s non-Code
 *   share ($19, included now) covers the exempt row that used to reach neither
 *   side, and the non-exempt $200 is now fully matched on both sides (§A via
 *   arm 3, §B via the bill) rather than one-sided. Total money named is
 *   unchanged; WHERE it is named, and whether it nets to zero, changed exactly
 *   as designed.
 *
 *   DIAGNOSTICS (not delta terms):
 *     unhomedChargeUsd    = $17 (erin's §B money has no cost-owning ancestor, so it
 *       sits in the §B global total but vanishes from every per-cost-centre bucket)
 *     quarantinedOtelUsd  = $103 (alice's disowned OTel: $75 forged + $28 with
 *       same-day API truth -- real money an operator
 *       must see, which is why it cannot live in a term pinned at zero)
 *     codingAgentInSectionAUsd = codingAgentRawUsd = $12 (INDEPENDENT of the
 *       `copilotAgentUsage` term above and its own residual entry: reads
 *       v_complete_usage and v_teammate_usage_daily directly. EQUAL ⇒ the lane
 *       is covered exactly once. Unequal would mean absent (less) or
 *       double-counted (more) — see ab-decomposition.ts's diagnostics doc.)
 *     nonCodeSurfacesInSectionAUsd = nonCodeSurfacesRawUsd = $219 (the SAME
 *       independent pair for the non-Code lane — deliberately UNFILTERED by
 *       chargeback_exempt on both sides, unlike the `nonCodeSurfaces` term, so
 *       it verifies arm 3's TOTAL coverage including the exempt row.)
 *
 *   WHY QUARANTINE IS ZERO AND FLOOR EXCLUDES QUARANTINED OTEL:
 *     An earlier version of this header defended the opposite arrangement:
 *     quarantine at +$75, floor at -$90 (including the same $75), on the grounds
 *     that "making the terms mutually exclusive at the ROW level would break the
 *     arithmetic identity". That was wrong, and the residual could not show it --
 *     the two entries cancelled, so the identity held either way.
 *
 *     What it did break was the verdict. The absolute total the dominance test
 *     divides by was inflated by $150 of pure cancellation, pushing the non-Code
 *     share from 200/291 (69%, dominates) to 200/438 (46%, does not). The gate's
 *     answer was an artefact of a double-count.
 *
 *     The arithmetic, per (teammate, day) for claude-code, with corroborated =
 *     OTel excluding quarantined rows (which is what the reconciliation nets
 *     against, see server/usage/unaccounted-reconciliation.ts):
 *
 *       §A = corroborated + max(0, API - corroborated) = max(corroborated, API)
 *       §B = API
 *       δ  = API - max(corroborated, API) = -max(0, corroborated - API)  = floor
 *
 *     Quarantined money reaches neither side: it has left §A arm 1, the
 *     reconciliation excludes it from arm 2, and a forged session has no
 *     actual_spend so it is absent from §B. Its contribution to the delta is nil,
 *     so the term is pinned at zero and the quantity moves to diagnostics.
 *
 * MUTATION-VERIFIED, by hand rather than by a harness: there is no mutation-testing
 * tool wired into this repo, so the evidence is a reviewer re-running the procedure,
 * not a stored artefact. The procedure, so it can be repeated: revert one piece of
 * the logic an assertion guards, run
 *   CI=true NO_COLOR=1 npx vitest run tests/integration/usage/ab-decomposition.test.ts
 * confirm it FAILS, then restore. A semantic no-op edit was run as a control each
 * round to prove the harness reports honestly. Mutations killed this way: the
 * licence-lane catch-all, the v_finance_bill_chargeback §B trap, both copilotUsageGap
 * lane filters, the coding-agent category filter, the floor sign, a silently-dropped
 * residual term, the non-Code tool list, both quarantine filters, the shared
 * corroborated-OTel quarantine exclusion, and both unhomed-diagnostic mutations.
 *
 * KNOWN SURVIVOR RESOLVED (mig 0101). This block used to disclose that
 * reverting `copilotAgentUsage` from its pure sum back to
 * `(provider − v_complete_usage)` could not fail this test, because migration
 * 0086 kept the coding-agent lane out of `v_complete_usage` BY CONSTRUCTION, so
 * the subtrahend was structurally $0 and the two forms agreed on every
 * reachable input. That is no longer true: `copilotAgentUsage` now IS exactly
 * that subtraction (`codingAgentRawUsd − codingAgentInSectionAUsd`), because
 * arm 3 (migration 0101) makes the second operand a real, live quantity rather
 * than a structural zero. Reverting it to a pure sum NOW fails this test
 * outright — `copilotAgentUsage` would read $12 instead of the asserted $0, and
 * the residual would move by $12. The disclosure is retained, past tense,
 * because the reasoning for why the OLD form was a survivor (and why it was
 * fixed by adding a diagnostic rather than by "cleverness") is exactly the
 * reasoning that makes the NEW form safe — see `diagnostics.codingAgentRawUsd`
 * and `codingAgentInSectionAUsd`, which remain the independent, non-summed
 * pair that would catch an absence or double-count even if this term's own
 * arithmetic were somehow wrong.
 *
 * KNOWN SURVIVORS — stated, not hidden. `populationDifference` and `homingLoss`
 * are provably $0 at this grain (an FK forbids the first, a LEFT JOIN cannot drop
 * rows for the second), so hardcoding them to zero is indistinguishable from
 * computing them and this test CANNOT tell the difference. They are kept computed
 * so a future FK relaxation or soft-delete surfaces here instead of silently
 * inflating the residual, and `homingLoss`'s real operator-facing quantity is
 * asserted through `diagnostics.unhomedChargeUsd` instead, which IS non-zero and
 * IS mutation-verified.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { seedKnownOutcomeCompany, seedAbDecompositionPlantings, type KnownOutcomeIds, KO_MAY_WINDOW } from '../helpers/known-outcome-fixture'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../../drizzle/schema'
import { computeAbDecomposition } from '../../../server/usage/ab-decomposition'

let t: TestDb
let ids: KnownOutcomeIds

beforeAll(async () => {
  t = await startTestDb()
  ids = await seedKnownOutcomeCompany(t)
  await seedAbDecompositionPlantings(t, ids)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('§A/§B decomposition — term recovery', () => {
  it('recovers each term at its planted (post-cutover) value and residual is zero', async () => {
    const result = await computeAbDecomposition(t.db, {
      startIso: KO_MAY_WINDOW.startIso,
      endIso: KO_MAY_WINDOW.endIso,
    })

    // §A grew by arm 3's $231 (mig 0101, A3): 1148 (pre-cutover) + 219 (non-Code,
    // incl. the $19 exempt row) + 12 (copilot-agent) = 1379.
    expect(result.sectionA).toBe('1379.000000')
    // §B EXCLUDES the copilot-unclassified lane ($3), matching the product's own
    // chargeable definition (server/reporting/finance.ts). UNCHANGED by 0101 —
    // arm 3 only ever adds to §A. If this reads 1344 the exclusion has been lost
    // and the card's "Chargeable (§B)" disagrees with every finance surface.
    expect(result.sectionB).toBe('1341.000000')
    // NEGATIVE post-cutover: arm 3 made §A exceed §B for the first time in this
    // fixture, because most of arm 3's money is genuine spend that was always
    // billed (§B) but never had a §A home before.
    expect(result.delta).toBe('-38.000000')

    /*
     * nonCodeSurfaces: the term this whole gate exists to close. POST-CUTOVER it
     * is a TRUE (§B − §A) subtraction, not the pre-cutover pure §B sum, and it
     * reads ZERO: §B non-Code ($200, alice $120 + bob $80, both non-exempt) −
     * §A-equivalent (Σ actual_spend non-Code NOT exempt = $200) = $0. The lane is
     * FULLY covered by arm 3. Reads 200 if the term has reverted to the
     * pre-cutover pure-§B-sum shape (arm 3 never subtracted); reads a non-zero
     * value other than 0 if arm 3 itself has a genuine coverage gap.
     */
    expect(result.terms.nonCodeSurfaces).toBe('0.000000')
    // A PURE SUM of the licence lane, UNCHANGED by 0101 (no §A counterpart
    // exists for a fixed licence charge, cutover or not). If this ever equals
    // the old catch-all value (25 = 40 − 15) the subtraction has crept back in.
    expect(result.terms.licenceLanes).toBe('40.000000')
    /*
     * copilotAgentUsage: the OTHER term this gate exists to close. POST-CUTOVER
     * it is TRUE (raw − §A) — `codingAgentRawUsd` ($12, from
     * v_teammate_usage_daily, exactly as pre-cutover) minus `codingAgentInSectionAUsd`
     * ($12, now visible via v_complete_usage's arm 3) — and reads ZERO: fully
     * covered. Reads 12 if arm 3 has stopped covering the lane (a regression to
     * the pre-cutover shape); reads a large negative value if the lane is being
     * double-counted (§A exceeding the raw provider figure, which should be
     * structurally impossible — see the independent diagnostics below).
     */
    expect(result.terms.copilotAgentUsage).toBe('0.000000')
    /*
     * The independent absence/double-count diagnostic pairs (§3.1, "independent
     * alarms assert those lanes are present in §A exactly once"). Each pair
     * reads v_complete_usage vs its raw source DIRECTLY — outside the summed
     * terms, so neither can be masked by a compensating error elsewhere the way
     * a term-only check could be. EQUAL ⇒ covered exactly once (healthy). A
     * mismatch here — even with `copilotAgentUsage`/`nonCodeSurfaces` both still
     * reading their planted zero via some unrelated cancellation — is the signal
     * an operator must act on.
     */
    expect(result.diagnostics.codingAgentInSectionAUsd).toBe('12.000000')
    expect(result.diagnostics.codingAgentRawUsd).toBe('12.000000')
    expect(result.diagnostics.nonCodeSurfacesInSectionAUsd).toBe('219.000000')
    expect(result.diagnostics.nonCodeSurfacesRawUsd).toBe('219.000000')
    /*
     * The REMAINDER once the coding-agent lane is named — UNCHANGED VALUE across
     * the cutover, and unchanged CODE: its §A operand (copilot-cli + copilot-agent
     * via v_complete_usage) grew by the same $12 arm 3 now contributes, and
     * copilotAgentUsage shrank by the same $12, so the quantity this term
     * actually subtracts (`copUsageARow + copilotAgentUsage`) is identical
     * before and after. See the residual-preserving algebra note in
     * ab-decomposition.ts. Reads -13 if the coding-agent lane has been folded
     * back in (silently absorbed rather than named); reads -22 if the
     * unclassified lane ($3) has crept into the §B side.
     */
    expect(result.terms.copilotUsageGap).toBe('-25.000000')
    /*
     * Quarantine is pinned at ZERO and floor carries only the genuine excess.
     * These two assertions are a matched pair and must be read together.
     * UNCHANGED by the 0101 cutover (claude-code, not an ingest-only tool).
     *
     * Previously quarantine was +75 and floor was -90, and the residual still
     * closed: floor was summing the same quarantined rows the quarantine term
     * counted, with the opposite sign. The pair cancelled invisibly.
     *
     * If quarantine ever reads 75 again, or floor reads -90, that double-count is
     * back.
     */
    expect(result.terms.quarantine).toBe('0.000000')
    expect(result.terms.floor).toBe('-15.000000')
    /*
     * Chargeback-exempt spend: in §A (the worker/arm-3 source does not filter
     * it) and out of §B (every lane does). POST-CUTOVER this is -50, not -31:
     * migration 0101 narrows the exclusion list from
     * [...NON_CODE_CLAUDE_TOOLS, copilot-cli, copilot-agent] to just
     * [copilot-cli, copilot-agent] (GITHUB_USAGE_TOOLS — the two tools whose §A
     * truth is STILL reconciliation_record, never actual_spend), so alice's
     * planted $19 exempt claude-ai row (pre-cutover "term-neutral", since the
     * lane was absent from §A) is now counted alongside carol's $31 exempt
     * claude-code day. -31 + -19 = -50.
     *
     * Reads -31 if the exclusion list has not been narrowed (a regression to
     * pre-cutover scope — the non-Code exempt row is missed). Reads -63 (31+19+13)
     * if the copilot-cli exempt row ($13, planted precisely to stay excluded)
     * has been swept in too — that money still reaches NEITHER side (its §A
     * truth is reconciliation_record).
     */
    expect(result.terms.chargebackExemptUsage).toBe('-50.000000')
    expect(result.terms.populationDifference).toBe('0.000000')
    expect(result.terms.homingLoss).toBe('0.000000')

    // The reconciliation-lag term pair, UNCHANGED by 0101 (claude-code only).
    /*
     * The two directions, asserted as a PAIR. A single signed number computed
     * from two estate-wide aggregates reports +12 here (23 - 11) and BOTH of
     * these fail. That is the only reason the split is verifiable at all: the
     * sum is identical, so the residual, the delta, and the gate's verdict
     * cannot tell the two implementations apart.
     */
    expect(result.terms.unreconciledApiLag).toBe('23.000000')
    expect(result.terms.unreconciledApiStale).toBe('-11.000000')

    // Residual MUST be exactly zero — the decomposition is still exhaustive
    // after the cutover changed the sign of the delta and the shape of two terms.
    expect(result.residual).toBe('0.000000')

    expect(result.diagnostics.unhomedChargeUsd).toBe('17.000000')
    // The quarantined OTel that used to masquerade as a delta term. It is real
    // money and an operator must still see it, so a pinned-zero term cannot be
    // where it lives. Non-zero here, and therefore falsifiable. UNCHANGED by 0101.
    expect(result.diagnostics.quarantinedOtelUsd).toBe('103.000000')
  })

  /*
   * THE OTHER STATE OF THE EXEMPT TERM, which the fixture cannot plant.
   *
   * `chargebackExemptUsage` claims to be correct whether or not the
   * reconciliation worker has caught up. The fixture plants only the
   * MATERIALISED state (actual_spend + its unaccounted_usage row), so the second
   * half of that claim was carried by a comment and by nothing else. A promise a
   * comment makes and no test keeps is the class this module has been bitten by
   * before.
   *
   * Not-yet-materialised: an exempt API row with no unaccounted_usage and no
   * OTel behind it. §A cannot see it through either arm, and §B drops it for
   * being exempt, so the DELTA does not move. The two terms must move in equal
   * and opposite directions: `unreconciledApiLag` rises, because from its point
   * of view this is an API row the worker has not homed yet, and
   * `chargebackExemptUsage` falls by the same amount and cancels it exactly.
   *
   * The test cleans up after itself: the suite shares one database, and a
   * planting left behind here would silently change the assertions above.
   */
  it('cancels exactly when the exempt row has NOT been materialised yet', async () => {
    const before = await computeAbDecomposition(t.db, KO_MAY_WINDOW)

    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
      VALUES (${ids.dave}::uuid, '2026-05-28'::date, 'claude-code', 9000, 8000, 17, 'anthropic-analytics-api', true)`
    try {
      const after = await computeAbDecomposition(t.db, KO_MAY_WINDOW)

      // Neither side sees the money, so the gap itself is unchanged.
      expect(after.sectionA).toBe(before.sectionA)
      expect(after.sectionB).toBe(before.sectionB)
      expect(after.delta).toBe(before.delta)

      // The two terms move by the same $17 in opposite directions.
      expect(Number(after.terms.chargebackExemptUsage)).toBeCloseTo(
        Number(before.terms.chargebackExemptUsage) - 17,
        6,
      )
      expect(Number(after.terms.unreconciledApiLag)).toBeCloseTo(
        Number(before.terms.unreconciledApiLag) + 17,
        6,
      )

      // The point: exhaustiveness survives the un-caught-up state.
      expect(after.residual).toBe('0.000000')
    } finally {
      await t.client`DELETE FROM actual_spend WHERE teammate_id = ${ids.dave}::uuid AND date = '2026-05-28'::date`
    }
  })

  it('handles §A > §B (healthy direction) with a real negative delta', async () => {
    /*
     * June holds $40 of claude-code OTel with no actual_spend counterpart, so §A
     * genuinely exceeds §B and the delta is NEGATIVE.
     *
     * This test used to run against an empty June where every figure was $0. It
     * asserted a signed delta without ever creating one: all negative-delta
     * handling could have been deleted and it would still have passed. A test
     * that cannot fail is not evidence.
     */
    const result = await computeAbDecomposition(t.db, {
      startIso: '2026-06-01T00:00:00.000Z',
      endIso: '2026-07-01T00:00:00.000Z',
    })

    // 56 = the $40 uncountered OTel + the $9 day-boundary row + the $7 month-
    // boundary row; §B sees the $9 and the $7, both billed. The delta stays -40
    // because both of those pairs net on both sides.
    expect(result.sectionA).toBe('56.000000')
    expect(result.sectionB).toBe('16.000000')
    expect(result.delta).toBe('-40.000000')
    // The floor must carry the WHOLE negative delta: §A keeps OTel that §B never
    // bills because the reconciliation floors the difference at zero.
    expect(result.terms.floor).toBe('-40.000000')
    expect(result.residual).toBe('0.000000')
  })

  /*
   * Money must not depend on where the database thinks it is sitting.
   *
   * The module bins OTel days with `(ts_event AT TIME ZONE 'UTC')::date` so it
   * agrees with `actual_spend.date`, which is a bare `date` and therefore
   * already UTC-shaped. A bare `ts_event::date` casts in the SESSION TimeZone
   * instead, and every day-grain term (floor, the unreconciled-API pair, and the
   * shared corroborated-OTel CTE they both use) then disagrees with the API
   * side at every day boundary.
   *
   * That is not a hypothetical: the bug shipped twice and was corrected twice,
   * and both times the suite stayed green, because a test that only ever runs
   * on a UTC server cannot see it. The fixture's 22:00Z row is what makes a
   * wrong day cast disagree.
   *
   * BOTH SIGNS OF OFFSET, and the second one is not padding. The month-boundary
   * casts (`${startIso}::date`) can only misbehave at a NEGATIVE offset, where a
   * cast that consults TimeZone rolls 2026-06-01T00:00Z back to 05-31 and drags
   * the previous month's §B into the window. A UTC+14-only test cannot see that.
   *
   * The current form is safe, and the reasoning is worth pinning because a
   * review flagged it as unsafe. `${startIso}` binds as TEXT, and Postgres
   * parses text->date from the date fields directly without consulting TimeZone.
   * Measured on this driver at UTC-11 (Pacific/Midway):
   *
   *     ${iso}::date                                  -> 2026-05-01   safe
   *     (${iso}::timestamptz AT TIME ZONE 'UTC')::date -> 2026-05-01   safe, redundant
   *     (${iso}::timestamptz)::date                    -> 2026-04-30   BROKEN
   *
   * So the review's proposed remedy is harmless but unnecessary; its premise
   * (that the current form is timezone-dependent) does not hold. The form that
   * genuinely breaks is the middle one WITHOUT its `AT TIME ZONE 'UTC'`, which
   * is one careless edit away from either of the others. That is the real risk
   * here, and it is what this test exists to catch — reproducibly, rather than
   * as a claim in a review thread.
   */
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Midway']) {
    it(`gives the same answer on a server whose session TimeZone is ${tz}`, async () => {
      const tzClient = postgres(t.url, {
        max: 1,
        idle_timeout: 5,
        connection: { TimeZone: tz },
      })
      try {
        const [{ tz: actual }] = await tzClient<
          { tz: string }[]
        >`SELECT current_setting('TimeZone') AS tz`
        // Guard the guard: if the startup parameter were ignored this test would
        // pass by running at UTC, proving nothing.
        expect(actual).toBe(tz)

        const tzDb = drizzle(tzClient, { schema })
        const shifted = await computeAbDecomposition(tzDb, {
          startIso: '2026-06-01T00:00:00.000Z',
          endIso: '2026-07-01T00:00:00.000Z',
        })

        // A month cast that slipped a day would pull May's much larger §B into
        // this window, so these two numbers are the month-boundary assertion.
        expect(shifted.sectionA).toBe('56.000000')
        expect(shifted.sectionB).toBe('16.000000')
        expect(shifted.delta).toBe('-40.000000')
        // The assertion that bites on day binning: a session-timezone cast
        // splits the 06-15 pair across two day bins and the floor deepens.
        expect(shifted.terms.floor).toBe('-40.000000')
        expect(shifted.terms.unreconciledApiLag).toBe('0.000000')
        expect(shifted.terms.unreconciledApiStale).toBe('0.000000')
        expect(shifted.residual).toBe('0.000000')
      } finally {
        await tzClient.end({ timeout: 5 })
      }
    })
  }
})
