-- provider_org — registry of Anthropic / GitHub orgs, each with how (and
-- whether) we reconcile + bill its spend. See
-- docs/design/client-attribution-auth-spec.md §2.1.
--
--   reconciliation_mode: 'reconciled' (we hold an admin key → poll authoritative
--                        actuals) | 'indicative' (no key → OTel-only, excluded
--                        from reconciliation)
--   billing            : 'billed' (rolls into Insight financial rollups) |
--                        'tracked' (project visibility only)
-- The two are independent (e.g. a client who shares their key = reconciled +
-- tracked). The joiner reads the per-event organization.id from telemetry and
-- selects the lane from this registry; unknown orgs are flagged, never billed.
CREATE TABLE IF NOT EXISTS provider_org (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider               text NOT NULL,
  external_org_id        text NOT NULL,
  display_name           text NOT NULL,
  reconciliation_mode    text NOT NULL DEFAULT 'indicative',
  billing                text NOT NULL DEFAULT 'tracked',
  credential_secret_name text,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_org_unique UNIQUE (provider, external_org_id),
  CONSTRAINT provider_org_provider_chk CHECK (provider IN ('anthropic', 'github')),
  CONSTRAINT provider_org_mode_chk CHECK (reconciliation_mode IN ('reconciled', 'indicative')),
  CONSTRAINT provider_org_billing_chk CHECK (billing IN ('billed', 'tracked'))
);
