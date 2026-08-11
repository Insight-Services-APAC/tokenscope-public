/*
 * provider-fact — the one shape every provider adapter normalises INTO, and the
 * one statement that writes it.
 *
 * `provider_usage_fact` is the NORMALISED layer
 * (docs/design/reporting-consolidation/04-prototype-delta.md §2): one table,
 * `provider text NOT NULL` as its discriminator (mig `0118:44-45`, no CHECK
 * restricting the value), every provider landing through its own adapter. A
 * provider is added by writing an adapter — a derive function that returns
 * {@link DerivedFacts} — and never by touching reporting.
 *
 * This module exists so that claim is structural rather than aspirational: the
 * grain key, the accumulator contract and the upsert live here, once, and every
 * arm shares them. Two arms with two hand-written upserts would be two chances
 * to drift from mig 0118's unique index.
 *
 * The arms:
 *   - `provider-transform.ts`         — Anthropic, from `actual_spend.raw_payload`
 *   - `provider-transform-github.ts`  — GitHub Copilot, from `reconciliation_record.raw`
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import {
  teammateDimensionSnapshotSql,
  DIMENSION_SOURCE_INGEST_SNAPSHOT,
} from '../reconciliation/dimension-snapshot'

export type Db = PostgresJsDatabase<typeof schema>

/** `provider_usage_fact.provider` values. The column has no CHECK — this union
 *  is the TypeScript-side statement of the same set (mig 0118:44-45). */
export type FactProvider = 'anthropic' | 'github'

/**
 * One derived fact row, accumulated by grain key before any write.
 *
 * AGGREGATION IS NOT OPTIONAL. `ON CONFLICT DO UPDATE` assigns EXCLUDED values,
 * so two source rows landing on one grain key would let the second CLOBBER the
 * first rather than sum with it — the same defect the poller's ING-4 aggregate
 * exists to prevent (analytics-poller.ts:296-299). It is reachable on BOTH arms:
 * on the Anthropic arm the usage report groups by `product` and several products
 * map to one tool lane; on the GitHub arm one reconciliation ledger row can
 * carry several merged logins' records (engine.ts:166), and one model appears
 * under several features within a single record.
 */
export interface FactRow {
  source: string
  provider: FactProvider
  providerOrgId: string | null
  providerEnterpriseId: string | null
  teammateId: string | null
  actorRef: string | null
  date: string
  tool: string
  model: string | null
  costType: string | null
  /**
   * Anthropic's context-window band, verbatim from the wire ('0-200k' /
   * '200k+' today — the vocabulary is the provider's to extend, mig 0127).
   * A GRAIN dimension, not a measure: it is part of {@link grainKey} and the
   * unique index. NULL = the capture predates collection (un-banded history)
   * or the provider carries no such dimension (every GitHub row).
   */
  contextWindow: string | null
  currency: string
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  requests: number | null
  /**
   * Anthropic's `server_tool_use.web_search_requests` (mig 0122). Rides the
   * TOKEN row alongside `requests`; NULL on every GitHub row, and NULL — not 0 —
   * when the provider did not carry the field.
   */
  webSearchRequests: number | null
}

/**
 * What every arm returns. Pure of any write, so a throw anywhere inside a derive
 * aborts before a single row is touched — which is what lets the orchestrator
 * evaluate its prune guard BEFORE publishing anything (see
 * provider-transform.ts's module header).
 */
export interface DerivedFacts {
  facts: Map<string, FactRow>
  /** Source-ledger rows read (`actual_spend` rows / `reconciliation_record` rows). */
  sourceRowsRead: number
  /** Provider payload rows considered inside those source rows. */
  providerRowsConsidered: number
  /** Payload rows that bound no teammate — CARRIED, never dropped. */
  unresolvedActorRows: number
  /** Payload rows an identity could in principle have been resolved for; the
   *  denominator of the prune guard's ratio. */
  identityEligibleRows: number
}

export function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0
}

/*
 * The grain key, matching the unique-index expression (mig 0118, extended by
 * mig 0127 with the context_window member) exactly.
 *
 * The separator is written as an ESCAPE, never as a literal NUL byte in the
 * source (the defect fixed by commit d040a35). It must be a character no
 * dimension can contain — a printable separator would let a tool named 'a:b'
 * collide with a tool 'a' and a model 'b'.
 */
export function grainKey(f: FactRow): string {
  const identity = f.teammateId ?? `actor:${(f.actorRef ?? '').toLowerCase()}`
  // contextWindow is a grain member since mig 0127 — this list must match the
  // index expression exactly or in-run dedup silently diverges from at-rest
  // dedup (two bands would merge here and land as one mislabelled row there).
  return [
    f.source,
    identity,
    f.date,
    f.tool,
    f.model ?? '',
    f.costType ?? '',
    f.contextWindow ?? '',
  ].join('\u0000')
}

