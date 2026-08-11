-- 0118 — provider_usage_fact: the BILLED lane.
--
-- docs/design/target-state-data-architecture.md §6. Read that first; this file
-- is the DDL it specifies, and the reasoning lives there.
--
-- WHAT THIS IS FOR. 58% of Dev's spend renders as "not split by model" — not
-- because the providers withhold the model (both send it on every row) but
-- because the model axis is built from OTel, which covers ~5% of the estate,
-- while the provider API carries the dimension for 100% of it. This table is
-- the lane the API writes: teammate · day · tool · MODEL · cost_type. The model
-- report reads it, so the 58% bucket disappears without any join to OTel, any
-- coverage ratio, or any model-name normalisation.
--
-- INERT ON ARRIVAL (T0). Nothing reads this table yet. No view, no route, no
-- report. It is written by the provider-transform worker and read by nobody, so
-- shipping it moves no figure on any surface.
--
-- WHY A NEW TABLE INSTEAD OF RE-GRAINING actual_spend. Three §B chargeback
-- views read actual_spend directly (0059:36, 0085:53, 0085:133). Adding `model`
-- to its unique key would change the row population the money path aggregates
-- over. actual_spend is untouched; the two reconcile instead:
--   Σ provider_usage_fact.cost_usd = actual_spend.cost_usd
-- per (teammate, date, tool, source), applying the same org-grain
-- web_search/code_execution exclusion the poller applies.

CREATE TABLE provider_usage_fact (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /*
   * LINEAGE — which capture produced this row.
   *
   * DELIBERATELY UNREFERENCED. The design's DDL carries
   * `REFERENCES raw_provider_batch(id)`, and that table is migration 0117 on
   * the UNMERGED branch feat/provider-raw-capture. It does not exist here, and
   * a migration with a dangling REFERENCES clause does not apply at all — it
   * would take down every environment and every test DB on the next migrate.
   *
   * So the column is a plain nullable uuid: it holds the batch id when a raw
   * writer supplies one, and NULL otherwise (the transform's current source,
   * actual_spend.raw_payload, has no batch id to carry). When 0117 lands, a
   * follow-up migration adds the FK. Do NOT add it here.
   */
  raw_batch_id           uuid,
  source                 text NOT NULL,          -- mirrors actual_spend.source
  provider               text NOT NULL,          -- 'anthropic' | 'github'
  provider_org_id        uuid REFERENCES provider_org(id),
  provider_enterprise_id uuid REFERENCES provider_enterprise(id),

  -- IDENTITY: an unresolved actor is CARRIED, never dropped. The money was
  -- spent; the org total must match the invoice whether or not we know who.
  teammate_id            uuid REFERENCES teammate(id),
  actor_ref              text,                   -- provider's own id (email / login)

  -- GRAIN
  date                   date NOT NULL,
  tool                   text NOT NULL,
  model                  text,                   -- the point of all this
  cost_type              text,                   -- NULL = the token row (see below)

  /*
   * HISTORICAL HOMING — stamped at INSERT, never refreshed (mirrors
   * actual_spend, mig 0101 + server/reconciliation/dimension-snapshot.ts).
   *
   * Regional and cost-centre scope resolve these columns
   * (server/reporting/engine/scope.ts:65-72, drivers.ts:195-208), so a fact
   * grain without them cannot serve a scoped model axis at all.
   *
   * NULL on an unresolved row: a row with no teammate has no placement, and we
   * never guess one. The stated consequence is that
   * Σ(cost-centre totals) < org total by exactly the unresolved amount, which
   * the reader surfaces as its own "not yet attributed to a person" line.
   *
   * dimension_source stays NOT NULL even then — the snapshot WAS taken at
   * ingest, it simply resolved to nothing. It records HOW the homing was
   * derived, not WHETHER it found anything.
   */
  region_id              uuid REFERENCES region(id),
  org_unit_id            uuid REFERENCES org_unit(id),
  cost_owning_unit_id    uuid REFERENCES org_unit(id),
  dimension_source       text NOT NULL DEFAULT 'ingest-snapshot',

  -- MEASURES
  cost_usd               numeric(14,6),
  currency               text NOT NULL DEFAULT 'USD',
  input_tokens           bigint,
  output_tokens          bigint,
  cache_read_tokens      bigint,
  cache_creation_tokens  bigint,
  requests               bigint,

  pulled_at              timestamptz NOT NULL DEFAULT now(),
  data_refreshed_at      timestamptz             -- the provider's own settle marker
);

/*
 * RETENTION: UNRESOLVED, and deliberately recorded as unresolved rather than
 * left unsaid. Coupled to raw-capture retention (#41) and to be settled with
 * it. This table is DERIVED from raw and rebuildable only while raw survives;
 * if raw is pruned it becomes the sole copy of model-grain history. The failure
 * mode this comment exists to prevent is that it becomes permanent by accident.
 * Current de-facto policy: permanent, pending #41.
 */
