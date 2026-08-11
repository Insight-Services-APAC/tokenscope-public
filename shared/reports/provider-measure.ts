/*
 * reports/provider-measure — what `provider_usage_fact.cost_usd` MEANS, per
 * provider. The single authority for the one question every billed figure has
 * to answer before it adds anything up.
 *
 * ── THE FACT ─────────────────────────────────────────────────────────────────
 *
 * `provider_usage_fact` is the NORMALISED provider lane: one row shape, both
 * providers, `provider` as the discriminator (mig 0118:44-45 — `provider text
 * NOT NULL`, no CHECK on the value). What it does NOT have is one meaning for
 * its money column. Migration 0120 states it on the table itself:
 *
 *   anthropic — the amount the provider CHARGED for this (model, cost_type).
 *               Billed money. Conserved against `actual_spend`.
 *   github    — gross AI-credit CONSUMPTION valued at the provider's own credit
 *               rate, BEFORE the pooled allowance. Not an invoice figure, and
 *               not expected to equal `copilot_pool_bill`, which is the actual
 *               Copilot bill: POOLED per (org, sku, month) and NET.
 *
 * So `SUM(cost_usd)` over the table adds billed dollars to consumption dollars.
 * Migration 0120's own words: "A blind SUM over the whole table ... is not a
 * figure anyone is owed." This module is what makes discriminating cheap enough
 * that nobody skips it.
 *
 * ── WHY A MODULE AND NOT AN `IF` AT EACH CALL SITE ───────────────────────────
 *
 * Because the last time this rule lived in more than one place, the two copies
 * drifted. `fetchTierExposure` already holds its own provider split (its
 * `kindFor`, answering a NEIGHBOURING question — "does this provider send money
 * at MODEL grain?"), and the two questions have the same answer today for the
 * same underlying reason. They are deliberately not merged: `kindFor` decides
 * whether money may be BANDED, this decides whether money may be called BILLED,
 * and a provider could one day send model-grain consumption. What they must
 * never do is disagree about which provider meters consumption — which is what
 * `tests/unit/shared/provider-measure.test.ts` pins.
 *
 * ── HOW A THIRD PROVIDER LANDS ───────────────────────────────────────────────
 *
 * By being added to {@link CONSUMPTION_PROVIDERS} if — and only if — a WIRE
 * CAPTURE shows it meters consumption rather than charges. The default is
 * `'billed'` deliberately: a provider whose money is genuinely billed and gets
 * mis-defaulted to consumption disappears from the billed headline, which is a
 * silent understatement. The reverse error is loud (a figure that does not
 * reconcile to the invoice). Never decide this from a Zod schema — decide it
 * from `docs/design/provider-wire-captures/`.
 *
 * Pure types + one const array + two pure functions, no deps — safe on both
 * sides of the wire (`#shared/reports/provider-measure`).
 */

/**
 * What a provider's `cost_usd` is.
 *
 *  - `'billed'`      — the provider charged this. It may be labelled billed, it
 *                      may foot a chargeback figure, and it renders as a hard
 *                      dollar.
 *  - `'consumption'` — the provider METERED this; the bill for it is somewhere
 *                      else and at a different grain. It is informational, it
 *                      may never be added to a billed total, and it renders
 *                      muted (`SpendClass` `'pooled-usage'`).
 */
export type BilledMeasure = 'billed' | 'consumption'

/**
 * What ONE reporting ARM's money is — a superset of {@link BilledMeasure},
 * because the chargeback lane has a second SOURCE that this module's question
 * ("what does `provider_usage_fact.cost_usd` mean?") does not reach.
 *
 *  - `'pooled-chargeback'` — the provider's actual NET INVOICE, raised POOLED at
 *    a cost-owning unit rather than per person. For Copilot that is
 *    `copilot_pool_bill` read through `v_finance_copilot_pool_chargeback` (mig
 *    0107): licences plus net overage, homed to the CoU by the org→CoU map.
 *
 * IT IS A CHARGE, so it foots the chargeback headline at the axes that HOME it
 * — and it exists at NO other axis, which is exactly why it is a named measure
 * rather than folded into `'billed'`. `'billed'` money is per-teammate provider
 * truth and can be re-grouped onto any dimension the fact table carries; pooled
 * chargeback cannot be re-grouped at all. A reader (or a CSV) that cannot tell
 * the two apart has no way to know why the teammate axis is Anthropic-only.
 */
export type ArmMeasure = BilledMeasure | 'pooled-chargeback'

/**
 * Whether an arm's money may foot a CHARGEBACK headline.
 *
 * The predicate, not a `=== 'billed'` comparison at each call site: adding
 * `'pooled-chargeback'` to the union without this would have left every existing
 * comparison silently excluding the Copilot invoice, which is the understatement
 * direction — a cost centre's chargeback figure missing its largest line with
 * nothing on screen saying so.
 */
export function isChargeMeasure(measure: ArmMeasure): boolean {
  return measure === 'billed' || measure === 'pooled-chargeback'
}

/**
 * How a row of this measure must READ — the single mapping from measure to
 * `SpendClass`, so a ranked row and an export remainder row can never disagree
 * about whether the same money is a charge.
 *
 * A charge renders as a hard dollar (`'billed'`); metered consumption renders
 * muted under `'pooled-usage'`, which already says precisely the right thing
 * ("informational only, billing is POOLED per cost-centre — never a per-user
 * charge").
 */
export function spendClassForMeasure(measure: ArmMeasure): 'billed' | 'pooled-usage' {
  return isChargeMeasure(measure) ? 'billed' : 'pooled-usage'
}

/**
 * The providers whose `cost_usd` is CONSUMPTION, not a charge.
 *
 * `github` is here on observed evidence, not inference
 * (`docs/design/provider-wire-captures/2026-08-02-provider-wire-shape.json`):
 * `ai_credits_used` is GitHub's own "AI credits consumption data", gross and
 * before the included allowance, sitting at the record root at day grain. The
 * authoritative Copilot BILL is `copilot_pool_bill` (mig 0080) at (org, sku,
 * month) — pooled and net — and there is no per-user invoice figure at all.
 */
export const CONSUMPTION_PROVIDERS = ['github'] as const

/** What `provider_usage_fact.cost_usd` means for `provider`. */
export function providerMeasure(provider: string): BilledMeasure {
  return (CONSUMPTION_PROVIDERS as readonly string[]).includes(provider)
    ? 'consumption'
    : 'billed'
}

/**
 * The reader-facing sentence for a consumption arm — WHY its money sits beside
 * the billed total instead of inside it.
 *
 * It names OUR reading of the provider's figure, not a deficiency of the
 * provider: GitHub reports per-user consumption faithfully and bills the pool.
 * Copy that said "Copilot does not report what it charges you" would blame the
 * provider for a grain mismatch that is simply how the product is sold.
 */
export const CONSUMPTION_NOTES: Readonly<Record<string, string>> = {
  github:
    'Copilot consumption, not a charge — gross AI credits before the included allowance. The Copilot bill is pooled per Business Unit, so this is never added to a billed total.',
}

/** {@link CONSUMPTION_NOTES} for `provider`, or a generic form for a new arm. */
export function consumptionNote(provider: string): string {
  return (
    CONSUMPTION_NOTES[provider] ??
    `${provider} consumption, not a charge — metered usage whose bill is raised at a different grain. Never added to a billed total.`
  )
}
