-- 0055: monthly RANGE-partition attribution_record on ts_event (Phase C —
-- ledger retention epic). Bounds per-partition index size, gives partition
-- pruning on time-scoped queries, and makes retention a DETACH/DROP instead of
-- a billion-row DELETE. Done while the table is small — retrofitting at scale
-- is a project.
--
-- Native declarative partitioning (no pg_partman dependency). Rebuild preserving
-- data: rename out, free the canonical index/constraint/policy names, create the
-- partitioned parent + monthly partitions + a DEFAULT catch-all, recreate
-- indexes/FKs/RLS on the parent, copy data, drop the old table. The PK must
-- include the partition key, so it becomes (id, ts_event); id stays effectively
-- unique (gen_random_uuid). No table FK-references attribution_record.id, so the
-- composite PK breaks nothing.

-- Dependent views must be dropped before the rebuild and recreated against the
-- new table afterwards (their defs reproduced verbatim from 0040 / 0045 — Phase
-- E will later redefine v_effective_spend for the cold-fallback).
DROP VIEW IF EXISTS v_finance_reportable_spend;
DROP VIEW IF EXISTS v_cost_drift;
DROP VIEW IF EXISTS v_effective_spend;

ALTER TABLE attribution_record RENAME TO attribution_record_old;

-- Free the canonical names while keeping _old's data for the copy below.
ALTER TABLE attribution_record_old DROP CONSTRAINT attribution_record_pkey;
ALTER TABLE attribution_record_old DROP CONSTRAINT attribution_record_cost_owning_unit_id_fkey;
ALTER TABLE attribution_record_old DROP CONSTRAINT attribution_record_org_unit_id_fkey;
ALTER TABLE attribution_record_old DROP CONSTRAINT attribution_record_project_id_fkey;
ALTER TABLE attribution_record_old DROP CONSTRAINT attribution_record_region_id_fkey;
ALTER TABLE attribution_record_old DROP CONSTRAINT attribution_record_session_id_fkey;
ALTER TABLE attribution_record_old DROP CONSTRAINT attribution_record_teammate_id_fkey;
DROP INDEX attribution_record_claude_session_idx;
DROP INDEX attribution_record_cou_t;
DROP INDEX attribution_record_orgunit_t;
DROP INDEX attribution_record_project_t;
DROP INDEX attribution_record_recorded;
DROP INDEX attribution_record_session;
DROP INDEX attribution_record_session_coverage_idx;
DROP INDEX attribution_record_session_event_unique;
DROP INDEX attribution_record_teammate_t;
DROP INDEX attribution_record_unallocated;
DROP POLICY attribution_record_org_scope ON attribution_record_old;
DROP POLICY attribution_record_region_scope ON attribution_record_old;

CREATE TABLE attribution_record (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  instance_id uuid NOT NULL,
  teammate_id uuid NOT NULL,
  project_id uuid,
  region_id uuid NOT NULL,
  org_unit_id uuid NOT NULL,
  cost_owning_unit_id uuid,
  tool text NOT NULL,
  model text NOT NULL,
  token_type text NOT NULL,
  tokens bigint NOT NULL,
  cost_usd numeric(14,6) NOT NULL,
  rate_card_id uuid,
  rate_card_version integer,
  fidelity_tier text NOT NULL,
  cost_basis text NOT NULL,
  ts_event timestamptz NOT NULL,
  ts_recorded timestamptz DEFAULT now() NOT NULL,
  source_run_id text,
  is_frozen boolean DEFAULT true NOT NULL,
  metadata jsonb,
  claude_session_id text,
  activity text,
  credit_qty numeric(20,6),
  query_source text,
  CONSTRAINT attribution_record_pkey PRIMARY KEY (id, ts_event)
) PARTITION BY RANGE (ts_event);

