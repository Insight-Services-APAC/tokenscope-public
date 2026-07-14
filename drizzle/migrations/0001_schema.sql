-- TokenScope schema — v0.5 data model, hand-written.
--
-- Per docs/design/data-model.md. Hand-written rather than drizzle-kit-
-- generated because the data model uses several PG-specific constructs
-- Drizzle doesn't render natively (EXCLUDE USING gist, partial uniques,
-- LTREE, generated stored columns). The Drizzle TS schema in
-- drizzle/schema/ stays in sync for typed queries.
--
-- Sync provenance triple (`source`, `is_pinned`, `last_sync_at`) is on
-- the configurable tables per §Sync-vs-manual provenance.

-- ─── Identity & org hierarchy ─────────────────────────────────────────

CREATE TABLE region (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL
);

CREATE TABLE org_unit (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id           UUID NOT NULL REFERENCES region(id),
  parent_id           UUID REFERENCES org_unit(id),
  path                LTREE NOT NULL,
  code                TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  unit_type           TEXT NOT NULL,
  is_cost_owning_unit BOOLEAN NOT NULL DEFAULT FALSE,
  metadata            JSONB,
  source              TEXT NOT NULL DEFAULT 'manual',
  is_pinned           BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at        TIMESTAMPTZ,
  UNIQUE (region_id, code)
);
CREATE INDEX org_unit_path_gist ON org_unit USING GIST (path);

CREATE TABLE teammate (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_oid       TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  region_id       UUID NOT NULL REFERENCES region(id),
  org_unit_id     UUID NOT NULL REFERENCES org_unit(id),
  competency_tier TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  metadata        JSONB,
  source          TEXT NOT NULL DEFAULT 'manual',
  is_pinned       BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at    TIMESTAMPTZ
);

CREATE TABLE teammate_identity_map (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id     UUID NOT NULL REFERENCES teammate(id) ON DELETE CASCADE,
  system          TEXT NOT NULL,
  identifier      TEXT NOT NULL,
  identifier_kind TEXT NOT NULL,
  is_canonical    BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at     TIMESTAMPTZ,
  metadata        JSONB,
  source          TEXT NOT NULL DEFAULT 'manual',
  is_pinned       BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at    TIMESTAMPTZ,
  UNIQUE (system, identifier)
);

-- ─── Audit log (created early so governance tables can FK to it) ──────
--
-- Full audit_event definition (indexes + append-only trigger) at the
-- bottom of the file; this CREATE TABLE is just so allocation /
-- tier_assignment / sync_conflict can declare their REFERENCES.

