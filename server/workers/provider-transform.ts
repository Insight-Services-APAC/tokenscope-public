/*
 * provider-transform — derive the NORMALISED lane (`provider_usage_fact`) from
 * each provider's own captured payloads.
 *
 * docs/design/target-state-data-architecture.md §6 is the spec, and
 * docs/design/reporting-consolidation/04-prototype-delta.md §2 is the layer
 * picture. Read them first.
 *
 * WHAT THIS IS FOR. The model axis is built from OTel, which covers ~5% of the
 * estate, so 58% of Dev spend renders as "not split by model". Both providers
 * carry a model dimension on the wire for 100% of spend (verified, not inferred:
 * docs/design/provider-wire-captures/2026-08-02-provider-wire-shape.json). This
 * worker moves that dimension into a fact table at
 * (teammate · day · tool · model · cost_type · context_window) grain (the last
 * member since mig 0127), so the model report can
 * read it directly — no join to OTel, no coverage ratio, no model-name
 * normalisation.
 *
 * ── TWO ARMS, ONE TABLE ──────────────────────────────────────────────────────
 *
 * `provider_usage_fact` is the NORMALISED layer, not an Anthropic surface: one
 * shape, `provider text NOT NULL` as its discriminator (mig 0118:44-45, no CHECK
 * restricting the value), each provider landing through its OWN adapter. This
 * module is the orchestrator — the lock, the transaction, the upsert-then-prune
 * — and each arm is a derive function returning `DerivedFacts`:
 *
 *   - ANTHROPIC, below, from `actual_spend.raw_payload`. Writes BILLED facts:
 *     `amount` is what the provider charged, per (model, cost_type).
 *   - GITHUB COPILOT, `provider-transform-github.ts` (#49), from
 *     `reconciliation_record.raw`. Writes CONSUMPTION facts: gross per-user
 *     credits at the provider's own rate, which is NOT an invoice figure.
 *
 * THE TWO ARMS HOLD DIFFERENT INVARIANTS AND SAY SO. The Anthropic arm
 * conserves against `actual_spend`; the GitHub arm cannot (pooled Copilot rows
 * have no `actual_spend` home — `teammate_id` is NOT NULL there) and conserves
 * against its own ledger instead. Each arm's header states the invariant it
 * claims and no other; mig 0120 records the same split at the schema.
 *
 * A THIRD PROVIDER IS A THIRD DERIVE FUNCTION. Nothing in reporting changes.
 *
 * NOT INERT. T2 has landed: `server/reporting/engine/billed-axis.ts` reads this
 * table for every billed-lane axis, and the Top-models cards render its `model`
 * column directly. Every row written here is on a user-facing surface, so a
 * derive that silently drops a dimension shows up as a bucket on that card
 * rather than as nothing at all. (The paragraph this replaces said the table was
 * inert and instructed its own deletion on exactly this event.)
 *
 * ── THE ANTHROPIC SOURCE, AND WHY IT IS NOT raw_provider_page ────────────────
 *
 * The design reads raw captures (`raw_provider_batch`, migration 0117). That
 * table is on the UNMERGED branch feat/provider-raw-capture and does not exist
 * here, so this worker reads `actual_spend.raw_payload`, which the Anthropic
 * enterprise poller already writes verbatim as `{day, usage[], cost[]}`
 * (analytics-poller.ts:591). It is the same provider rows, carried through one
 * extra hop.
 *
 * TWO CONSEQUENCES OF THAT SUBSTITUTION, both stated rather than discovered:
 *
 * 1. **web_search / code_execution cost rows are not reachable from here.** The
 *    poller drops them BEFORE building raw_payload (analytics-poller.ts:548),
 *    because they are org-grain and must never fold into per-teammate
 *    actual_spend. So the billed lane cannot carry them yet, even though the
 *    design's cost_type column is meant to. This worker does not filter them —
 *    if a payload ever does carry one it is written, because on the billed lane
 *    they belong. They simply never arrive from this source. The conservation
 *    check excludes them on the comparison side regardless, so it stays correct
 *    when the source switches.
 *
 * 2. **An unresolved actor CANNOT arise from this source.** The poller routes an
 *    unresolvable actor to the owed-bill queue and `continue`s before it can
 *    reach actual_spend (analytics-poller.ts:530-534, 575-579), and
 *    `actual_spend.teammate_id` is NOT NULL (mig 0001:301). So every row this
 *    worker reads is already bound to a teammate. The carry path exists in the
 *    SCHEMA (actor_ref + the NULL-safe grain key, mig 0118) for the raw-batch
 *    source, which genuinely can carry unresolved actors — but this worker
 *    cannot produce one, and does not pretend to.
 *
 * ── IDENTITY ─────────────────────────────────────────────────────────────────
 *
 * `actual_spend.teammate_id` is INHERITED, never re-derived from the payload's
 * actor email. An earlier draft re-resolved, on the reasoning that inheriting
 * would make an unresolved row structurally impossible from this source. That
 * argument had it backwards: an unresolved row IS structurally impossible from
 * this source (see consequence 2 above), so re-resolution could only ever
 * DISAGREE with the row it derives from —
 *
 *   - a directory rename moves `teammate.email` and the re-derived row goes
 *     unresolved while its actual_spend row stays bound;
 *   - worse, an email REASSIGNED to a different person re-derives a DIFFERENT
 *     teammate, so the billed identity moves while actual_spend does not.
 *
 * Either breaks the per-teammate conservation this table exists to hold
 * (`Σ provider_usage_fact.cost_usd = actual_spend.cost_usd` per teammate·day·
 * tool·source). Inheritance makes the two agree by construction rather than by
 * two lookups happening to concur.
 *
 * RE-RESOLUTION BECOMES CORRECT WITH THE RAW-BATCH SOURCE, and only then: a raw
 * batch has no actual_spend row to inherit from, every actor in it is
 * unresolved on arrival, and the design's resolution path (the owed-bill replay
 * in placement-store.ts, which mints a `source='bill'` teammate carrying that
 * email) is what later binds it. That is the day this file grows a lookup back
 * — mirroring the poller's `resolveTeammateId` exactly (`lower(email)`,
 * `NOT provisional`, `ORDER BY id`) — not before.
 *
 * `actor_ref` is still carried on every row: it is the provider's own id, it is
 * the grain key's identity term for a future unresolved row, and it is what
 * lets a row be re-derived later without a re-fetch.
 *
 * ── THE WRITE PATTERN: UPSERT, THEN GUARDED PRUNE ────────────────────────────
 *
 * NOT delete-and-replace. An earlier draft specified delete-then-insert in one
 * transaction, and it was wrong for a reason worth recording: every replacement
 * re-homes every row to CURRENT placement, silently, because the row is new. It
 * reintroduces exactly the defect issue #44 exists to fix on
 * `unaccounted_usage`, one table over.
 *
 * So: `INSERT ... ON CONFLICT DO UPDATE` refreshing MEASURES ONLY. `region_id`,
 * `org_unit_id`, `cost_owning_unit_id` and `dimension_source` are DELIBERATELY
 * ABSENT from the SET list — a re-transform refreshes money and never re-homes a
 * historical day. This mirrors `upsertActualSpend` (analytics-poller.ts:212-243),
 * which is the proven pattern for this exact problem.
 *
 * Then a guarded prune for rows the provider revised away, mirroring the
 * poller's (analytics-poller.ts:626-651): scoped to this source and window,
 * keyed on a DB-clock marker, and refused outright when identity resolution
 * looks broken.
 *
 * WHY THE IDENTITY GUARD MATTERS HERE even though nothing is dropped: if a run
 * mis-resolves, it writes rows under `actor:` keys instead of teammate keys, and
 * the prune then deletes the teammate-keyed rows those replaced. The
 * replacements carry NULL homing, so a resolution regression would silently
 * erase historical placement across the window. The guard refuses to prune on
 * such a run.
 *
 * THE GUARD IS EVALUATED BEFORE ANYTHING IS PUBLISHED, and that ordering is the
 * invariant, not a detail. Resolving an actor CHANGES the grain key
 * ('actor:foo@x' → the teammate uuid), so a resolved row INSERTs BESIDE its
 * unresolved predecessor and only the prune removes the predecessor. Upserting
 * first and then refusing the prune would therefore commit BOTH rows — a $5
 * grain becomes $10 and conservation with actual_spend breaks. A refused prune
 * must mean "this run changed nothing", never "this run added rows it cannot
 * clean up", so the decision is taken before the first write and the whole
 * source is skipped when pruning would be unsafe.
 *
 * The guard is DORMANT for the current source: inherited identity is never
 * unresolved (see IDENTITY above), so the ratio is always 0. It is live for the
 * raw-batch source, which is also the only source that can produce the
 * double-count above.
 *
 * ── THE LOCK ─────────────────────────────────────────────────────────────────
 *
 * Routed through `server/db/advisory-lock.ts` (LOCK_NAMESPACE.providerTransform)
 * and keyed on the OWNERSHIP DOMAIN — the source, which encodes the provider org
 * — NOT the window. A window-keyed lock does not serialise OVERLAPPING windows,
 * so two differently-keyed runs could interleave their upserts and prunes.
 *
 * Where this differs from the poller, and why: the poller upserts and prunes
 * with no transaction wrapper, accepting "a transient mix of two revision
 * snapshots" (analytics-poller.ts:618-626). The transform takes the same
 * upsert-then-prune shape — which is what preserves homing — but wraps it in ONE
 * transaction under the registered lock, because nothing reads this table
 * mid-flight and there is no reason to accept the mix. A throw rolls back whole,
 * and the prune sits after the derive loop so a partial run can never remove
 * rows it did not re-assert.
 */
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import { centsStringToUsd } from '../anthropic/enterprise-client'
import { mapProductToTool } from '../../shared/usage/surface'
import { advisoryXactLock } from '../db/advisory-lock'
import { SOURCE_PREFIX } from './analytics-poller'
import {
  accumulate,
  blankFact,
  nonNegInt,
  upsertProviderUsageFact,
  type Db,
  type DerivedFacts,
  type FactRow,
} from './provider-fact'
import {
  deriveGithubFacts,
  discoverGithubConsumptionSources,
  isGithubConsumptionSource,
  COPILOT_CONSUMPTION_SOURCE_PREFIX,
} from './provider-transform-github'

