-- 0113 — carry `activity` on v_complete_usage, so the PROJECT activity grain can
-- be derived from the SAME §A lane as the project headline.
--
-- WHY. "Project spend this month" was computed in five places from three
-- sources; the project page rendered a stale `attribution_aggregate` headline
-- above a live `attribution_record` activity donut, and neither carried arm 2
-- (the API−OTel reconciliation gap). Moving every project figure onto
-- v_complete_usage is only possible if every GRAIN the project page needs
-- exists on that lane — the headline, the per-member split AND the per-activity
-- split. teammate_id/project_id/cost_usd/tokens were already there; `activity`
-- was not, so the donut had no choice but to read the ledger directly.
--
-- Both TAGGABLE arms carry a real activity tag:
--   arm 1 `attribution_record.activity` — set by the tag-session path.
--   arm 2 `unaccounted_usage.activity`  — set by the same needs-tagging flow
--                                          (mig 0071: "The dev's tag").
-- Arm 3 is NULL for the SAME structural reason its `project_id` is NULL (0101):
-- the ingest-only surfaces are untaggable by construction, so there is no
-- activity to carry. NULL here therefore means "no activity axis exists for this
-- money", exactly as NULL `model` does — readers must render it as a NAMED
-- bucket, never as a zero and never as "untagged" (which would libel arm 3 as a
-- bookkeeping gap when it is a structural absence).
--
-- Shape: CREATE OR REPLACE VIEW appending ONE trailing column, the same
-- backwards-compatible move 0082 (model, token_type), 0089 (identity_state) and
-- 0101 (usage_provenance) made. No consumer selects `*` from this view and no
-- other view depends on it, so nothing needs rebuilding. Base definition is
-- 0101's — copied forward verbatim (immutable history: 0101 is not edited).
CREATE OR REPLACE VIEW v_complete_usage
WITH (security_invoker = true) AS
  SELECT
    ar.teammate_id, ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool,
    ar.ts_event, ar.cost_usd, ar.tokens,
    ar.model,
    ar.token_type,
    ar.identity_state,
    'otel-emitted'::text AS usage_provenance,     -- 0101: see shared/usage/provenance.ts
    ar.activity                                    -- 0113
  FROM attribution_record ar
  WHERE NOT EXISTS (
    SELECT 1 FROM session_quarantine sq
     WHERE sq.teammate_id = ar.teammate_id
       AND sq.conversation_id = ar.claude_session_id
       AND sq.resolved_at IS NULL
       AND sq.reason = 'api-uncorroborated'
  )
  AND ar.tool NOT IN (
    'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
    'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
  )
  UNION ALL
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    uu.cost_usd, COALESCE(uu.tokens, 0)::bigint AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'api-reconciled'::text AS usage_provenance,   -- 0101
    uu.activity                                    -- 0113
  FROM unaccounted_usage uu
  WHERE uu.cost_usd > 0
    AND uu.tool NOT IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
  UNION ALL
  -- Arm 3 (0101, A3) — the non-taggable completeness arm. `project_id` AND
  -- `activity` are both NULL by construction: this lane is untaggable, so it can
  -- never be an operand of a project budget or of a project's activity mix.
  SELECT
    vtd.teammate_id, vtd.region_id, vtd.org_unit_id, vtd.cost_owning_unit_id, NULL::uuid AS project_id, vtd.tool,
    (vtd.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    vtd.usage_usd AS cost_usd, COALESCE(vtd.tokens, 0)::bigint AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'provider-usage'::text AS usage_provenance,
    NULL::text AS activity                         -- 0113: untaggable ⇒ no activity axis
  FROM v_teammate_usage_daily vtd
  WHERE vtd.usage_usd > 0
    -- INGEST_ONLY_USAGE_TOOLS (shared/usage/surface.ts) — MUST match exactly
    -- (pinned by tests/unit/usage/surface.test.ts's migration-0101 block).
    AND vtd.tool IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    );

COMMENT ON VIEW v_complete_usage IS
  'Per-teammate COMPLETE usage = attribution_record (OTel, minus dev-confirmed forgeries) UNION ALL unaccounted_usage (API-OTel gap) UNION ALL the ingest-only completeness arm (0101, A3: non-Code Claude surfaces + copilot-agent, via v_teammate_usage_daily — never taggable, never budget-eligible, always velocity-eligible). Carries (model, token_type) [0082], identity_state [0089], usage_provenance [0101: otel-emitted | api-reconciled | provider-usage] and activity [0113] so manager-facing producers and reporting drivers can tell a genuine attribution gap from a structural absence. THE single §A lane for project spend at every grain (server/usage/complete-spend.ts). usage-completeness-and-provider-governance.md §3.1.';