CREATE TABLE audit_event (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        TEXT NOT NULL,
  actor_teammate_id UUID REFERENCES teammate(id),
  actor_system      TEXT,
  subject_kind      TEXT,
  subject_id        UUID,
  payload           JSONB NOT NULL,
  ip_address        INET,
  user_agent        TEXT,
  ts_recorded       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Projects + repo + assignment ─────────────────────────────────────

CREATE TABLE project (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT NOT NULL UNIQUE,
  code_hash           TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  client_facing_name  TEXT,
  type                TEXT NOT NULL,
  region_id           UUID NOT NULL REFERENCES region(id),
  cost_owning_unit_id UUID NOT NULL REFERENCES org_unit(id),
  fin_system          TEXT,
  fin_system_id       TEXT,
  is_authorised       BOOLEAN NOT NULL DEFAULT TRUE,
  is_onboarded        BOOLEAN NOT NULL DEFAULT FALSE,
  allocation_mode     TEXT NOT NULL DEFAULT 'shared_pool',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at          TIMESTAMPTZ,
  metadata            JSONB,
  source              TEXT NOT NULL DEFAULT 'manual',
  is_pinned           BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX project_fin_system_id_unique
  ON project (fin_system, fin_system_id)
  WHERE fin_system IS NOT NULL;

CREATE TABLE repo_project_map (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_provider  TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  project_id     UUID NOT NULL REFERENCES project(id),
  weight         NUMERIC(5, 4) NOT NULL DEFAULT 1.0,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to   TIMESTAMPTZ,
  source         TEXT NOT NULL DEFAULT 'manual',
  is_pinned      BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at   TIMESTAMPTZ,
  UNIQUE (repo_provider, repo_full_name, project_id, effective_from)
);

CREATE TABLE project_assignment (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES project(id),
  teammate_id  UUID NOT NULL REFERENCES teammate(id),
  effective    TSTZRANGE NOT NULL,
  source       TEXT NOT NULL DEFAULT 'manual',
  is_pinned    BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  EXCLUDE USING gist (
    project_id WITH =,
    teammate_id WITH =,
    effective WITH &&
  )
);
CREATE INDEX project_assignment_teammate_eff ON project_assignment (teammate_id);
CREATE INDEX project_assignment_project_eff ON project_assignment (project_id);

-- ─── Session attestation ──────────────────────────────────────────────

CREATE TABLE session_attestation (
  session_id          UUID PRIMARY KEY,
  principal_oid       TEXT NOT NULL,
  principal_email     TEXT,
  teammate_id         UUID NOT NULL REFERENCES teammate(id),
  project_code_hash   TEXT NOT NULL,
  raw_project_code    TEXT,
  tool                TEXT NOT NULL,
  session_token_hash  TEXT NOT NULL UNIQUE,
  ts_start            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ts_expected_end     TIMESTAMPTZ,
  ts_actual_end       TIMESTAMPTZ,
  ts_purged           TIMESTAMPTZ,
  region_id           UUID NOT NULL REFERENCES region(id),
  org_unit_id         UUID NOT NULL REFERENCES org_unit(id),
  cost_owning_unit_id UUID NOT NULL REFERENCES org_unit(id),
  attestation_state   TEXT NOT NULL DEFAULT 'attested',
  notes               JSONB
);
CREATE INDEX session_attestation_teammate_ts ON session_attestation (teammate_id, ts_start);
CREATE INDEX session_attestation_cou_ts      ON session_attestation (cost_owning_unit_id, ts_start);
CREATE INDEX session_attestation_region_ts   ON session_attestation (region_id, ts_start);

-- ─── Attribution ledger + aggregate ───────────────────────────────────

CREATE TABLE attribution_record (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          UUID NOT NULL REFERENCES session_attestation(session_id),
  teammate_id         UUID NOT NULL REFERENCES teammate(id),
  project_id          UUID NOT NULL REFERENCES project(id),
  region_id           UUID NOT NULL REFERENCES region(id),
  org_unit_id         UUID NOT NULL REFERENCES org_unit(id),
  cost_owning_unit_id UUID NOT NULL REFERENCES org_unit(id),
  tool                TEXT NOT NULL,
  model               TEXT NOT NULL,
  token_type          TEXT NOT NULL,
  tokens              BIGINT NOT NULL,
  cost_usd            NUMERIC(14, 6) NOT NULL,
  rate_card_id        UUID NOT NULL,
  rate_card_version   INTEGER NOT NULL,
  fidelity_tier       TEXT NOT NULL,
  cost_basis          TEXT NOT NULL,
  ts_event            TIMESTAMPTZ NOT NULL,
  ts_recorded         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_run_id       TEXT,
  is_frozen           BOOLEAN NOT NULL DEFAULT TRUE,
  metadata            JSONB
);
CREATE INDEX attribution_record_session    ON attribution_record (session_id);
CREATE INDEX attribution_record_teammate_t ON attribution_record (teammate_id, ts_event);
CREATE INDEX attribution_record_project_t  ON attribution_record (project_id, ts_event);
CREATE INDEX attribution_record_cou_t      ON attribution_record (cost_owning_unit_id, ts_event);
CREATE INDEX attribution_record_orgunit_t  ON attribution_record (org_unit_id, ts_event);

CREATE TABLE attribution_aggregate (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type     TEXT NOT NULL,
  scope_id       UUID,
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  period_kind    TEXT NOT NULL,
  tool           TEXT,
  model          TEXT,
  total_tokens   BIGINT NOT NULL,
  total_cost_usd NUMERIC(14, 6) NOT NULL,
  record_count   INTEGER NOT NULL,
  refresh_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope_type, scope_id, period_start, period_end, tool, model)
);

-- ─── Rate cards + lines ───────────────────────────────────────────────

CREATE TABLE rate_card (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key   TEXT NOT NULL,
  effective   TSTZRANGE NOT NULL,
  basis       TEXT NOT NULL,
  provenance  JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  UUID REFERENCES teammate(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at  TIMESTAMPTZ,
  EXCLUDE USING gist (scope_key WITH =, effective WITH &&)
);

CREATE TABLE rate_line (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_card_id  UUID NOT NULL REFERENCES rate_card(id) ON DELETE CASCADE,
  unit          TEXT NOT NULL,
  unit_qty      NUMERIC(20, 6) NOT NULL,
  unit_cost_usd NUMERIC(14, 8) NOT NULL,
  model         TEXT,
  notes         TEXT,
  UNIQUE (rate_card_id, unit, model)
);

-- ─── Governance (allocations + limits + tiers) ────────────────────────

CREATE TABLE allocation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      TEXT NOT NULL,
  scope_id        UUID NOT NULL,
  budget_usd      NUMERIC(14, 2) NOT NULL,
  effective       TSTZRANGE NOT NULL,
  allocation_kind TEXT NOT NULL DEFAULT 'baseline',
  created_by      UUID REFERENCES teammate(id),
  audit_event_id  UUID NOT NULL REFERENCES audit_event(id),
  source          TEXT NOT NULL DEFAULT 'manual',
  is_pinned       BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at    TIMESTAMPTZ,
  EXCLUDE USING gist (
    scope_type WITH =,
    scope_id WITH =,
    allocation_kind WITH =,
    effective WITH &&
  )
);

CREATE TABLE limit_policy (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type            TEXT NOT NULL,
  scope_id              UUID NOT NULL,
  limit_kind            TEXT NOT NULL,
  threshold_usd         NUMERIC(14, 2) NOT NULL,
  window_seconds        INTEGER,
  competency_tier_scale NUMERIC(4, 2),
  effective             TSTZRANGE NOT NULL,
  EXCLUDE USING gist (
    scope_type WITH =,
    scope_id WITH =,
    limit_kind WITH =,
    effective WITH &&
  )
);

CREATE TABLE tier_assignment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id    UUID NOT NULL REFERENCES teammate(id),
  tier           TEXT NOT NULL,
  effective      TSTZRANGE NOT NULL,
  assessed_by    UUID REFERENCES teammate(id),
  evidence_link  TEXT,
  audit_event_id UUID NOT NULL REFERENCES audit_event(id),
  source         TEXT NOT NULL DEFAULT 'manual',
  is_pinned      BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at   TIMESTAMPTZ,
  EXCLUDE USING gist (teammate_id WITH =, effective WITH &&)
);

