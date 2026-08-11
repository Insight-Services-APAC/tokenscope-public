/*
 * unhomed-causes — the named reasons chargeable (§B) spend reaches no
 * cost-owning unit.
 *
 * Shared const so the probe (server/usage/unhomed-causes.ts), the diagnostics
 * card and the tests cannot drift on the list or its order — the same discipline
 * ab-decomposition-terms.ts applies to the §A/§B terms, and for the same reason:
 * adding a cause must be a compile error in every consumer, not a silently
 * missing row on one surface.
 *
 * MUTUALLY EXCLUSIVE and COLLECTIVELY EXHAUSTIVE. None is computed as "the total
 * minus the others", and there is deliberately no FIFTH, catch-all bucket:
 * whatever the four do not explain is the RESIDUAL, which must be zero and is
 * the only signal that says the split is still exhaustive against real data. A
 * catch-all fifth bucket would guarantee a zero residual and destroy that
 * signal.
 *
 * `no-cost-owning-ancestor` IS the remainder of the per-teammate arm, and this
 * header says so rather than claiming a partition it does not have. The three
 * placement causes are structurally exhaustive over that arm (see
 * server/usage/unhomed-causes.ts), so the third is "neither of the first two" —
 * written out as a positive predicate that MIRRORS the chargeback view's
 * ancestor rule, which is a drift detector, not an independent test.
 *
 * A ZERO RESIDUAL PROVES THE CAUSES ADD UP, and nothing more. It cannot detect
 * a dollar in the WRONG cause: moving one between two causes leaves the sum
 * unchanged. The panel copy says this out loud.
 *
 * The first three are PLACEMENT failures on PEOPLE — three different failures,
 * three different fixes, three different owners. The fourth is not a placement
 * failure at all: pooled invoice money is an explicit, designed residual with
 * its own remediation surface, and placing people cannot move a cent of it.
 *
 * THE FOURTH IS COPILOT-ONLY, and it is named for what it measures rather than
 * for the general case it does not. It reads `copilot_pool_bill` and
 * `copilot_overage_allocation` and mirrors migration 0107's GitHub-specific
 * allocation semantics; nothing here generalises to a second pooled provider.
 * A pooled arm added to `v_finance_chargeback_month` for another provider would
 * land in the RESIDUAL — which is the designed behaviour (the split says it has
 * stopped being exhaustive and suppresses itself) but is NOT the same thing as
 * covering it. It was called `pooled-provider`, which promised exactly that.
 *
 *   no-region               The platform could not place the person in ANY
 *                           region: no directory match, no manager chain, no
 *                           billing region. They sit in the system-wide holding
 *                           region, so their spend reaches no region's report
 *                           and no cost centre.
 *   region-no-unit          The region is known; the unit is not. They sit on
 *                           their own region's holding node, which is
 *                           deliberately not cost-owning, so their spend reaches
 *                           the region and stops there.
 *   no-cost-owning-ancestor They are in a REAL unit, but neither it nor anything
 *                           above it — at any depth — is both cost-owning and
 *                           active. The tree is fine; the ownership flag is
 *                           missing, or the unit that carried it was retired.
 *   pooled-copilot          COPILOT invoice lines billed to the enterprise as a
 *                           pool rather than to a person, whose provider
 *                           organisation is not homed to a cost-owning unit.
 *                           Copilot only — see above.
 */
export const UNHOMED_CAUSES = [
  'no-region',
  'region-no-unit',
  'no-cost-owning-ancestor',
  'pooled-copilot',
] as const

export type UnhomedCause = (typeof UNHOMED_CAUSES)[number]
