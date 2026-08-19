// @vitest-environment node
/*
 * T7 (developer-pages W0b) — the Copilot engagement derived read
 * (server/usage/copilot-engagement.ts) against a real Postgres.
 *
 * Pins, per D8/D9:
 *   - declared engagement fields parse out of `reconciliation_record.raw`
 *     (App-mode envelope `{login, periodDate, credits, record}`);
 *   - sums use EFFECTIVE rows only — a superseded fixture row for a revised
 *     day contributes nothing (the mig-0086 live-row predicate);
 *   - missing fields render ABSENT (null), never zero;
 *   - model shares SUM per model ACROSS features (never take-the-first);
 *   - the language ladder: per-entry measure on totals_by_language_model →
 *     rung 1; else totals_by_language_feature carrying the count → rung 2;
 *     else the mix is ABSENT — no equal-splitting, no derived weights;
 *   - PAT-mode envelopes (`items`, no `record`) contribute nothing;
 *   - the window bounds both sides;
 *   - vocabulary discipline (T9's module half): the Copilot shape carries NO
 *     session count — no fake symmetry with the Claude column. The harness mix
 *     is weighted on `request_count` for that reason, not `session_count`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { copilotEngagement } from '../../../server/usage/copilot-engagement'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''

/** June 2026, whole-month half-open window. */
const WINDOW = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-07-01T00:00:00.000Z' }

/** Seed one Copilot ledger row with an App-mode raw envelope wrapping `record`. */
async function ledgerRow(opts: {
  day: string
  record?: unknown
  raw?: unknown
  status?: string
  category?: string
  computedAt?: Date
}): Promise<void> {
  await t.db.insert(schema.reconciliationRecord).values({
    teammateId,
    provider: 'github',
    enterpriseRef: 'ent-demo',
    licenseOrg: 'org-demo',
    periodDate: opts.day,
    category: opts.category ?? 'copilot_interactive',
    scope: 'teammate',
    regionId,
    orgUnitId,
    actualQty: '100',
    actualUnitType: 'ai-credits',
    actualUsd: '1.00',
    otelAttributedUsd: '0',
    deltaUsd: '0',
    spendClass: 'indicative',
    indicativeReason: 'copilot-pre-billing',
    disposition: 'untagged',
    status: opts.status ?? 'proposed',
    raw:
      opts.raw !== undefined
        ? opts.raw
        : { login: 'octocat', periodDate: opts.day, credits: 100, record: opts.record },
    computedAt: opts.computedAt ?? new Date('2026-06-25T00:00:00.000Z'),
  })
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'eng', displayName: 'ENG' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'eng', code: 'eng-bu', displayName: 'ENG', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-eng', email: 'eng@x.test', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM reconciliation_record WHERE teammate_id = ${teammateId}::uuid`
})

