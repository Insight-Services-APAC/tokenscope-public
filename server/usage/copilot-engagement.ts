/*
 * copilot-engagement — the derived read behind the /usage engagement card's
 * Copilot column (developer-pages W0b: D8/D9).
 *
 * ── DERIVED READ, NOT A NEW TABLE (D8) ──────────────────────────────────────
 *
 * Reads `reconciliation_record.raw` BY KEY at request time — the #231 drawer
 * pattern. A materialised engagement table would copy provider dimensions into
 * a second store, the exact thing the by-key-never-copy canon forbids
 * (target-state-data-architecture.md:190-201). Retention is forever
 * (`reconciliation_record` is in the durable set, no pruning anywhere), and
 * the read is tiny: one row per (teammate, day, provider, category) — a
 * 31-day window is ≤ ~31 rows of JSONB per category, on the
 * (teammate_id, period_date) index (mig 0038). This is a self-page read; the
 * day an org-grain surface wants engagement is the day a materialisation gets
 * designed, not now.
 *
 * ── EFFECTIVE ROWS ONLY (D8 supersession handling) ──────────────────────────
 *
 * Terminal rows accumulate; supersession writes a NEW row (mig 0038). The
 * query below selects the single LIVE row per logical key with the same
 * DISTINCT ON that `v_teammate_usage_daily` (mig 0086) and the billed lane
 * (provider-transform-github.ts) use: non-terminal status, `applied` beating a
 * lingering `proposed`, newest `computed_at` as tiebreak. Copied deliberately
 * rather than re-invented — the engagement card renders BESIDE the §A Copilot
 * usage figures that view produces, and the two must not disagree about which
 * ledger row is live. (`v_effective_spend`'s `status = 'applied'` gate is the
 * MONEY gate; in propose-mode it would blank this card while the usage view
 * beside it shows the same days' spend.) Rejected and superseded rows never
 * enter, so a revised day counts exactly once.
 *
 * ── EVERY SHARE ON A NAMED OBSERVED OPERAND (D9, r1-H2) ─────────────────────
 *
 *   - MODEL shares read the declared axis:
 *     `totals_by_model_feature[].user_initiated_interaction_count`, SUMMED per
 *     model across features (one model appears under several features — the
 *     schema's own mandate) and across days.
 *   - LANGUAGE shares follow D9's ladder: weight by the per-entry
 *     `user_initiated_interaction_count` on `totals_by_language_model` when
 *     the wire sends it; else fall back to `totals_by_language_feature` if ITS
 *     entries carry the count; else the language mix is ABSENT (null) — no
 *     derived weights, no equal-splitting, nothing faked.
 *
 * Fields the wire lacks stay ABSENT (null), never zero — the deleted-LOC legs
 * render only when present. And this module's vocabulary is Copilot's own: it
 * carries NO session count and never will (D22 — no fake symmetry with the
 * Claude column; Claude's column never reads this module).
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

function sharesOf(weights: Map<string, number>): Array<{ key: string; sharePct: number }> | null {
  let total = 0
  for (const w of weights.values()) total += w
  if (total <= 0) return null
  return [...weights.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, w]) => ({ key, sharePct: Number(((w / total) * 100).toFixed(1)) }))
}

/**
 * The caller's Copilot engagement over a window, summed over EFFECTIVE ledger
 * rows only. Returns null when the window holds no effective Copilot rows —
 * the card's empty state (D22: an empty state, never zeros).
 *
 * Window semantics: `period_date` is mapped to its UTC-midnight instant and
 * tested against the half-open `[startIso, endIso)` — the SAME mapping
 * `v_effective_spend` uses for reconciliation rows, so an engagement day is in
 * the window exactly when its spend is.
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
  // D9's ladder, decided over the WHOLE window: rung 1 wins if ANY
  // language×model entry carries the measure; rung 2 only when rung 1 found
  // nothing; otherwise the mix is absent.
  const langModelWeights = new Map<string, number>()
  const langFeatureWeights = new Map<string, number>()

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

      // LANGUAGE ladder rung 1: language×model entries carrying the measure.
      for (const e of entriesOf(rec.totals_by_language_model)) {
        const language =
          typeof e.language === 'string' && e.language.trim() !== '' ? e.language.trim() : null
        const w = num(e.user_initiated_interaction_count)
        if (!language || w === null) continue
        langModelWeights.set(language, (langModelWeights.get(language) ?? 0) + w)
      }
      // Rung 2 operand, collected unconditionally; consulted only if rung 1
      // ends empty across the whole window.
      for (const e of entriesOf(rec.totals_by_language_feature)) {
        const language =
          typeof e.language === 'string' && e.language.trim() !== '' ? e.language.trim() : null
        const w = num(e.user_initiated_interaction_count)
        if (!language || w === null) continue
        langFeatureWeights.set(language, (langFeatureWeights.get(language) ?? 0) + w)
      }
    }
  }

  const models = sharesOf(modelWeights)
  const languageShares = sharesOf(langModelWeights) ?? sharesOf(langFeatureWeights)

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
  }
}