-- Monthly partitions over a reasonable window + a DEFAULT catch-all (so an
-- insert never fails for a missing partition). A maintenance/archive job
-- pre-creates future months and detaches/drops archived ones. Storage params
-- (insert-driven autovacuum) go on the LEAF partitions, not the parent.
-- Bounds are written as explicit +00 timestamptz literals (not bare dates):
-- a bare date bound on a timestamptz column is cast using the session TimeZone,
-- which would shift every partition edge off UTC if the migration ran in a
-- non-UTC session. The rollup, the 0056 watermark, and the archive
-- reconciliation all assume UTC-month edges (review C3).
DO $$
DECLARE m date := date '2025-06-01'; part text;
BEGIN
  WHILE m < date '2028-01-01' LOOP
    part := 'attribution_record_' || to_char(m, 'YYYY_MM');
    EXECUTE format('CREATE TABLE %I PARTITION OF attribution_record FOR VALUES FROM (%L) TO (%L)',
                   part,
                   to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00',
                   to_char((m + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00');
    EXECUTE format('ALTER TABLE %I SET (autovacuum_vacuum_insert_scale_factor = 0.05)', part);
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;
CREATE TABLE attribution_record_default PARTITION OF attribution_record DEFAULT;
ALTER TABLE attribution_record_default SET (autovacuum_vacuum_insert_scale_factor = 0.05);

-- Indexes on the parent (propagate to every partition). The dedup unique index
-- includes ts_event (the partition key), so per-partition uniqueness is sound.
CREATE UNIQUE INDEX attribution_record_session_event_unique ON attribution_record
  (instance_id, COALESCE(claude_session_id, ''::text), ts_event, token_type, model, COALESCE(source_run_id, ''::text));
CREATE INDEX attribution_record_claude_session_idx ON attribution_record (claude_session_id);
CREATE INDEX attribution_record_cou_t ON attribution_record (cost_owning_unit_id, ts_event);
CREATE INDEX attribution_record_orgunit_t ON attribution_record (org_unit_id, ts_event);
CREATE INDEX attribution_record_project_t ON attribution_record (project_id, ts_event);
CREATE INDEX attribution_record_recorded ON attribution_record (ts_recorded);
CREATE INDEX attribution_record_session ON attribution_record (instance_id);
CREATE INDEX attribution_record_session_coverage_idx ON attribution_record (ts_event, instance_id, claude_session_id);
CREATE INDEX attribution_record_teammate_t ON attribution_record (teammate_id, ts_event);
CREATE INDEX attribution_record_unallocated ON attribution_record (teammate_id, claude_session_id) WHERE project_id IS NULL;

ALTER TABLE attribution_record ADD CONSTRAINT attribution_record_session_id_fkey FOREIGN KEY (instance_id) REFERENCES instance_attestation(instance_id);
ALTER TABLE attribution_record ADD CONSTRAINT attribution_record_teammate_id_fkey FOREIGN KEY (teammate_id) REFERENCES teammate(id);
ALTER TABLE attribution_record ADD CONSTRAINT attribution_record_project_id_fkey FOREIGN KEY (project_id) REFERENCES project(id);
ALTER TABLE attribution_record ADD CONSTRAINT attribution_record_region_id_fkey FOREIGN KEY (region_id) REFERENCES region(id);
ALTER TABLE attribution_record ADD CONSTRAINT attribution_record_org_unit_id_fkey FOREIGN KEY (org_unit_id) REFERENCES org_unit(id);
ALTER TABLE attribution_record ADD CONSTRAINT attribution_record_cost_owning_unit_id_fkey FOREIGN KEY (cost_owning_unit_id) REFERENCES org_unit(id);

ALTER TABLE attribution_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY attribution_record_region_scope ON attribution_record FOR ALL
  USING (((region_id)::text = current_setting('app.user_region_id', true))
         OR (current_setting('app.user_role', true) = ANY (ARRAY['global-finops', 'admin'])));
CREATE POLICY attribution_record_org_scope ON attribution_record FOR ALL
  USING ((EXISTS (SELECT 1 FROM org_unit ou
                  WHERE ou.id = attribution_record.org_unit_id
                    AND ou.path OPERATOR(<@) (current_setting('app.user_org_path', true))::ltree))
         OR (current_setting('app.user_role', true) = ANY (ARRAY['global-finops', 'admin'])));

INSERT INTO attribution_record
  (id, instance_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
   tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version, fidelity_tier,
   cost_basis, ts_event, ts_recorded, source_run_id, is_frozen, metadata, claude_session_id,
   activity, credit_qty, query_source)
SELECT id, instance_id, teammate_id, project_id, region_id, org_unit_id, cost_owning_unit_id,
   tool, model, token_type, tokens, cost_usd, rate_card_id, rate_card_version, fidelity_tier,
   cost_basis, ts_event, ts_recorded, source_run_id, is_frozen, metadata, claude_session_id,
   activity, credit_qty, query_source
FROM attribution_record_old;

DROP TABLE attribution_record_old;

-- Recreate the dependent views against the new partitioned table (verbatim defs).
CREATE VIEW v_effective_spend WITH (security_invoker = true) AS
  SELECT ar.id AS source_id, 'attribution'::text AS source, ar.teammate_id, ar.region_id,
         ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool, ar.model,
         NULL::text AS category, ar.ts_event AS occurred_at, ar.cost_usd, ar.tokens,
         CASE WHEN ar.cost_basis = 'telemetry-only'::text THEN 'indicative'::text ELSE 'estimated'::text END AS spend_class
    FROM attribution_record ar
  UNION ALL
  SELECT rr.id AS source_id, 'reconciliation'::text AS source, rr.teammate_id, rr.region_id,
         rr.org_unit_id, rr.cost_owning_unit_id, rr.project_id, NULL::text AS tool, NULL::text AS model,
         rr.category, (rr.period_date::timestamp without time zone AT TIME ZONE 'UTC'::text) AS occurred_at,
         rr.delta_usd AS cost_usd, 0::bigint AS tokens, rr.spend_class
    FROM reconciliation_record rr
   WHERE rr.status = 'applied'::text;

CREATE VIEW v_finance_reportable_spend WITH (security_invoker = true) AS
  SELECT source_id, source, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
         tool, model, category, occurred_at, cost_usd, tokens, spend_class
    FROM v_effective_spend
   WHERE spend_class <> 'indicative'::text;

CREATE VIEW v_cost_drift WITH (security_invoker = true) AS
  SELECT instance_id, COALESCE(claude_session_id, ''::text) AS conversation_key, ts_event,
         COALESCE(source_run_id, ''::text) AS span_key, max(model) AS model,
         sum(cost_usd) AS rate_card_cost_usd,
         max((metadata ->> 'law_cost_usd'::text)::numeric) AS law_cost_usd,
         sum(cost_usd) - max((metadata ->> 'law_cost_usd'::text)::numeric) AS drift_usd
    FROM attribution_record
   WHERE tool = 'claude-code'::text AND metadata ? 'law_cost_usd'::text
   GROUP BY instance_id, (COALESCE(claude_session_id, ''::text)), ts_event, (COALESCE(source_run_id, ''::text));
