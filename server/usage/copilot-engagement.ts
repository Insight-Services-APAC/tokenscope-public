/*
 * copilot-engagement — the derived read behind the /usage engagement card's
 * Copilot column (developer-pages W0b: D8/D9).
 *
 * ── DERIVED READ, NOT A NEW TABLE (D8) ──────────────────────────────────────
 *
 * Reads `reconciliation_record.raw` BY KEY at request time — the #231 drawer
 * pattern. A materialised table would copy provider dimensions into a second
 * store, which the by-key-never-copy canon forbids
 * (target-state-data-architecture.md:190-201). The read is tiny: ≤ ~31 JSONB rows
 * per category on the (teammate_id, period_date) index (mig 0038).
 *
 * ── EFFECTIVE ROWS ONLY (D8 supersession handling) ──────────────────────────
 *
 * Terminal rows accumulate and supersession writes a NEW row (mig 0038), so the
 * query picks the single LIVE row per key with the SAME DISTINCT ON that
 * `v_teammate_usage_daily` (mig 0086) and the billed lane use — this card renders
 * beside that view's figures and the two must not disagree about which row is
 * live. Not `v_effective_spend`'s `status = 'applied'` gate: that is the MONEY
 * gate and would blank this card in propose-mode.
 *
 * ── EVERY SHARE ON A NAMED OBSERVED OPERAND (D9, r1-H2) ─────────────────────
 *
 *   - MODEL shares read the declared axis:
 *     `totals_by_model_feature[].user_initiated_interaction_count`, SUMMED per
 *     model across features (one model appears under several features — the
 *     schema's own mandate) and across days.
 *   - LANGUAGE shares follow D9's ladder over `totals_by_language_model` then
 *     `totals_by_language_feature`, else ABSENT (null) — no derived weights, no
 *     equal-splitting. Capture 2026-08-19 (org variant) saw no
 *     `user_initiated_interaction_count` on either array, so
 *     `code_generation_activity_count` is the rung that actually fires.
 *
 * Fields the wire lacks stay ABSENT (null), never zero. Vocabulary is Copilot's
 * own: NO session count, ever (D22 — no fake symmetry with the Claude column).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { SpendWindow } from './complete-spend'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface CopilotEngagement {
  /** Σ root-level `user_initiated_interaction_count`; null when no row carried it. */
  interactions: number | null
  /** Σ `loc_added_sum` — lines the developer KEPT. Null when absent on the wire. */
  locKept: number | null
  /** Σ `loc_suggested_to_add_sum`. Null when absent on the wire. */
  locSuggested: number | null
  /** Σ `loc_deleted_sum` — rendered only when present (honest numbers). */
  locDeleted: number | null
  /** Σ `loc_suggested_to_delete_sum` — rendered only when present. */
  locSuggestedToDelete: number | null
  /** locKept / locSuggested × 100, when both operands exist and suggested > 0. */
  keptPct: number | null
  /** Σ `code_generation_activity_count`; null when no row carried it. */
  generationActivity: number | null
  /** Σ `code_acceptance_activity_count`; null when no row carried it. */
  acceptanceActivity: number | null
  /** Language mix per D9's ladder; NULL when no observed weighting measure exists. */
  languages: Array<{ language: string; sharePct: number }> | null
  /** CLI-vs-App request mix; NULL when neither harness reported requests. */
  harnesses: Array<{ harness: string; sharePct: number }> | null
  /** IDE activity is in the window but shares no measure with the CLI/App subtrees
   *  (capture 2026-08-19), so it cannot join `harnesses`. Said, never omitted —
   *  and it is the COMMON case (60/74 records), so it stands alone. */
  ideActivityExcluded: boolean
  /** Model mix on the declared interaction-count axis; NULL when no entries. */
  models: Array<{ model: string; sharePct: number }> | null
}

/** One envelope of `reconciliation_record.raw` — the three real shapes are the
 *  App-mode object (`record`), the PAT-mode object (`items`, no engagement
 *  fields), and either wrapped in an array by the engine's conflict-key merge. */