/*
 * PRE-#226 BACKSTOP. #226 (commit 3652c22) added `cost_type` to the cost
 * report's group_by. Before it, the field was null on EVERY row — not because
 * the provider withheld it, but because nothing asked for it
 * (analytics-poller.ts:477-480). Those payloads are a bounded, knowable
 * population, and production already treats their cost as token cost
 * (adapters/anthropic.ts:280-285).
 *
 * So a cost row with no cost_type is stamped 'tokens' HERE, in the transform,
 * rather than admitted into the schema as a nullable-cost-row case. The
 * measure_chk constraint would otherwise have to allow a row that is neither a
 * token row nor a cost row, and the single-GROUP_BY property the design depends
 * on would die with it.
 *
 * This is also why it is a backstop and not a live branch: a defensive branch is
 * not evidence that a case occurs; it can be evidence that it once did.
 */
const PRE_226_COST_TYPE = 'tokens'

/** `{day, usage[], cost[]}` — the shape analytics-poller.ts:591 writes. */
interface EnterprisePayload {
  day?: unknown
  usage?: unknown
  cost?: unknown
}

export interface ProviderTransformOptions {
  /** Inclusive window, YYYY-MM-DD. */
  startingAt: string
  endingAt: string
  /**
   * Scope to a single source — one ownership domain. An Anthropic analytics
   * source (`anthropic-analytics-api[:<externalOrgId>]`, an
   * `actual_spend.source`) or a Copilot consumption source
   * (`copilot-consumption:<enterpriseRef>`). Anything else is REFUSED, never
   * silently derived-and-pruned; see `runProviderTransform`.
   */
  source?: string
}

