/*
 * model-attribution — the shared key/label/classification rule for a driver
 * row on the MODEL axis whose `model` dimension is NULL
 * (docs/design/reporting-consolidation/07-model-axis-subtraction-build.md,
 * owner ruling 2026-08-04).
 *
 * ── THE SUBTRACTION IS SANCTIONED, AND IT CONSERVES ─────────────────────────
 *
 * A fill day's model split is `cap(API_model − OTel_model)` — a subtraction of
 * two OBSERVED operands, computed at write time by
 * server/usage/unaccounted-reconciliation.ts and stored as
 * `unaccounted_usage_model` children (mig 0123). Both operands exist:
 * `provider_usage_fact` carries per-model cost AND token rows, and
 * `attribution_record.model` is NOT NULL. An earlier revision of this header
 * argued "a residual cannot carry a model breakdown"; that reasoned from
 * `unaccounted_usage`'s (teammate, day, tool) grain — a fact about mig 0071,
 * not about the sources — and is superseded by the owner ruling.
 *
 * THE WORKED EXAMPLE SURVIVES AS THE CAP'S RATIONALE, not as a prohibition:
 *
 *   API {opus:10, sonnet:10}, OTel {opus:15, sonnet:0}
 *     per-tool residual   = max(0, 20−15) =  5
 *     per-model floors    = max(0,10−15) + max(0,10−0) = 10
 *
 * Per-model flooring ALONE overstates the bill — which is exactly why the
 * writer walks models in descending floored order and allocates
 * `min(floored, R_remaining)` (D3): a named cell is its observed subtraction,
 * or that subtraction truncated in a drift case, never inflated. So
 * `OTel + Σ children = API total` holds per key, and tagging still cannot
 * double-count. Conservation is kept by the CAP, not by refusing the split.
 *
 * ── EVERY NULL-MODEL ROW IS A REMAINDER, TYPED BY ITS REASON ────────────────
 *
 * After mig 0124 the view emits named-model rows plus AT MOST ONE reason-typed
 * remainder per key (`v_complete_usage.model_gap_reason`):
 *
 *   'provider-day-grain'       — the key's money is github day-grain money
 *                                (mig 0120's CHECK: Copilot sends no per-model
 *                                dollars). Structural; never heals.
 *   'awaiting-provider-detail' — no cost-bearing provider facts have landed
 *                                for the key yet (fact cadence vs the 2h
 *                                reconcile). Transient; heals itself.
 *   'provider-revision-drift'  — the provider revised the day down before its
 *                                per-model facts refreshed; the day is
 *                                reported whole until they do (r1-H3).
 *                                Transient; heals itself.
 *   'unmodelled-provider-cost' — model-less provider cost left Σ children
 *                                short of the arm-2 parent (model is nullable
 *                                on cost rows beyond the github case).
 *   'surface-remainder'        — the ingest-only (arm 3) analogue: the part
 *                                of a surface day the facts did not model.
 *
 * A remainder is a statement about the ranking's REACH, never a competitor in
 * it: the Top-models card renders remainders as a one-line coverage footer,
 * not as category rows (D6). Classification is DEFAULT-SAFE by construction —
 * an unrecognised or absent reason still classifies as a remainder, so a new
 * reason value can never sneak a pseudo-model row back onto the card.
 *
 * ── THE BILLED LANE'S OWN NULL-MODEL FACT ───────────────────────────────────
 *
 * The chargeback lane reads `provider_usage_fact` directly
 * (server/reporting/engine/billed-axis.ts); a NULL model THERE is a grain the
 * provider itself reported without one ({@link BILLED_NO_MODEL_KEY}) and never
 * one of the reasons above. It classifies as a remainder all the same, and
 * gets the same footer treatment.
 *
 * Every NULL-model bucket on any surface MUST be keyed/labelled through this
 * module rather than a bare `?? 'Unattributed'` fallback. This is the single,
 * reusable place the rule lives — do not hand-copy the branch into a new
 * report.
 */
import { isProviderUsageProvenance } from '../usage/provenance'

/**
 * The reason vocabulary `v_complete_usage.model_gap_reason` (mig 0124) emits.
 * The classifier does NOT trust this list to be complete — an unknown reason
 * is still a remainder — but the footer wording and the notes key off it.
 */