interface RawEnvelope {
  record?: unknown
}

function rawEnvelopes(raw: unknown): RawEnvelope[] {
  if (Array.isArray(raw)) return raw.filter((e): e is RawEnvelope => !!e && typeof e === 'object')
  if (raw && typeof raw === 'object') return [raw as RawEnvelope]
  return []
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Accumulate an optional scalar: absence stays absent, presence sums. */
function addPresent(acc: number | null, v: number | null): number | null {
  if (v === null) return acc
  return (acc ?? 0) + v
}

/** Entries of an array subtree, tolerating any non-array shape as "absent". */
function entriesOf(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return []
  return v.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
}

/** Per-language sums for one array, kept separate per measure — mixing them in one
 *  denominator would divide across two different scales. */
interface LanguageWeights {
  uiic: Map<string, number>
  gen: Map<string, number>
}

/** Accumulate one record's language array into both measures. uiic is preferred
 *  where sent (matching the model axis); capture 2026-08-19 saw it on neither
 *  language array (0/74), which is why gen exists as the observed fallback. */
function collectLanguageWeights(subtree: unknown, into: LanguageWeights): void {
  for (const e of entriesOf(subtree)) {
    const language =
      typeof e.language === 'string' && e.language.trim() !== '' ? e.language.trim() : null
    if (!language) continue
    const uiic = num(e.user_initiated_interaction_count)
    if (uiic !== null) into.uiic.set(language, (into.uiic.get(language) ?? 0) + uiic)
    const gen = num(e.code_generation_activity_count)
    if (gen !== null) into.gen.set(language, (into.gen.get(language) ?? 0) + gen)
  }
}

/** The harness subtrees and their labels. Weighted on `request_count`, never
 *  `session_count`: D22 keeps session vocabulary off this card. `totals_by_ide[]`
 *  carries neither measure, hence `ideActivityExcluded`. */
const HARNESS_SUBTREES = [
  ['totals_by_cli', 'Copilot CLI'],
  ['totals_by_copilot_app', 'Copilot App'],
] as const

function sharesOf(weights: Map<string, number>): Array<{ key: string; sharePct: number }> | null {
  // Only positive weights reach the denominator — they are the only ones that
  // reach the numerator (the filter below), and summing a negative into `total`
  // alone would push every surviving share past 100%.
  let total = 0
  for (const w of weights.values()) if (w > 0) total += w
  if (total <= 0) return null
  return [...weights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, w]) => ({ key, sharePct: Number(((w / total) * 100).toFixed(1)) }))
}

/**
 * The caller's Copilot engagement over a window, over EFFECTIVE ledger rows only.
 * Null when the window holds none — the card's empty state (D22: never zeros).
 * `period_date` maps to its UTC-midnight instant against half-open
 * `[startIso, endIso)`, the same mapping `v_effective_spend` uses.
 */