export interface ProviderTransformResult {
  sourcesProcessed: number
  /** Source-ledger rows read across every arm — `actual_spend` rows on the
   *  Anthropic arm, `reconciliation_record` rows on the GitHub one. */
  sourceRowsRead: number
  providerRowsConsidered: number
  factRowsUpserted: number
  factRowsPruned: number
  /**
   * Payload rows with no bound teammate — CARRIED, not dropped. Structurally 0
   * from BOTH of today's sources: the Anthropic arm inherits identity from
   * `actual_spend` (`teammate_id` NOT NULL) and the GitHub arm from
   * `reconciliation_record` (the adapter drops an unmappable login before a line
   * exists). Non-zero only once a raw-capture source lands
   * (feat/provider-raw-capture, mig 0117), which genuinely can carry one.
   */
  unresolvedActorRows: number
  /** Sources where the prune was refused because identity resolution looked broken. */
  prunesSkipped: number
  window: { startingAt: string; endingAt: string }
}

/*
 * Same threshold and rationale as the poller's stale-row prune
 * (analytics-poller.ts:627). Healthy runs resolve nearly everything; an outsized
 * unresolved share means OUR resolution broke, and pruning then would replace
 * homed rows with unhomed ones.
 */
const PRUNE_MAX_UNRESOLVED_RATIO = 0.5