export const MODEL_GAP_REASONS = [
  'provider-day-grain',
  'awaiting-provider-detail',
  'provider-revision-drift',
  'unmodelled-provider-cost',
  'surface-remainder',
] as const
export type ModelGapReason = (typeof MODEL_GAP_REASONS)[number]

/**
 * The generic remainder label (arm-2 shortfall and any NULL-model row with no
 * recognised reason): spend that carries no model name after everything
 * measured with one has been named. Semantics NARROWED by the 2026-08-04
 * ruling: this is a remainder, not a claim that a split is impossible — the
 * named rows beside it ARE the split.
 *
 * The constant keeps its name so existing call sites and tests keep pointing
 * at the same bucket; only what the word covers has shrunk.
 */
export const UNATTRIBUTED_MODEL_LABEL = 'Not split by model'

/**
 * The ingest-only surface remainder's label (arm 3, 'surface-remainder').
 * Narrowed the same way: after mig 0124 this lane DOES carry the models the
 * provider reports — this label now covers only the model-less residue of a
 * surface day, not the surface's whole spend.
 */
export const PROVIDER_USAGE_MODEL_LABEL = 'Model not captured for this surface'

/** Reason-specific remainder labels. Fallbacks (unknown/absent reason) go
 *  through the provenance branch in {@link modelDriverLabel}. */
export const MODEL_GAP_REASON_LABELS: Record<ModelGapReason, string> = {
  // The github fact grain — day money, model-less by the provider's own shape.
  'provider-day-grain': 'Copilot day-grain money',
  'awaiting-provider-detail': 'Awaiting provider detail',
  // Folded into the awaiting wording (D6) but suffixed so two transient rows
  // in one response never render as duplicates of each other.
  'provider-revision-drift': 'Awaiting provider detail (revised day)',
  'unmodelled-provider-cost': UNATTRIBUTED_MODEL_LABEL,
  'surface-remainder': PROVIDER_USAGE_MODEL_LABEL,
}

/** Synthetic driver-row key base for the api-reconciled remainder (mirrors the
 *  pre-existing `__null_${axis}` convention — never a real model string). */
export const UNATTRIBUTED_MODEL_KEY = '__null_model'

/** Synthetic driver-row key base for the ingest-only (provider-usage)
 *  remainder — kept distinct from {@link UNATTRIBUTED_MODEL_KEY} so the two
 *  provenances' remainders can never collide into one row. */
export const PROVIDER_USAGE_MODEL_KEY = '__provider_usage_model'

/**
 * The BILLED lane's NULL-model fact: a `provider_usage_fact` row whose `model`
 * is NULL. On the GitHub arm this is the NORMAL shape rather than an
 * exception — mig 0120's `provider_usage_fact_github_money_grain_chk` makes a
 * Copilot row carrying both a model and money a constraint violation, so
 * Copilot's day-grain money lands here BY CONSTRUCTION.
 *
 * Its own key and label because it is its own fact: reusing
 * {@link UNATTRIBUTED_MODEL_KEY} would give a billed row the usage lane's key
 * under a different label.
 */
export const BILLED_NO_MODEL_KEY = '__billed_no_model'
export const BILLED_NO_MODEL_LABEL = 'No model on the provider record'

const isKnownReason = (r: string | null | undefined): r is ModelGapReason =>
  (MODEL_GAP_REASONS as readonly string[]).includes(r ?? '')

/**
 * The driver-row label for a (model, usage_provenance, gap_reason) triple.
 * Returns the real model when present; otherwise the remainder label for WHY
 * it is absent — reason-specific when the reason is recognised, the
 * provenance-branch default when it is unknown or absent (default-safe: an
 * unknown reason gets the generic remainder wording, never a new category).
 */
export function modelDriverLabel(
  model: string | null | undefined,
  usageProvenance: string | null | undefined,
  gapReason?: string | null,
): string {
  if (model) return model
  if (isKnownReason(gapReason)) return MODEL_GAP_REASON_LABELS[gapReason]
  return isProviderUsageProvenance(usageProvenance) ? PROVIDER_USAGE_MODEL_LABEL : UNATTRIBUTED_MODEL_LABEL
}