export async function copilotEngagement(
  tx: Tx,
  teammateId: string,
  window: SpendWindow,
): Promise<CopilotEngagement | null> {
  const rows = await tx.execute<{ raw: unknown }>(sql`
    SELECT DISTINCT ON (r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id)
           r.raw
      FROM reconciliation_record r
     WHERE r.provider = 'github'
       AND r.scope = 'teammate'
       AND r.teammate_id = ${teammateId}::uuid
       AND r.status NOT IN ('rejected', 'superseded')
       AND (r.period_date::timestamp AT TIME ZONE 'UTC') >= ${window.startIso}::timestamptz
       AND (r.period_date::timestamp AT TIME ZONE 'UTC') < ${window.endIso}::timestamptz
     ORDER BY r.provider, r.enterprise_ref, r.period_date, r.category, r.scope, r.teammate_id,
              CASE r.status WHEN 'applied' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
              r.computed_at DESC
  `)
  const effective = [...rows]
  if (effective.length === 0) return null

  let interactions: number | null = null
  let locKept: number | null = null
  let locSuggested: number | null = null
  let locDeleted: number | null = null
  let locSuggestedToDelete: number | null = null
  let generationActivity: number | null = null
  let acceptanceActivity: number | null = null
  const modelWeights = new Map<string, number>()
  // D9's ladder, decided over the WHOLE window: one accumulator per
  // (array, measure), never a per-entry fallback. A rung wins if it collected.
  const langModelWeights = { uiic: new Map<string, number>(), gen: new Map<string, number>() }
  const langFeatureWeights = { uiic: new Map<string, number>(), gen: new Map<string, number>() }
  const harnessWeights = new Map<string, number>()
  let harnessUnmeasured = false
  let ideActivityExcluded = false

  for (const row of effective) {
    for (const envelope of rawEnvelopes(row.raw)) {
      const record = envelope.record
      if (!record || typeof record !== 'object') continue // PAT-mode `items` rows carry no engagement
      const rec = record as Record<string, unknown>

      interactions = addPresent(interactions, num(rec.user_initiated_interaction_count))
      locKept = addPresent(locKept, num(rec.loc_added_sum))
      locSuggested = addPresent(locSuggested, num(rec.loc_suggested_to_add_sum))
      locDeleted = addPresent(locDeleted, num(rec.loc_deleted_sum))
      locSuggestedToDelete = addPresent(locSuggestedToDelete, num(rec.loc_suggested_to_delete_sum))
      generationActivity = addPresent(generationActivity, num(rec.code_generation_activity_count))
      acceptanceActivity = addPresent(acceptanceActivity, num(rec.code_acceptance_activity_count))

      // MODEL shares — SUM per model across features, never take-the-first.
      for (const e of entriesOf(rec.totals_by_model_feature)) {
        const model = typeof e.model === 'string' && e.model.trim() !== '' ? e.model.trim() : null
        const w = num(e.user_initiated_interaction_count)
        if (!model || w === null) continue
        modelWeights.set(model, (modelWeights.get(model) ?? 0) + w)
      }

      // Every rung's operand, collected unconditionally; which one is CONSULTED
      // is decided once, below, over the whole window.
      collectLanguageWeights(rec.totals_by_language_model, langModelWeights)
      collectLanguageWeights(rec.totals_by_language_feature, langFeatureWeights)

      for (const [key, label] of HARNESS_SUBTREES) {
        const subtree = rec[key]
        if (!subtree || typeof subtree !== 'object') continue
        const requests = num((subtree as Record<string, unknown>).request_count)
        // A harness that was USED but reported no usable count cannot be weighed;
        // rendering its sibling at 100% would claim it was never used at all.
        if (requests === null || requests < 0) harnessUnmeasured = true
        else harnessWeights.set(label, (harnessWeights.get(label) ?? 0) + requests)
      }
      if (entriesOf(rec.totals_by_ide).length > 0) ideActivityExcluded = true
    }
  }

  const models = sharesOf(modelWeights)
  // Richer array first, then preferred measure within it. Never mixed.
  const languageShares =
    sharesOf(langModelWeights.uiic) ??
    sharesOf(langModelWeights.gen) ??
    sharesOf(langFeatureWeights.uiic) ??
    sharesOf(langFeatureWeights.gen)

  const keptPct =
    locKept !== null && locSuggested !== null && locSuggested > 0
      ? Number(((locKept / locSuggested) * 100).toFixed(1))
      : null

  return {
    interactions,
    locKept,
    locSuggested,
    locDeleted,
    locSuggestedToDelete,
    keptPct,
    generationActivity,
    acceptanceActivity,
    languages: languageShares?.map((s) => ({ language: s.key, sharePct: s.sharePct })) ?? null,
    models: models?.map((s) => ({ model: s.key, sharePct: s.sharePct })) ?? null,
    harnesses: harnessUnmeasured
      ? null
      : (sharesOf(harnessWeights)?.map((s) => ({ harness: s.key, sharePct: s.sharePct })) ?? null),
    ideActivityExcluded,
  }
}
