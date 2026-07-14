-- 0083: directory_exclusion_pattern — admin-configurable list of directory
-- account patterns that must NEVER become teammates (privileged/service/admin
-- accounts that don't run the tools, don't emit, don't bill), the same way
-- #EXT# B2B guests are already excluded (server/azure/directory.ts).
--
-- WHY A TABLE, NOT governance_setting: that table is deliberately NUMERIC-only
-- ("a future non-numeric dial earns its own column, not a type erasure" — mig
-- 0049). A list of string patterns with per-row note/author/audit earns its
-- own table rather than a value_numeric erasure or a read-modify-write text[]
-- singleton.
--
-- PORTABILITY (this project ships open source): the rule for "which accounts
-- are privileged" is org-specific (tenant domain, -cld / adm- conventions), so
-- it is DATA an admin edits, never a hardcoded literal. This migration seeds
-- ZERO rows on purpose: a fresh install fail-OPEN (excludes nobody) until an
-- admin adds their org's pattern(s) in Admin -> Settings -> Directory
-- exclusions. `*@*.onmicrosoft.com` is NOT seeded as a default because every
-- Entra tenant is born with a `<tenant>.onmicrosoft.com` domain and many real,
-- spend-bearing cloud-only users live there — a blanket default would exclude
-- (and, via the cleanup worker, deactivate) legitimate people. See
-- docs/design/directory-exclusion-policy.md for recommended patterns.
--
-- `pattern` is a case-insensitive glob (only `*` = any run) matched against the
-- account UPN (server/utils/directory-exclusions.ts). Matched accounts are
-- hidden from people-pickers, refused on assign, and (opt-in) retro-cleaned.

CREATE TABLE directory_exclusion_pattern (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern    TEXT NOT NULL,
  note       TEXT,
  created_by UUID REFERENCES teammate(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive dedupe (the matcher lowercases both sides).
CREATE UNIQUE INDEX directory_exclusion_pattern_lower_unique
  ON directory_exclusion_pattern (lower(pattern));

-- RLS mirrors governance_setting (mig 0049): dials/config are not sensitive —
-- readable by any authenticated user (workers read it with no role GUC set),
-- writes admin-shaped. NOTE RLS is inert at runtime today (owner connection);
-- the app-layer requireRole gates are the live path.
ALTER TABLE directory_exclusion_pattern ENABLE ROW LEVEL SECURITY;

CREATE POLICY directory_exclusion_pattern_read ON directory_exclusion_pattern
  FOR SELECT
  USING (true);

CREATE POLICY directory_exclusion_pattern_write ON directory_exclusion_pattern
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin', 'admin'));
