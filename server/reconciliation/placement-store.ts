/*
 * SQL adapter for the PlacementStore port (placement-service.ts). All money/region
 * correctness that can't be expressed in the pure layer lives here and is
 * integration-tested against testcontainers Postgres in CI:
 *   - bill teammates get an `entra_oid='bill:'||uuid` placeholder, source='bill',
 *     non-provisional (so the money path's `NOT provisional` filter accepts them);
 *   - region_id is NEVER set by us — the mig-0066 trigger derives it from
 *     org_unit_id (the H-A invariant);
 *   - replayOwedBills drains pending_placement → actual_spend idempotently.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import type { PlacementStore } from './placement-service'
import type { OwnedUnit, RegionRuleSet } from './region-derivation'
import type { RegionAttributeKey } from '../../shared/placement/region-attributes'

type Db = PostgresJsDatabase<typeof schema>

export function makePlacementStore(db: Db): PlacementStore {
  return {
    async findTeammateByEmail(email) {
      // Join the home unit so the caller can tell a deliberately-placed teammate
      // (real node) from one still on __UNPLACED__ — only the latter may be re-homed
      // by the bill path (see provisionAndPlace). org_unit_id is NOT NULL, so the
      // join never drops the row.
      //
      // rehome_safe (mig-0068 cross-region safety): a (re)home can move the teammate to
      // a DIFFERENT region (cost-centre match or derived region), which changes their RLS
      // scope. The admin region-PATCH runs a revoke cascade (revoked_at + end instances +
      // revoke OAuth) for exactly this reason; the worker's homeTeammate does NOT. So the
      // worker may only auto-move a teammate that is (a) a never-adopted bill placeholder
      // AND (b) has NO live emit instance AND no live OAuth credential — i.e. no live
      // session to re-scope (mirrors the admin region-PATCH revoke cascade, which ends
      // both). Anything with a real oid or a live credential is left for the admin worklist.
      const rows = await db.execute<{ id: string; on_unplaced: boolean; rehome_safe: boolean }>(sql`
        SELECT t.id::text AS id,
               (ou.code = '__UNPLACED__') AS on_unplaced,
               (t.entra_oid LIKE 'bill:%'
                AND NOT EXISTS (
                  SELECT 1 FROM instance_attestation ia
                  WHERE ia.teammate_id = t.id AND ia.ts_actual_end IS NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM oauth_token o
                  WHERE o.teammate_id = t.id AND o.revoked_at IS NULL
                )) AS rehome_safe
        FROM teammate t JOIN org_unit ou ON ou.id = t.org_unit_id
        WHERE lower(t.email) = lower(${email}) AND NOT t.provisional
        ORDER BY t.id LIMIT 1`)
      const r = rows[0]
      return r ? { id: r.id, onUnplaced: r.on_unplaced, rehomeSafe: r.rehome_safe } : null
    },

    async loadCostOwningCandidates() {
      const rows = await db.execute<{ org_unit_id: string; region_id: string; cost_centre_code: string }>(sql`
        SELECT id::text AS org_unit_id, region_id::text AS region_id, cost_centre_code
        FROM org_unit
        WHERE is_cost_owning_unit AND retired_at IS NULL AND cost_centre_code IS NOT NULL`)
      return rows.map((r) => ({ orgUnitId: r.org_unit_id, regionId: r.region_id, costCentreCode: r.cost_centre_code }))
    },

    async unplacedOrgUnitId() {
      // Create-on-demand (NOT migration-seeded — a seed pollutes other tests'
      // `SELECT ... FROM region/org_unit LIMIT 1` fixtures). Idempotent.
      await db.execute(sql`
        INSERT INTO region (id, code, display_name)
        VALUES (gen_random_uuid(), '__unassigned__', 'Unassigned')
        ON CONFLICT (code) DO NOTHING`)
      await db.execute(sql`
        INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
        SELECT gen_random_uuid(), r.id, 'unassigned'::ltree, '__UNPLACED__', 'Unplaced', 'holding', false
        FROM region r WHERE r.code = '__unassigned__'
        ON CONFLICT (region_id, code) DO NOTHING`)
      const rows = await db.execute<{ id: string }>(sql`
        SELECT ou.id::text AS id
        FROM org_unit ou JOIN region r ON r.id = ou.region_id
        WHERE r.code = '__unassigned__' AND ou.code = '__UNPLACED__' LIMIT 1`)
      const id = rows[0]?.id
      if (!id) throw new Error('placement: failed to create __UNPLACED__ holding node')
      return id
    },

    async unplacedOrgUnitIdForRegion(regionId) {
      // Per-region __UNPLACED__ holding node (mig 0068), create-on-demand + idempotent.
      // Same code '__UNPLACED__' as the global node but a distinct region — the
      // (region_id, code) unique lets per-region holding nodes coexist. The ltree path
      // is a single sanitised label (hyphens → _) so codes like 'north-america' are valid
      // ltree. The finance rollup anchors on teammate.region_id (trigger-derived), so a
      // user homed here rolls up to THIS region's report.
      await db.execute(sql`
        INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
        SELECT gen_random_uuid(), r.id,
               (regexp_replace(r.code, '[^a-z0-9]', '_', 'g') || '_unplaced')::ltree,
               '__UNPLACED__', 'Unplaced', 'holding', false
        FROM region r WHERE r.id = ${regionId}::uuid
        ON CONFLICT (region_id, code) DO NOTHING`)
      const rows = await db.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM org_unit
        WHERE region_id = ${regionId}::uuid AND code = '__UNPLACED__' LIMIT 1`)
      const id = rows[0]?.id
      if (!id) throw new Error(`placement: failed to create __UNPLACED__ holding node for region ${regionId}`)
      return id
    },

    async loadDirectoryRegionRules(): Promise<RegionRuleSet> {
      // Curated (attribute, match_value, match_mode) → region rules. Cached per run
      // by the caller; small table. Exact rules → a keyed map (O(1)); prefix rules →
      // a list scanned longest-first so the most specific prefix wins.
      const rows = await db.execute<{
        attribute: string
        match_value: string
        match_mode: string
        region_id: string
      }>(sql`
        SELECT attribute, match_value, match_mode, region_id::text AS region_id
        FROM directory_region_rule`)
      const exact: RegionRuleSet['exact'] = new Map()
      const prefix: RegionRuleSet['prefix'] = []
      for (const r of rows) {
        const attr = r.attribute as RegionAttributeKey
        if (r.match_mode === 'prefix') {
          prefix.push({ attribute: attr, value: r.match_value, regionId: r.region_id })
        } else {
          let m = exact.get(attr)
          if (!m) {
            m = new Map()
            exact.set(attr, m)
          }
          m.set(r.match_value, r.region_id)
        }
      }
      prefix.sort((a, b) => b.value.length - a.value.length)
      return { exact, prefix }
    },

    async loadActiveRegionLeaders() {
      // leader_oid → region_id, active rows only (the manager-walk fallback target).
      const rows = await db.execute<{ leader_oid: string; region_id: string }>(sql`
        SELECT leader_oid, region_id::text AS region_id
        FROM region_leader WHERE revoked_at IS NULL`)
      return new Map(rows.map((r) => [r.leader_oid, r.region_id]))
    },

    async loadActiveUnitOwners() {
      // owner's real Entra oid → the cost-owning unit(s) they actively own (cou_owner). The
      // owner oid is the manager-chain match key, so exclude owners without a REAL oid
      // (bill:/provisional: placeholders can't appear in a chain). An owner may own >1 unit
      // (the resolver treats that as ambiguous). The target is the OWNED unit, independent
      // of where the owner teammate is themselves homed.
      const rows = await db.execute<{ owner_oid: string; org_unit_id: string; region_id: string }>(sql`
        SELECT t.entra_oid AS owner_oid, ou.id::text AS org_unit_id, ou.region_id::text AS region_id
        FROM cou_owner co
        JOIN teammate t ON t.id = co.teammate_id
        JOIN org_unit ou ON ou.id = co.org_unit_id
        WHERE co.revoked_at IS NULL
          AND t.entra_oid NOT LIKE 'bill:%' AND t.entra_oid NOT LIKE 'provisional:%'
          AND ou.is_cost_owning_unit AND ou.retired_at IS NULL`)
      const map = new Map<string, OwnedUnit[]>()
      for (const r of rows) {
        const arr = map.get(r.owner_oid) ?? []
        arr.push({ orgUnitId: r.org_unit_id, regionId: r.region_id })
        map.set(r.owner_oid, arr)
      }
      return map
    },

    async createBillTeammate({ email, displayName, orgUnitId }) {
      // region_id is provided AND re-derived by the trigger (belt-and-suspenders);
      // entra_oid placeholder keeps the row inert until a real login adopts it.
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO teammate (entra_oid, email, display_name, org_unit_id, region_id, source, provisional)
        VALUES ('bill:' || gen_random_uuid(), lower(${email}), ${displayName},
                ${orgUnitId}::uuid,
                (SELECT region_id FROM org_unit WHERE id = ${orgUnitId}::uuid),
                'bill', false)
        RETURNING id::text AS id`)
      return rows[0]!.id
    },

    async homeTeammate(teammateId, orgUnitId) {
      // org_unit_id only; region_id follows via the mig-0066 trigger.
      await db.execute(sql`
        UPDATE teammate SET org_unit_id = ${orgUnitId}::uuid, last_sync_at = now()
        WHERE id = ${teammateId}::uuid`)
    },

    async setPlacementProvenance(teammateId, prov) {
      // Manager-chain unit-placement provenance on teammate.metadata. Set so re-enrichment
      // can re-derive the person when their Entra manager changes; cleared on a non-unit
      // home. Merge/strip only the placed* keys (preserve other metadata).
      if (prov) {
        await db.execute(sql`
          UPDATE teammate
          SET metadata = coalesce(metadata, '{}'::jsonb)
            || jsonb_build_object('placedVia', 'manager-chain', 'placedOwnerOid', ${prov.ownerOid}::text, 'placedAt', now())
          WHERE id = ${teammateId}::uuid`)
      } else {
        await db.execute(sql`
          UPDATE teammate
          SET metadata = (coalesce(metadata, '{}'::jsonb) - 'placedVia' - 'placedOwnerOid' - 'placedAt')
          WHERE id = ${teammateId}::uuid
            AND metadata ? 'placedVia'`)
      }
    },

    async replayOwedBills(teammateId, email) {
      // One statement: lock the owed rows, upsert them into actual_spend, mark them
      // placed. Idempotent — a re-run sees placed_at IS NOT NULL and is a no-op.
      const rows = await db.execute<{ cnt: string }>(sql`
        WITH owed AS (
          SELECT id, actual_source, tool, date, cost_usd, input_tokens, output_tokens, raw_payload
          FROM pending_placement
          WHERE lower(identity_email) = lower(${email}) AND placed_at IS NULL
          FOR UPDATE
        ), ins AS (
          INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, raw_payload)
          SELECT ${teammateId}::uuid, o.date, o.tool, o.input_tokens, o.output_tokens, o.cost_usd, o.actual_source, o.raw_payload
          FROM owed o
          ON CONFLICT (teammate_id, date, tool, source) DO UPDATE SET
            cost_usd = EXCLUDED.cost_usd, input_tokens = EXCLUDED.input_tokens,
            output_tokens = EXCLUDED.output_tokens, raw_payload = EXCLUDED.raw_payload, pulled_at = now()
        ), upd AS (
          UPDATE pending_placement SET placed_at = now() WHERE id IN (SELECT id FROM owed) RETURNING 1
        )
        SELECT count(*)::text AS cnt FROM owed`)
      return Number(rows[0]?.cnt ?? 0)
    },
  }
}

/* Enqueue an owed bill for an as-yet-unprovisioned identity (the bill writers call
 * this instead of dropping unknown emails). Idempotent on the natural bill key;
 * refreshes the amount + last_seen on re-poll. */
export async function enqueueOwedBill(
  db: Db,
  o: {
    provider: string
    actualSource: string
    email: string
    tool: string
    date: string
    costUsd: number
    inputTokens?: number
    outputTokens?: number
    raw?: unknown
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO pending_placement
      (provider, actual_source, identity_email, tool, date, cost_usd, input_tokens, output_tokens, raw_payload)
    VALUES (${o.provider}, ${o.actualSource}, lower(${o.email}), ${o.tool}, ${o.date}::date,
            ${o.costUsd.toFixed(6)}::numeric, ${o.inputTokens ?? 0}::bigint, ${o.outputTokens ?? 0}::bigint,
            ${o.raw === undefined ? null : JSON.stringify(o.raw)}::jsonb)
    ON CONFLICT (provider, actual_source, identity_email, tool, date) DO UPDATE SET
      cost_usd = EXCLUDED.cost_usd, input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens, raw_payload = EXCLUDED.raw_payload, last_seen_at = now()`)
}