/** The actor's own id, or null when there is nothing usable to carry.
 *  A deleted actor's email is not carried forward — mirrors the poller's
 *  `actorEmail` (analytics-poller.ts:520-521), which never guesses. */
function actorRefOf(actor: unknown): string | null {
  if (!actor || typeof actor !== 'object') return null
  const a = actor as { email?: unknown; deleted?: unknown }
  if (a.deleted === true) return null
  if (typeof a.email !== 'string') return null
  const trimmed = a.email.trim()
  return trimmed === '' ? null : trimmed
}

/** cache_creation is a nested object of ephemeral lanes; both are cache-write
 *  tokens and the fact grain carries one column for them. */
function cacheCreationOf(row: Record<string, unknown>): number {
  const cc = row.cache_creation
  if (!cc || typeof cc !== 'object') return 0
  const c = cc as Record<string, unknown>
  return nonNegInt(c.ephemeral_5m_input_tokens) + nonNegInt(c.ephemeral_1h_input_tokens)
}

function modelOf(row: Record<string, unknown>): string | null {
  const m = row.model
  if (typeof m !== 'string') return null
  const trimmed = m.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The context-window band (mig 0127), trim-only — the `modelOf` discipline: no
 * silent normalisation, no vocabulary check. The band string is the PROVIDER'S
 * ('0-200k' / '200k+' today, extendable by them tomorrow) and rides into the
 * fact verbatim; NULL — absent key, explicit null (the pre-collection wire
 * state), or a whitespace-only value — is "not banded", which the read side
 * types as its own remainder rather than folding into any band.
 */
function contextWindowOf(row: Record<string, unknown>): string | null {
  const cw = row.context_window
  if (typeof cw !== 'string') return null
  const trimmed = cw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * `server_tool_use.web_search_requests` (mig 0122) — server-side web searches
 * the provider counted on this usage row.
 *
 * RETURNS null, NOT 0, WHEN THE FIELD IS ABSENT, and that distinction is the
 * whole reason this is not `nonNegInt`. "The provider reported zero web
 * searches" and "the provider did not carry the field" are different facts, and
 * a re-derive over a payload captured before the field existed must produce the
 * second one rather than assert the first. An explicit numeric 0 is carried
 * through as 0.
 *
 * No re-poll is needed to populate it: the poller retains each teammate-day's
 * usage rows verbatim in `actual_spend.raw_payload` (analytics-poller.ts:589-591)
 * and `.passthrough()` has been carrying `server_tool_use` into them all along —
 * the 2026-08-02 capture observed it on 257/257 STORED rows. Re-running this
 * worker over the retained window is what fills the column for history.
 */
function webSearchRequestsOf(row: Record<string, unknown>): number | null {
  const stu = row.server_tool_use
  if (!stu || typeof stu !== 'object') return null
  const n = (stu as Record<string, unknown>).web_search_requests
  /*
   * A count we cannot trust is ABSENT, not zero. `n > 0 ? trunc : 0` clamped a
   * negative or fractional value into a positive assertion that the provider
   * reported zero searches — which is a measurement, and destroys the very
   * NULL-vs-0 distinction this column exists to carry.
   *
   * Only a finite non-negative INTEGER is a count. Anything else is absent.
   */
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null
  return n
}

/**
 * THE ANTHROPIC ARM — derive every fact row for ONE Anthropic source's window,
 * accumulated by grain key.
 *
 * Returns the accumulator plus the counters the prune guard needs. Pure of any
 * write, so a throw anywhere in here aborts before a single row is touched.
 */
async function deriveAnthropicFacts(
  db: Db,
  source: string,
  opts: { startingAt: string; endingAt: string },
): Promise<DerivedFacts> {
  const rows = await db.execute<{
    date: string
    source: string
    teammate_id: string | null
    provider_org_id: string | null
    provider_enterprise_id: string | null
    raw_payload: unknown
  }>(
    sql`SELECT date::text AS date, source,
               teammate_id::text AS teammate_id,
               provider_org_id::text AS provider_org_id,
               provider_enterprise_id::text AS provider_enterprise_id,
               raw_payload
          FROM actual_spend
         WHERE source = ${source}
           AND date >= ${opts.startingAt}::date
           AND date <= ${opts.endingAt}::date
           AND raw_payload IS NOT NULL
         ORDER BY date, id`,
  )

  const facts = new Map<string, FactRow>()
  let providerRowsConsidered = 0
  let unresolvedActorRows = 0
  let identityEligibleRows = 0

  const upsertInto = (f: FactRow, merge: (into: FactRow) => void): void => accumulate(facts, f, merge)

  for (const asRow of rows) {
    const payload = asRow.raw_payload as EnterprisePayload | null
    if (!payload || typeof payload !== 'object') continue
    /*
     * The actual_spend row's own `date` is authoritative, not payload.day. They
     * are written equal (analytics-poller.ts:591), but `date` is a typed date
     * column and the row's own grain, whereas payload.day is free-form JSON. A
     * disagreement should not be able to file a fact under a day whose
     * actual_spend row it does not reconcile against.
     */
    const date = asRow.date
    /*
     * IDENTITY IS INHERITED FROM THE ROW, not re-derived from its payload — see
     * the module header's IDENTITY section. `raw_payload` is written PER
     * (teammate, day, tool) and holds only THAT teammate's usage/cost rows
     * (analytics-poller.ts:589-591), so the row's own teammate_id is the
     * authoritative owner of every payload row inside it.
     */
    const base = {
      source: asRow.source,
      provider: 'anthropic' as const,
      providerOrgId: asRow.provider_org_id,
      providerEnterpriseId: asRow.provider_enterprise_id,
      teammateId: asRow.teammate_id,
    }

    // ── usage rows → the TOKEN row (cost_type NULL, no cost) ──────────────
    const usage = Array.isArray(payload.usage) ? payload.usage : []
    for (const raw of usage) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      providerRowsConsidered += 1
      identityEligibleRows += 1
      const actorRef = actorRefOf(row.actor)
      if (!base.teammateId) unresolvedActorRows += 1
      /*
       * ALL FOUR TOKEN LANES, including the two the poller discards
       * (analytics-poller.ts:536-537 keeps only uncached_input + output).
       * Cache is where cost hides, and a dimension not captured is
       * permanently lost.
       */
      const f = blankFact({
        ...base,
        actorRef,
        date,
        tool: mapProductToTool(typeof row.product === 'string' ? row.product : null),
        model: modelOf(row),
        costType: null,
        contextWindow: contextWindowOf(row),
        currency: 'USD',
      })
      const inTok = nonNegInt(row.uncached_input_tokens)
      const outTok = nonNegInt(row.output_tokens)
      const cacheRead = nonNegInt(row.cache_read_input_tokens)
      const cacheCreate = cacheCreationOf(row)
      const reqs = nonNegInt(row.requests)
      const webSearches = webSearchRequestsOf(row)
      upsertInto(f, (into) => {
        into.inputTokens = (into.inputTokens ?? 0) + inTok
        into.outputTokens = (into.outputTokens ?? 0) + outTok
        into.cacheReadTokens = (into.cacheReadTokens ?? 0) + cacheRead
        into.cacheCreationTokens = (into.cacheCreationTokens ?? 0) + cacheCreate
        into.requests = (into.requests ?? 0) + reqs
        /*
         * Guarded so the column stays NULL when NO payload row in this grain
         * carried the field. An unguarded `(into.webSearchRequests ?? 0) + 0`
         * would turn every pre-field row into a positive assertion of zero.
         */
        if (webSearches !== null) {
          into.webSearchRequests = (into.webSearchRequests ?? 0) + webSearches
        }
      })
    }

    // ── cost rows → the COST row (cost_type set, no tokens) ───────────────
    const cost = Array.isArray(payload.cost) ? payload.cost : []
    for (const raw of cost) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      providerRowsConsidered += 1
      identityEligibleRows += 1
      const actorRef = actorRefOf(row.actor)
      if (!base.teammateId) unresolvedActorRows += 1
      /*
       * THE RATE CARD NEVER REACHES THE BILLED LANE. An unparseable amount is
       * warned and SKIPPED, never priced from the card and never coerced to 0.
       * A missing cost is a signal; filling it destroys the signal, and an
       * estimate here would make "only the API writes this lane" false.
       */
      const usd = typeof row.amount === 'string' ? centsStringToUsd(row.amount) : Number.NaN
      if (!Number.isFinite(usd)) {
        consola.warn(
          `[provider-transform] non-numeric cost amount skipped for ${date} (source ${source}) — no fact row written`,
        )
        continue
      }
      const rawCostType = typeof row.cost_type === 'string' ? row.cost_type.trim() : ''
      const f = blankFact({
        ...base,
        actorRef,
        date,
        tool: mapProductToTool(typeof row.product === 'string' ? row.product : null),
        model: modelOf(row),
        // Pre-#226 payloads carry no cost_type — see PRE_226_COST_TYPE.
        costType: rawCostType === '' ? PRE_226_COST_TYPE : rawCostType,
        contextWindow: contextWindowOf(row),
        currency: typeof row.currency === 'string' && row.currency.trim() !== '' ? row.currency.trim() : 'USD',
      })
      upsertInto(f, (into) => {
        into.costUsd = (into.costUsd ?? 0) + usd
      })
    }
  }

  return {
    facts,
    sourceRowsRead: rows.length,
    providerRowsConsidered,
    unresolvedActorRows,
    identityEligibleRows,
  }
}