-- ─── Actual-spend ingestion (Anthropic Analytics API) ─────────────────

CREATE TABLE actual_spend (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id   UUID NOT NULL REFERENCES teammate(id),
  date          DATE NOT NULL,
  tool          TEXT NOT NULL,
  input_tokens  BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  cost_usd      NUMERIC(14, 6) NOT NULL,
  source        TEXT NOT NULL DEFAULT 'anthropic-analytics-api',
  pulled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload   JSONB,
  UNIQUE (teammate_id, date, tool, source)
);
CREATE INDEX actual_spend_teammate_date ON actual_spend (teammate_id, date);
CREATE INDEX actual_spend_source_pulled ON actual_spend (source, pulled_at);

-- ─── Spill record (PRD §9.3 SPILL) ────────────────────────────────────

CREATE TABLE spill_record (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         TEXT NOT NULL,
  invoice_period       TSTZRANGE NOT NULL,
  invoice_total_usd    NUMERIC(14, 2) NOT NULL,
  attributed_total_usd NUMERIC(14, 2) NOT NULL,
  spill_usd            NUMERIC(14, 2) GENERATED ALWAYS AS (invoice_total_usd - attributed_total_usd) STORED,
  cost_owning_unit_id  UUID NOT NULL REFERENCES org_unit(id),
  shadow_mode          BOOLEAN NOT NULL DEFAULT FALSE,
  reconciliation_state TEXT NOT NULL DEFAULT 'open',
  EXCLUDE USING gist (workspace_id WITH =, invoice_period WITH &&)
);

-- ─── Per-actor inbox ──────────────────────────────────────────────────

CREATE TABLE inbox_item (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_teammate_id UUID NOT NULL REFERENCES teammate(id),
  category              TEXT NOT NULL,
  severity              TEXT NOT NULL DEFAULT 'info',
  subject               TEXT NOT NULL,
  body                  JSONB NOT NULL,
  related_entity_kind   TEXT,
  related_entity_id     UUID,
  ack_state             TEXT NOT NULL DEFAULT 'unread',
  ack_at                TIMESTAMPTZ,
  ack_by                UUID REFERENCES teammate(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email_sent_at         TIMESTAMPTZ,
  teams_sent_at         TIMESTAMPTZ
);
CREATE INDEX inbox_item_recipient ON inbox_item (recipient_teammate_id, ack_state, created_at);
CREATE INDEX inbox_item_entity    ON inbox_item (related_entity_kind, related_entity_id);
CREATE INDEX inbox_item_category  ON inbox_item (category, severity, created_at);

-- ─── Sync conflict ────────────────────────────────────────────────────

CREATE TABLE sync_conflict (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id        TEXT NOT NULL,
  target_table        TEXT NOT NULL,
  target_pk           UUID NOT NULL,
  manual_row_snapshot JSONB NOT NULL,
  sync_row_payload    JSONB NOT NULL,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution          TEXT NOT NULL DEFAULT 'pending',
  decided_by          UUID REFERENCES teammate(id),
  decided_at          TIMESTAMPTZ,
  audit_event_id      UUID REFERENCES audit_event(id),
  notes               TEXT
);

-- ─── Audit log indexes + append-only trigger ─────────────────────────
-- (CREATE TABLE audit_event lives earlier in this file so governance
-- tables can FK to it.)

CREATE INDEX audit_event_actor_ts   ON audit_event (actor_teammate_id, ts_recorded);
CREATE INDEX audit_event_subject_ts ON audit_event (subject_kind, subject_id, ts_recorded);
CREATE INDEX audit_event_type_ts    ON audit_event (event_type, ts_recorded);

-- Append-only enforcement per data-model.md §Audit log:
CREATE FUNCTION audit_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only; UPDATE/DELETE denied';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
