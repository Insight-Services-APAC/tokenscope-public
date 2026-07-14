-- 0063: per-org Anthropic API selection (the co-existence variant).
--
-- TokenScope reconciles Anthropic spend through one of TWO distinct Anthropic
-- APIs, selected PER ORG:
--   * 'claude-code-admin'    — the Claude Code Analytics API (Admin):
--       GET /v1/organizations/usage_report/claude_code, admin key
--       (sk-ant-admin01-...), per-user model_breakdown tokens + cents.
--   * 'enterprise-analytics' — the Claude Enterprise Analytics API:
--       GET /v1/organizations/analytics/{user_usage_report,user_cost_report},
--       analytics key (read:analytics), per-user tokens + fractional-cents USD.
-- DEV is 'enterprise-analytics'. The adapter (server/reconciliation/adapters/
-- anthropic.ts) branches on this column; reconciliation-sync threads it through
-- AdapterScope. See docs/design/reconciliation-engine.md §4.1.
--
-- GitHub rows carry NO api_kind (the GitHub credential grain is the enterprise,
-- and Copilot has a single billing API) — api_kind IS NULL for github.
--
-- Idempotent. The existing seeded demo Anthropic org is indicative / no-key
-- (telemetry-only), so we backfill it to 'claude-code-admin' purely to satisfy
-- the CHECK — it is never polled (no credential), so the value is indicative.

ALTER TABLE provider_org
  ADD COLUMN IF NOT EXISTS api_kind text;

-- Backfill any pre-existing anthropic rows so the CHECK can be added without a
-- violation. 'claude-code-admin' is the conservative default — it matches the
-- pre-0063 behaviour (the only Anthropic client was the Admin client) and is
-- inert for indicative/no-key rows (never polled). An admin flips a reconciled
-- org to 'enterprise-analytics' explicitly.
UPDATE provider_org
   SET api_kind = 'claude-code-admin'
 WHERE provider = 'anthropic' AND api_kind IS NULL;

-- CHECK: anthropic rows MUST carry a valid api_kind; github rows MUST NOT.
-- Loud failure at onboarding (an anthropic INSERT without api_kind fails) is the
-- intended runbook behaviour — no silent mis-selection of the API.
ALTER TABLE provider_org
  DROP CONSTRAINT IF EXISTS provider_org_api_kind_chk;
ALTER TABLE provider_org
  ADD CONSTRAINT provider_org_api_kind_chk CHECK (
    (provider = 'anthropic' AND api_kind IN ('enterprise-analytics', 'claude-code-admin'))
    OR (provider <> 'anthropic' AND api_kind IS NULL)
  );