/**
 * WHICH ARM DERIVES A SOURCE — the one place the provider is decided.
 *
 * Routing on the SOURCE STRING rather than on a provider option is deliberate:
 * the source is the ownership domain the lock, the prune and the fact rows are
 * all keyed on, so a source that no arm claims must never reach the prune. It is
 * refused instead, by `runProviderTransform` before any work starts and again
 * here — a run that derived nothing and then pruned a window would delete rows
 * it never had the ability to re-assert.
 */
function armFor(source: string): ((db: Db, source: string, opts: { startingAt: string; endingAt: string }) => Promise<DerivedFacts>) | null {
  if (source === SOURCE_PREFIX || source.startsWith(`${SOURCE_PREFIX}:`)) return deriveAnthropicFacts
  if (isGithubConsumptionSource(source)) return deriveGithubFacts
  return null
}

function unclaimedSourceMessage(source: string): string {
  return (
    `provider-transform: no arm claims source '${source}'. Expected an Anthropic analytics source ` +
    `('${SOURCE_PREFIX}' or '${SOURCE_PREFIX}:<externalOrgId>') or a Copilot consumption source ` +
    `('${COPILOT_CONSUMPTION_SOURCE_PREFIX}:<enterpriseRef>'). Deriving nothing and then pruning that ` +
    `window would delete rows this worker never had the ability to re-assert.`
  )
}