describe('copilotEngagement — T7', () => {
  it('sums the declared fields over the window and weights model shares by SUMMED interactions across features', async () => {
    await ledgerRow({
      day: '2026-06-10',
      record: {
        user_login: 'octocat',
        ai_credits_used: 100,
        user_initiated_interaction_count: 30,
        loc_added_sum: 120,
        loc_deleted_sum: 10,
        loc_suggested_to_add_sum: 200,
        loc_suggested_to_delete_sum: 20,
        code_generation_activity_count: 12,
        code_acceptance_activity_count: 8,
        totals_by_model_feature: [
          { model: 'gpt-5', feature: 'chat', user_initiated_interaction_count: 7 },
          { model: 'gpt-5', feature: 'agent', user_initiated_interaction_count: 3 },
          { model: 'claude-sonnet-4-5', feature: 'chat', user_initiated_interaction_count: 10 },
        ],
      },
    })
    await ledgerRow({
      day: '2026-06-11',
      record: {
        user_login: 'octocat',
        ai_credits_used: 50,
        user_initiated_interaction_count: 10,
        loc_added_sum: 30,
        loc_suggested_to_add_sum: 50,
        code_generation_activity_count: 3,
        code_acceptance_activity_count: 2,
        totals_by_model_feature: [
          { model: 'gpt-5', feature: 'chat', user_initiated_interaction_count: 20 },
        ],
      },
    })

    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out).not.toBeNull()
    expect(out.interactions).toBe(40)
    expect(out.locKept).toBe(150)
    expect(out.locSuggested).toBe(250)
    expect(out.locDeleted).toBe(10) // only day 1 carried it — present, so summed
    expect(out.locSuggestedToDelete).toBe(20)
    expect(out.keptPct).toBe(60) // 150 / 250
    expect(out.generationActivity).toBe(15)
    expect(out.acceptanceActivity).toBe(10)
    // gpt-5: 7 + 3 + 20 = 30 (summed ACROSS features and days); sonnet: 10.
    expect(out.models).toEqual([
      { model: 'gpt-5', sharePct: 75 },
      { model: 'claude-sonnet-4-5', sharePct: 25 },
    ])
  })

  it('uses EFFECTIVE rows only: a superseded day contributes nothing; its replacement counts once', async () => {
    // The revised day: an old superseded row with WRONG (huge) figures and its
    // applied replacement. Only the replacement may enter the sums.
    await ledgerRow({
      day: '2026-06-12',
      status: 'superseded',
      computedAt: new Date('2026-06-13T00:00:00.000Z'),
      record: { user_initiated_interaction_count: 9999, loc_added_sum: 9999, loc_suggested_to_add_sum: 9999 },
    })
    await ledgerRow({
      day: '2026-06-12',
      status: 'applied',
      computedAt: new Date('2026-06-14T00:00:00.000Z'),
      record: { user_initiated_interaction_count: 5, loc_added_sum: 40, loc_suggested_to_add_sum: 80 },
    })
    // A rejected row must not enter either.
    await ledgerRow({
      day: '2026-06-13',
      status: 'rejected',
      record: { user_initiated_interaction_count: 1111 },
    })

    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.interactions).toBe(5)
    expect(out.locKept).toBe(40)
    expect(out.locSuggested).toBe(80)
    expect(out.keptPct).toBe(50)
  })

  it('renders missing fields ABSENT (null), never zero', async () => {
    // A day whose record carries interactions but NO LOC sums and NO activity
    // counts — the wire simply did not send them.
    await ledgerRow({
      day: '2026-06-15',
      record: { user_login: 'octocat', user_initiated_interaction_count: 4 },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.interactions).toBe(4)
    expect(out.locKept).toBeNull()
    expect(out.locSuggested).toBeNull()
    expect(out.locDeleted).toBeNull()
    expect(out.locSuggestedToDelete).toBeNull()
    expect(out.keptPct).toBeNull()
    expect(out.generationActivity).toBeNull()
    expect(out.acceptanceActivity).toBeNull()
    expect(out.models).toBeNull()
    expect(out.languages).toBeNull()
  })

  it('language ladder rung 1: weights by the per-entry measure on totals_by_language_model when the wire sends it', async () => {
    await ledgerRow({
      day: '2026-06-16',
      record: {
        totals_by_language_model: [
          { language: 'typescript', model: 'gpt-5', user_initiated_interaction_count: 30 },
          { language: 'python', model: 'gpt-5', user_initiated_interaction_count: 10 },
        ],
        // Rung 2 operand present too — rung 1 must win.
        totals_by_language_feature: [
          { language: 'go', feature: 'chat', user_initiated_interaction_count: 999 },
        ],
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.languages).toEqual([
      { language: 'typescript', sharePct: 75 },
      { language: 'python', sharePct: 25 },
    ])
  })

  it('the REAL wire shape yields a mix: language entries carry code_generation_activity_count, never user_initiated_interaction_count', async () => {
    /*
     * The shape capture 2026-08-19 actually observed on both language arrays —
     * `user_initiated_interaction_count` is ABSENT (0/74) and
     * `code_generation_activity_count` is present on every entry.
     *
     * The rungs used to weight by the absent field alone, so BOTH ended empty and
     * the language mix was permanently null while the card had data to show. Every
     * other test here fabricates the absent field, which is exactly why the bug
     * survived them.
     *
     * MUTATION: drop the code_generation_activity_count fallback from
     * languageEntryWeight → this goes red with `languages` null.
     */
    await ledgerRow({
      day: '2026-06-18',
      record: {
        totals_by_language_model: [
          { language: 'typescript', model: 'gpt-5', code_generation_activity_count: 30 },
          { language: 'python', model: 'gpt-5', code_generation_activity_count: 10 },
        ],
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.languages).toEqual([
      { language: 'typescript', sharePct: 75 },
      { language: 'python', sharePct: 25 },
    ])
  })

  it('harness mix splits CLI vs App by requests, and flags IDE activity as excluded', async () => {
    /*
     * The App is a harness peer of the CLI, and `session_count` is the only human
     * unit BOTH subtrees carry. `totals_by_ide[]` carries none of them, so it
     * cannot share the denominator — the flag is what lets the card SAY that
     * instead of showing a mix that silently omits the IDE.
     *
     * MUTATION: fold totals_by_ide into harnessWeights on any of its own measures
     * → the shares move off 75/25 and the IDE lands in a bar it shares no scale
     * with.
     */
    await ledgerRow({
      day: '2026-06-20',
      record: {
        totals_by_cli: { session_count: 99, request_count: 30 },
        totals_by_copilot_app: { session_count: 99, request_count: 10 },
        totals_by_ide: [{ ide: 'vscode', user_initiated_interaction_count: 999 }],
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    // session_count is EQUAL on both subtrees here, so a mix weighted on sessions
    // would read 50/50 — the shares below can only come from request_count.
    expect(out.harnesses).toEqual([
      { harness: 'Copilot CLI', sharePct: 75 },
      { harness: 'Copilot App', sharePct: 25 },
    ])
    expect(out.ideActivityExcluded).toBe(true)
  })

  it('a window with no Copilot App use yields a CLI-only mix and no IDE note', async () => {
    await ledgerRow({
      day: '2026-06-21',
      record: { totals_by_cli: { request_count: 4 } },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.harnesses).toEqual([{ harness: 'Copilot CLI', sharePct: 100 }])
    expect(out.ideActivityExcluded).toBe(false)
  })

  it('harness mix is ABSENT, never zeroed, when neither subtree reports requests', async () => {
    await ledgerRow({
      day: '2026-06-22',
      record: { totals_by_cli: { session_count: 3, token_usage: { prompt_tokens_sum: 10 } } },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    // session_count IS present — the mix must still be absent, because the measure
    // is request_count and nothing carried it.
    expect(out.harnesses).toBeNull()
  })

  it('a harness that was USED but reported no count suppresses the mix, never shows its sibling at 100%', async () => {
    /*
     * The App subtree is PRESENT — the harness was used — but carries no
     * request_count. Weighting only what is measurable would render "Copilot CLI
     * 100%", i.e. "you never used the App", from data that says the opposite.
     *
     * MUTATION: drop the harnessUnmeasured guard → harnesses becomes
     * [{Copilot CLI, 100}] and this goes red.
     */
    await ledgerRow({
      day: '2026-06-23',
      record: {
        totals_by_cli: { request_count: 30 },
        totals_by_copilot_app: { session_count: 4 }, // used, but no request_count
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.harnesses).toBeNull()
  })

  it('a negative count cannot push a surviving share past 100%', async () => {
    /*
     * `sharesOf` filters non-positive weights out of the NUMERATOR, so summing one
     * into the denominator alone inflated everything that survived: CLI 10 against
     * App -5 gave a total of 5 and rendered CLI at 200%.
     *
     * MUTATION: sum every weight into `total` regardless of sign → 200%.
     */
    await ledgerRow({
      day: '2026-06-24',
      record: {
        totals_by_language_model: [
          { language: 'typescript', model: 'gpt-5', code_generation_activity_count: 10 },
          { language: 'python', model: 'gpt-5', code_generation_activity_count: -5 },
        ],
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.languages).toEqual([{ language: 'typescript', sharePct: 100 }])
  })

  it('never mixes the two measures into one denominator when only SOME entries carry the preferred one', async () => {
    /*
     * A per-ENTRY fallback would sum 30 interactions (typescript) against 900
     * code-generations (python) — two different scales in one denominator, giving
     * python a ~97% share that means nothing. The measure is chosen per ARRAY, so
     * only the entries carrying the preferred measure form the mix.
     *
     * MUTATION: pick the weight per entry (uiic ?? gen) → typescript/python come
     * out ~3%/97% and this goes red.
     */
    await ledgerRow({
      day: '2026-06-19',
      record: {
        totals_by_language_model: [
          { language: 'typescript', model: 'gpt-5', user_initiated_interaction_count: 30 },
          { language: 'python', model: 'gpt-5', code_generation_activity_count: 900 },
        ],
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.languages).toEqual([{ language: 'typescript', sharePct: 100 }])
  })

  it('language ladder rung 2: falls back to totals_by_language_feature when the language×model entries carry no measure', async () => {
    await ledgerRow({
      day: '2026-06-17',
      record: {
        // The 2026-08-02-capture shape: model/language keys, NO numeric measure.
        totals_by_language_model: [
          { language: 'typescript', model: 'gpt-5' },
          { language: 'python', model: 'gpt-5' },
        ],
        totals_by_language_feature: [
          { language: 'typescript', feature: 'chat', user_initiated_interaction_count: 6 },
          { language: 'typescript', feature: 'agent', user_initiated_interaction_count: 2 },
          { language: 'python', feature: 'chat', user_initiated_interaction_count: 2 },
        ],
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.languages).toEqual([
      { language: 'typescript', sharePct: 80 },
      { language: 'python', sharePct: 20 },
    ])
  })

  it('language ladder rung 3: NO measure anywhere → the mix is ABSENT, never equal-split', async () => {
    await ledgerRow({
      day: '2026-06-18',
      record: {
        user_initiated_interaction_count: 12,
        totals_by_language_model: [
          { language: 'typescript', model: 'gpt-5' },
          { language: 'python', model: 'gpt-5' },
        ],
        totals_by_language_feature: [{ language: 'typescript', feature: 'chat' }],
      },
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.languages).toBeNull()
    // The rest of the record still contributes — one absent axis costs one axis.
    expect(out.interactions).toBe(12)
  })

  it('ignores PAT-mode envelopes (items, no record) and tolerates array-wrapped raw', async () => {
    // PAT-mode raw shape — carries no engagement fields at all.
    await ledgerRow({
      day: '2026-06-19',
      raw: { login: 'octocat', licenseOrg: 'org-demo', periodDate: '2026-06-19', category: 'copilot_interactive', items: [{ sku: 'x' }] },
    })
    // The engine's conflict-key merge wraps envelopes in an ARRAY.
    await ledgerRow({
      day: '2026-06-20',
      raw: [
        { login: 'octocat', periodDate: '2026-06-20', credits: 10, record: { user_initiated_interaction_count: 3 } },
        { login: 'octocat-alt', periodDate: '2026-06-20', credits: 5, record: { user_initiated_interaction_count: 2 } },
      ],
    })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.interactions).toBe(5) // 3 + 2; the PAT envelope contributed nothing
    expect(out.locKept).toBeNull()
  })

  it('bounds the window on BOTH sides and returns null (empty state) when no effective rows are in it', async () => {
    await ledgerRow({
      day: '2026-05-31', // before the window
      record: { user_initiated_interaction_count: 100 },
    })
    await ledgerRow({
      day: '2026-07-01', // at/after the exclusive upper bound
      record: { user_initiated_interaction_count: 200 },
    })
    expect(await copilotEngagement(t.db, teammateId, WINDOW)).toBeNull()

    await ledgerRow({ day: '2026-06-01', record: { user_initiated_interaction_count: 7 } })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(out.interactions).toBe(7)
  })

  it('T9 (module half): the Copilot vocabulary carries NO session count — no fake symmetry', async () => {
    await ledgerRow({ day: '2026-06-21', record: { user_initiated_interaction_count: 1 } })
    const out = (await copilotEngagement(t.db, teammateId, WINDOW))!
    expect(Object.keys(out)).not.toContain('sessions')
    // The harness mix is weighted on `request_count` for this reason: both harness
    // subtrees also carry `session_count`, and using it would have put the word
    // "sessions" on the Copilot card beside a Claude column reporting OTel
    // conversations — the comparison D22 exists to prevent.
    expect(Object.keys(out)).toEqual([
      'interactions',
      'locKept',
      'locSuggested',
      'locDeleted',
      'locSuggestedToDelete',
      'keptPct',
      'generationActivity',
      'acceptanceActivity',
      'languages',
      'models',
      'harnesses',
      'ideActivityExcluded',
    ])
  })
})
