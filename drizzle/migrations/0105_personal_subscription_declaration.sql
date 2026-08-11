-- 0105 — personal_subscription_declaration (Workstream B, Required outcome 6;
-- ADR-0011 D3/D4, design §4.3: "`personal` is a teammate-level attribute").
--
-- A teammate's own declaration that a given tool's usage is funded by THEIR
-- personal subscription (e.g. a personal Claude Max plan), not an Insight
-- provider org. The no-bill signal suppression is scoped to (teammate, tool),
-- never applied globally. Self-service (the teammate declares their own; see
-- server/api/v1/me/personal-subscription).
--
-- Effect (gated on an ACTIVE, i.e. non-revoked, row): exempts the
-- (teammate, tool)'s no-bill §A usage from the ADR-0010 rule-2 corroboration
-- requirement — never flagged/quarantined as suspected forgery merely for
-- having no provider-bill counterpart (see
-- server/usage/over-emission-detection.ts).
--
-- A declaration NEVER changes an actual_spend chargeback verdict. Provider API
-- records remain governed exclusively by provider_org.billing or
-- provider_enterprise.billing (ADR-0011 D1), including when provider-backed and
-- personal usage coexist for the same teammate and tool.
--
-- Never auto-classifies: only ever created by an explicit teammate action.
CREATE TABLE personal_subscription_declaration (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id        uuid NOT NULL REFERENCES teammate(id),
  tool               text NOT NULL,
  subscription_type  text NOT NULL,
  monthly_cost_usd   numeric(10, 2) NOT NULL CHECK (monthly_cost_usd >= 0),
  declared_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  CONSTRAINT personal_subscription_declaration_cost_bound CHECK (monthly_cost_usd < 100000)
);

-- One ACTIVE declaration per (teammate, tool) — a revoked one does not block a
-- fresh declaration (e.g. switching subscription type), and history is
-- retained (revoked_at set, never deleted) for audit.
CREATE UNIQUE INDEX personal_subscription_declaration_active_unique
  ON personal_subscription_declaration (teammate_id, tool) WHERE revoked_at IS NULL;

COMMENT ON TABLE personal_subscription_declaration IS
  'Teammate self-declared personal-subscription usage (ADR-0011 D3/D4, design §4.3). Scoped to (teammate, tool). Active rows suppress only the no-bill ADR-0010 rule-2 corroboration signal; they never alter provider-backed chargeback. Never auto-classified.';