/**
 * Every source with work in the window, across every arm. Each arm answers for
 * its own lane; the orchestrator only concatenates, so adding a provider adds
 * one line here and nothing else.
 */
async function discoverSources(db: Db, opts: { startingAt: string; endingAt: string }): Promise<string[]> {
  const anthropic = await db.execute<{ source: string }>(
    sql`SELECT DISTINCT source
          FROM actual_spend
         WHERE date >= ${opts.startingAt}::date
           AND date <= ${opts.endingAt}::date
           AND raw_payload IS NOT NULL
           AND (source = ${SOURCE_PREFIX} OR source LIKE ${`${SOURCE_PREFIX}:%`})
         ORDER BY source`,
  )
  const github = await discoverGithubConsumptionSources(db, opts)
  return [...anthropic.map((r) => r.source), ...github]
}

/** Transform one source's window. Assumes it is already inside the transaction
 *  that holds this source's advisory lock. */
async function transformSource(
  db: Db,
  source: string,
  opts: { startingAt: string; endingAt: string },
): Promise<{
  sourceRowsRead: number
  providerRowsConsidered: number
  factRowsUpserted: number
  factRowsPruned: number
  unresolvedActorRows: number
  pruneSkipped: boolean
}> {
  const derive = armFor(source)
  if (!derive) throw new Error(unclaimedSourceMessage(source))
  /*
   * DB-clock marker for the prune, read INSIDE the transaction: rows this run
   * touches get their statement's now() (>= this), rows it never re-asserts keep
   * an older pulled_at. DB time, not Date.now() — app/DB clock skew must not
   * widen or shrink the prune window.
   *
   * now() is the TRANSACTION timestamp, so it is stable for the whole run and
   * every upsert's pulled_at equals this marker exactly. The prune therefore
   * uses a strict `<`, which keeps this run's own rows.
   */
  const [clock] = await db.execute<{ run_started: string }>(
    sql`SELECT now()::timestamptz AS run_started`,
  )
  if (!clock) throw new Error('provider-transform: could not read the DB clock for the prune marker')
  const runStarted = clock.run_started

  const derived = await derive(db, source, opts)

  /*
   * THE PRUNE GUARD IS EVALUATED BEFORE THE FIRST UPSERT — see the module
   * header. Resolving an actor changes the grain key, so a resolved row INSERTs
   * BESIDE its unresolved predecessor and only the prune removes the
   * predecessor. Upserting first and then refusing the prune would commit both,
   * doubling that grain's money and breaking conservation with actual_spend. A
   * refused prune therefore publishes NOTHING for this source: the run reports
   * what it would have written and leaves the table exactly as it found it.
   *
   * Every arm is pure of any write, so returning here leaves the
   * transaction with no statement to roll back.
   */
  const unresolvedRatio =
    derived.identityEligibleRows > 0 ? derived.unresolvedActorRows / derived.identityEligibleRows : 0
  if (unresolvedRatio > PRUNE_MAX_UNRESOLVED_RATIO) {
    consola.warn(
      `[provider-transform] skipping stale-row prune for ${source}: ${derived.unresolvedActorRows}/${derived.identityEligibleRows} payload rows failed to bind a teammate (ratio ${unresolvedRatio.toFixed(2)} > ${PRUNE_MAX_UNRESOLVED_RATIO}) — identity resolution looks broken, and pruning would replace homed rows with unhomed ones; publishing nothing for this source`,
    )
    return {
      sourceRowsRead: derived.sourceRowsRead,
      providerRowsConsidered: derived.providerRowsConsidered,
      factRowsUpserted: 0,
      factRowsPruned: 0,
      unresolvedActorRows: derived.unresolvedActorRows,
      pruneSkipped: true,
    }
  }

  let factRowsUpserted = 0
  for (const f of derived.facts.values()) {
    await upsertProviderUsageFact(db, f)
    factRowsUpserted += 1
  }

  /*
   * GUARDED PRUNE — rows the provider revised away, mirroring
   * analytics-poller.ts:626-651. Reached only after EVERY row in the window
   * derived and wrote successfully: a throw above aborts the transaction, so a
   * partial run can never delete rows it did not get the chance to re-assert.
   */
  const pruned = await db.execute<{ id: string }>(
    sql`DELETE FROM provider_usage_fact
         WHERE source = ${source}
           AND date >= ${opts.startingAt}::date
           AND date <= ${opts.endingAt}::date
           AND pulled_at < ${runStarted}::timestamptz
       RETURNING id::text AS id`,
  )

  return {
    sourceRowsRead: derived.sourceRowsRead,
    providerRowsConsidered: derived.providerRowsConsidered,
    factRowsUpserted,
    factRowsPruned: pruned.length,
    unresolvedActorRows: derived.unresolvedActorRows,
    pruneSkipped: false,
  }
}