/**
 * The driver-row `key` for the same triple — mirrors {@link modelDriverLabel}'s
 * branch so a row's key and label can never disagree about which remainder it
 * is.
 *
 * The key is the provenance base ({@link UNATTRIBUTED_MODEL_KEY} /
 * {@link PROVIDER_USAGE_MODEL_KEY}) suffixed `:{reason}` when a reason is
 * present — ANY reason, recognised or not, because the drivers query groups by
 * (model, provenance, reason) and two same-provenance remainders with
 * different reasons must stay two rows (distinct Vue `:key`s, distinct map
 * entries). Every synthetic key keeps the `__` sentinel prefix, which is what
 * {@link modelBucketKind} classifies on.
 */
export function modelDriverKey(
  model: string | null | undefined,
  usageProvenance: string | null | undefined,
  gapReason?: string | null,
): string {
  if (model) return model
  const base = isProviderUsageProvenance(usageProvenance)
    ? PROVIDER_USAGE_MODEL_KEY
    : UNATTRIBUTED_MODEL_KEY
  return gapReason ? `${base}:${gapReason}` : base
}

/*
 * ── WHAT A READER IS ALLOWED TO DO WITH EACH ROW ─────────────────────────────
 *
 * A ranked bar answers "which model costs the most". A remainder is not a
 * competitor in that ranking — it is a statement about the ranking's reach —
 * so it must never be sorted into it. It renders as the coverage footer (D6),
 * priced, with its reason's wording.
 *
 * TWO kinds only. The old 'structural' / 'not-carried' split served the
 * group-band rendering D6 retires; the distinction the reader now gets is the
 * REASON (via `DriverRow.gap_reason` and the footer wording), not a band.
 */
export type ModelBucketKind = 'model' | 'remainder'

/**
 * Whether a model-axis driver row is rankable, from its `key` alone.
 *
 * DEFAULT-SAFE in the direction that matters (D6, test 20): every synthetic
 * key this module mints — bare or reason-suffixed, known reason or not — wears
 * the `__` sentinel prefix, and ANY `__`-prefixed key classifies as
 * 'remainder'. A NULL-model row can therefore never become a category row by
 * carrying a reason this module has not heard of; the only way into the
 * ranking is a real model string, which never starts with `__`
 * (provider_usage_fact_shape_chk forbids blank models and modelOf trims — no
 * provider id wears the sentinel).
 */
export function modelBucketKind(key: string): ModelBucketKind {
  return key.startsWith('__') ? 'remainder' : 'model'
}

/** The reason a suffixed synthetic key carries, or null (bare base / real model). */
function reasonOfKey(key: string): string | null {
  if (!key.startsWith('__')) return null
  const idx = key.indexOf(':')
  return idx === -1 ? null : key.slice(idx + 1)
}

/**
 * WHY this remainder carries no model, in one sentence, for a tooltip.
 *
 * Written here rather than in a component so the two model cards (region and
 * whole-company) cannot drift. `null` for a real model — there is nothing to
 * explain. Default for an unrecognised synthetic key: the generic remainder
 * sentence, so a new reason value degrades to honesty rather than to silence.
 *
 * Each sentence states only what is evidenced — none claims the provider
 * withholds a model where the 2026-08-01 capture saw one.
 */
export function modelBucketNote(key: string): string | null {
  if (modelBucketKind(key) === 'model') return null
  if (key === BILLED_NO_MODEL_KEY) {
    return 'The provider reported this money at a day grain that carries no model. Splitting it across models would be a ratio, not a measurement.'
  }
  switch (reasonOfKey(key)) {
    case 'provider-day-grain':
      return 'Copilot reports this money per day, with no per-model dollars. Splitting it across models would be a ratio, not a measurement.'
    case 'awaiting-provider-detail':
      return 'No per-model provider facts have landed for this day yet. The fact lane refreshes on its own cadence; this heals itself.'
    case 'provider-revision-drift':
      return 'The provider revised this day down before its per-model facts refreshed. The day is reported whole until they land; this heals itself.'
    case 'unmodelled-provider-cost':
    case 'surface-remainder':
    default:
      return 'Provider cost reported without a model. The named models beside this carry everything that was measured with one.'
  }
}