export function blankFact(
  base: Omit<
    FactRow,
    | 'costUsd'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'cacheCreationTokens'
    | 'requests'
    | 'webSearchRequests'
  >,
): FactRow {
  return {
    ...base,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    requests: null,
    webSearchRequests: null,
  }
}

/**
 * Accumulate one fact into the map under its grain key, merging when the key is
 * already present. `merge` receives the row that will be stored — the existing
 * one on a collision, the new one otherwise — so a caller writes its measure
 * addition once and it is correct either way.
 */
export function accumulate(facts: Map<string, FactRow>, f: FactRow, merge: (into: FactRow) => void): void {
  const key = grainKey(f)
  const existing = facts.get(key)
  if (existing) {
    merge(existing)
    return
  }
  merge(f)
  facts.set(key, f)
}

/*
 * Exported and shared by every arm, deliberately, and for the same reason
 * `upsertActualSpend` is: the ON CONFLICT clause's OMISSIONS are the invariant.
 * Re-implementing this statement per arm — or in a test — would duplicate the
 * very SQL whose behaviour is under test, so the seam is here. A second arm with
 * its own INSERT could keep passing while it re-homed every row.
 */
export async function upsertProviderUsageFact(db: Db, f: FactRow): Promise<void> {
  const teammateIdSql = sql`${f.teammateId}::uuid`
  /*
   * The homing subqueries resolve the teammate's CURRENT placement. With a NULL
   * teammate they yield NULL naturally (`WHERE t.id = NULL` matches nothing), so
   * an unresolved row homes nowhere — which is the design's requirement, not an
   * accident of SQL. Never guess a placement for an identity we have not
   * resolved.
   */
  const dims = teammateDimensionSnapshotSql(teammateIdSql)
  await db.execute(
    sql`
      INSERT INTO provider_usage_fact
        (source, provider, provider_org_id, provider_enterprise_id,
         teammate_id, actor_ref, date, tool, model, cost_type, context_window,
         region_id, org_unit_id, cost_owning_unit_id, dimension_source,
         cost_usd, currency, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, requests, web_search_requests)
      VALUES
        (${f.source}, ${f.provider}, ${f.providerOrgId}::uuid, ${f.providerEnterpriseId}::uuid,
         ${f.teammateId}::uuid, ${f.actorRef}, ${f.date}::date, ${f.tool}, ${f.model}, ${f.costType},
         ${f.contextWindow},
         ${dims.regionId}, ${dims.orgUnitId}, ${dims.costOwningUnitId}, ${DIMENSION_SOURCE_INGEST_SNAPSHOT},
         ${f.costUsd === null ? null : f.costUsd.toFixed(6)}::numeric, ${f.currency},
         ${f.inputTokens}::bigint, ${f.outputTokens}::bigint,
         ${f.cacheReadTokens}::bigint, ${f.cacheCreationTokens}::bigint, ${f.requests}::bigint,
         ${f.webSearchRequests}::bigint)
      ON CONFLICT (source, COALESCE(teammate_id::text, 'actor:' || lower(actor_ref)),
                   date, tool, COALESCE(model, ''), COALESCE(cost_type, ''), COALESCE(context_window, ''))
      DO UPDATE SET
        cost_usd = EXCLUDED.cost_usd,
        currency = EXCLUDED.currency,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cache_read_tokens = EXCLUDED.cache_read_tokens,
        cache_creation_tokens = EXCLUDED.cache_creation_tokens,
        requests = EXCLUDED.requests,
        web_search_requests = EXCLUDED.web_search_requests,
        provider = EXCLUDED.provider,
        provider_org_id = EXCLUDED.provider_org_id,
        provider_enterprise_id = EXCLUDED.provider_enterprise_id,
        actor_ref = EXCLUDED.actor_ref,
        pulled_at = now()
      /*
       * raw_batch_id and data_refreshed_at are absent from BOTH lists on
       * purpose. Neither arm's source (actual_spend.raw_payload /
       * reconciliation_record.raw) carries either, so EXCLUDED would hold their
       * column DEFAULT — NULL — and assigning that would ERASE a batch id or
       * settle marker written by a future raw-capture writer on every
       * re-transform. A column an arm cannot derive is one it must not
       * overwrite.
       *
       * region_id, org_unit_id, cost_owning_unit_id and dimension_source are
       * DELIBERATELY ABSENT above. A re-transform refreshes money and NEVER
       * re-homes a historical day. Adding any of them here reintroduces issue
       * #44's defect and turns
       * tests/integration/provider/provider-transform.test.ts's
       * "a re-transform never re-homes" red — on both arms.
       *
       * teammate_id is absent too, and must stay absent: it is part of the
       * conflict key, so a conflict means it already equals EXCLUDED's. When an
       * actor RESOLVES the key changes, which makes that a fresh INSERT — the
       * first stamp of homing, not a refresh of it.
       */
    `,
  )
}