export async function runProviderTransform(
  db: Db,
  opts: ProviderTransformOptions,
): Promise<ProviderTransformResult> {
  const result: ProviderTransformResult = {
    sourcesProcessed: 0,
    sourceRowsRead: 0,
    providerRowsConsidered: 0,
    factRowsUpserted: 0,
    factRowsPruned: 0,
    unresolvedActorRows: 0,
    prunesSkipped: 0,
    window: { startingAt: opts.startingAt, endingAt: opts.endingAt },
  }

  /*
   * AN EXPLICIT source IS SHAPE-CHECKED, because every arm hardcodes its
   * provider AND its payload shape. Pointed at a source no arm claims, a run
   * would derive nothing and then PRUNE that source's window — deleting rows it
   * never had the ability to re-assert. That is a data-loss bug, not a no-op, so
   * it is refused here (and again in `transformSource`, which is what the
   * discovered-source path goes through).
   */
  if (opts.source && !armFor(opts.source)) throw new Error(unclaimedSourceMessage(opts.source))

  /*
   * The ownership domain is the SOURCE, so one transaction + one lock per
   * source. Each arm discovers its own from the DATA rather than from a registry
   * table, which keeps this in step with whatever each writer actually wrote —
   * including Anthropic's legacy un-suffixed source.
   */
  const sources = opts.source ? [opts.source] : await discoverSources(db, opts)

  for (const source of sources) {
    /*
     * ONE TRANSACTION PER SOURCE, holding that source's advisory lock for its
     * whole duration. Atomic publication: a reader sees the whole old set or the
     * whole new one, never a mix. Per-source rather than one big transaction so
     * a failure on one provider org cannot roll back another's completed work.
     */
    const perSource = await db.transaction(async (tx) => {
      await tx.execute(advisoryXactLock('providerTransform', source))
      return transformSource(tx as unknown as Db, source, opts)
    })
    result.sourcesProcessed += 1
    result.sourceRowsRead += perSource.sourceRowsRead
    result.providerRowsConsidered += perSource.providerRowsConsidered
    result.factRowsUpserted += perSource.factRowsUpserted
    result.factRowsPruned += perSource.factRowsPruned
    result.unresolvedActorRows += perSource.unresolvedActorRows
    if (perSource.pruneSkipped) result.prunesSkipped += 1
  }

  return result
}
