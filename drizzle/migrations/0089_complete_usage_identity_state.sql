-- 0089: expose identity_state on v_complete_usage.
--
-- WHY: budget-alert and velocity-watch are being moved off raw attribution_record
-- onto v_complete_usage so they include Copilot's §A usage (unaccounted_usage),
-- which raw attribution_record lacks. But both workers (and reconciliation-gap)
-- deliberately exclude `identity_state = 'provisional'` — a manager-facing signal
-- must never fire on an unconfirmed teammate/device binding (emit-on-install before
-- the human signs in). v_complete_usage did not carry identity_state, which would
-- have forced silently dropping that exclusion when the workers migrated. This adds
-- the column so the exclusion survives the migration.
--
-- Appended at the END (CREATE OR REPLACE VIEW only permits adding trailing columns;
-- every existing consumer selects named columns, so this is transparent to them).
--
--  - attribution lane: the real per-record identity_state (stamped by the read
--    joiner from instance_attestation at insert).
--  - unaccounted lane: 'confirmed' literal. unaccounted_usage is bill-anchored
--    provider truth (API−OTel gap reconciled from GitHub/Anthropic actuals), which
--    is never emit-on-install and therefore never provisional.

CREATE OR REPLACE VIEW v_complete_usage
WITH (security_invoker = true) AS
  SELECT
    ar.teammate_id, ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool,
    ar.ts_event, ar.cost_usd, ar.tokens,
    ar.model,
    ar.token_type,
    ar.identity_state                       -- 0089: provenance (may be NULL/'confirmed'/'provisional')
  FROM attribution_record ar
  WHERE NOT EXISTS (
    SELECT 1 FROM session_quarantine sq
     WHERE sq.teammate_id = ar.teammate_id
       AND sq.conversation_id = ar.claude_session_id
       AND sq.resolved_at IS NULL
       AND sq.reason = 'api-uncorroborated'
  )
  UNION ALL
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    uu.cost_usd, COALESCE(uu.tokens, 0)::bigint AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state     -- 0089: bill-anchored provider truth, never provisional
  FROM unaccounted_usage uu
  WHERE uu.cost_usd > 0;

COMMENT ON VIEW v_complete_usage IS
  'Per-teammate COMPLETE usage = attribution_record (OTel, minus dev-confirmed forgeries) UNION ALL unaccounted_usage (API-OTel gap). Carries (model, token_type) [0082] and identity_state [0089] so manager-facing producers can exclude provisional (unconfirmed-identity) spend. provider-billing-attribution-model.md §A.';