COMMENT ON TABLE provider_usage_fact IS
  'The BILLED lane (target-state-data-architecture.md §6): teammate/day/tool/model/cost_type facts derived from provider API captures. Only the provider API writes it. Retention unresolved pending #41.';

/*
 * NULL-SAFE GRAIN KEY.
 *
 * Postgres treats every NULL as distinct, so a plain unique index over nullable
 * dimensions (model, cost_type, teammate_id) dedupes NOTHING — every re-run
 * would insert a fresh duplicate. This is the defect that sank an earlier
 * transform draft, so the key COALESCEs every nullable member.
 *
 * The key MUST carry actor_ref. Without it, every unresolved actor sharing a
 * (source, date, tool, model, cost_type) collapses onto one sentinel row and
 * overwrites the others — silent data loss on exactly the rows the design
 * promises to carry. Resolved rows key on the teammate; unresolved rows key on
 * the provider's own id, lower()ed so a case difference is not a new row.
 *
 * CONSEQUENCE WORTH KNOWING (it is a feature, not an oversight): resolving an
 * actor CHANGES this key, from 'actor:foo@x' to the teammate uuid. So
 * resolution is a fresh INSERT — the first stamp of homing, not a refresh of it
 * — and the stale unresolved row is removed by the transform's guarded prune
 * because that run did not re-assert it. §6: "Resolution is the FIRST stamp,
 * not a refresh."
 */
CREATE UNIQUE INDEX provider_usage_fact_grain_uidx ON provider_usage_fact (
  source,
  COALESCE(teammate_id::text, 'actor:' || lower(actor_ref)),
  date, tool, COALESCE(model, ''), COALESCE(cost_type, '')
);

-- Exactly one usable identity key, always. Without this, a row with neither a
-- teammate nor an actor produces a NULL index entry, which Postgres treats as
-- distinct from everything — so it would dedupe against nothing and multiply on
-- every run.
ALTER TABLE provider_usage_fact ADD CONSTRAINT provider_usage_fact_identity_chk
  CHECK (teammate_id IS NOT NULL OR nullif(btrim(actor_ref), '') IS NOT NULL);

/*
 * MEASURE EXCLUSIVITY — a token row carries no cost, a cost row carries no
 * tokens. This is the property that makes a single GROUP BY correct:
 *
 *   SELECT model, SUM(cost_usd), SUM(input_tokens + output_tokens)
 *     FROM provider_usage_fact GROUP BY model
 *
 * SUM(cost_usd) ignores token rows (their cost is NULL); SUM(input_tokens)
 * ignores cost rows. Nothing multiplies when both reports are loaded, and no
 * filter or merged view is needed.
 *
 * It is faithful to the source, not an invention: the usage report groups by
 * [product, model] and carries token lanes with no cost; the cost report groups
 * by [product, model, cost_type] and carries an amount with no tokens
 * (analytics-poller.ts:470-488). Merging them into one row per model was
 * rejected — it would fabricate a correspondence the source does not have,
 * since web_search cost carries no tokens at all.
 *
 * NOTE: `requests` is deliberately OUTSIDE this constraint. It is a property of
 * the usage report and rides the token row; the cost report documents it as
 * NULL whenever cost_type is grouped (enterprise-client.ts:86-97).
 */
ALTER TABLE provider_usage_fact ADD CONSTRAINT provider_usage_fact_measure_chk
  CHECK (
    (cost_type IS NULL AND cost_usd IS NULL)
    OR (cost_type IS NOT NULL AND input_tokens IS NULL AND output_tokens IS NULL
        AND cache_read_tokens IS NULL AND cache_creation_tokens IS NULL)
  );

-- No blank dimensions masquerading as values, no negative measures. A
-- whitespace-only tool or model would key as a distinct grain and render as an
-- empty row in the model axis.
ALTER TABLE provider_usage_fact ADD CONSTRAINT provider_usage_fact_shape_chk
  CHECK (
    nullif(btrim(tool), '') IS NOT NULL
    AND (model IS NULL OR nullif(btrim(model), '') IS NOT NULL)
    AND (cost_type IS NULL OR nullif(btrim(cost_type), '') IS NOT NULL)
    AND COALESCE(cost_usd, 0) >= 0
    AND COALESCE(input_tokens, 0) >= 0 AND COALESCE(output_tokens, 0) >= 0
    AND COALESCE(cache_read_tokens, 0) >= 0 AND COALESCE(cache_creation_tokens, 0) >= 0
  );

/*
 * HOMING IS NOT PROTECTED BY A TRIGGER, deliberately.
 *
 * An earlier draft used a BEFORE UPDATE trigger, which could never fire: the
 * transform writes by upsert, and the homing columns are absent from the SET
 * list, so no UPDATE to them ever occurs. A trigger there would have passed its
 * own test vacuously while protecting nothing.
 *
 * Protection comes from the write pattern instead — region_id, org_unit_id,
 * cost_owning_unit_id and dimension_source are omitted from the upsert's SET
 * list, exactly as actual_spend does (analytics-poller.ts:227-239,
 * dimension-snapshot.ts:17-23). tests/integration/provider/
 * provider-transform.test.ts proves a re-transform after a reorg leaves them
 * unchanged, and that assertion goes red if they are added back to the SET list.
 */

/*
 * NO (source, date) INDEX, deliberately — the design specifies exactly one
 * index and this migration builds exactly that. The grain uidx leads on
 * `source`, so the guarded prune's `source = ? AND date BETWEEN ? AND ?` is
 * already index-supported on its leading column. If the prune later shows up as
 * a seq scan at real volume, adding a covering index is its own change with its
 * own evidence — not a guess made before the table has ever held a row.
 */

/*
 * ── "ONLY THE PROVIDER API WRITES THIS LANE" IS NOT ENFORCED HERE ────────────
 *
 * [VERIFY] The design's invariant table
 * (target-state-data-architecture.md §9) requires this be proven by
 * PERMISSION, not by grep: "the joiner's DB role has no INSERT on
 * provider_usage_fact; assert the write is rejected, not merely absent from the
 * code". That test cannot be written against this repo today, and the reason is
 * structural rather than an oversight in this migration:
 *
 *   THERE IS NO NON-OWNER DB ROLE. The app, the workers and the migration
 *   runner all connect as the table OWNER (infra/modules/postgresql.bicep:63
 *   administratorLogin, through drizzle/connect.ts). No CREATE ROLE exists in
 *   any migration, bicep template or script — the only two in the tree are
 *   inside tests (tests/integration/db/rls.test.ts:31,
 *   tests/integration/workers/aggregate-rollup.test.ts:124) which mint a
 *   throwaway role precisely BECAUSE production has none. This is stated in
 *   0098_rls_policy_convergence.sql:10-17, which is why every RLS policy in
 *   this database is inert: owners bypass RLS unless FORCE ROW LEVEL SECURITY
 *   is set, and it is not.
 *
 * So `REVOKE INSERT ... FROM <joiner-role>` would name a role that does not
 * exist (an error, not a control), and an RLS write policy would be bypassed by
 * the very connection it is meant to stop. Writing either would put an
 * enforcement-shaped statement in this file that enforces nothing — the exact
 * failure mode the "HOMING IS NOT PROTECTED BY A TRIGGER" note above exists to
 * prevent one paragraph earlier.
 *
 * WHAT ACTUALLY LANDS IT: the non-owner writer role + FORCE ROW LEVEL SECURITY
 * deferred as UF-1 by 0098 and carried in docs/security-sprint/
 * urgent-follow-sprint.md. When that role exists, this becomes two lines
 * (`GRANT SELECT ... ; REVOKE INSERT, UPDATE, DELETE ... FROM <role>`) plus the
 * permission test the invariant asks for. Until then the property is held by
 * code review alone, and this comment is the record that it is.
 *
 * The one grant statement that IS real without a role: PUBLIC always exists, so
 * revoking from it means a future writer role cannot inherit table access
 * implicitly. It is defence-in-depth for the day UF-1 lands, NOT the
 * enforcement above — PUBLIC holds nothing on a fresh table, so this changes no
 * behaviour today and no test can go red on it.
 */
REVOKE ALL ON TABLE provider_usage_fact FROM PUBLIC;

COMMENT ON COLUMN provider_usage_fact.raw_batch_id IS
  'Lineage to the raw capture batch. UNREFERENCED until raw_provider_batch (0117, feat/provider-raw-capture) lands — do not add the FK before that table exists.';
COMMENT ON COLUMN provider_usage_fact.cost_type IS
  'NULL = the token row (carries the four token lanes + requests, never cost). Non-NULL = a cost row (carries cost_usd, never tokens). Pre-#226 payloads carry no cost_type and are stamped ''tokens'' by the transform, which is what production already treats them as.';
COMMENT ON COLUMN provider_usage_fact.actor_ref IS
  'The provider''s own actor id (email / login), carried so an unresolved row can be re-derived later without a re-fetch. Part of the grain key for unresolved rows.';
COMMENT ON COLUMN provider_usage_fact.dimension_source IS
  'How the homing was derived (''ingest-snapshot''). NOT NULL even when the three id columns are NULL: an unresolved actor has no placement to record, but the snapshot was still taken at ingest.';
