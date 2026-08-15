-- 0130 — report_access_grant: add the 'revoke-all' permission (the DENY row).
--
-- WHY. As of 2026-08-13 report access is a ROLE DEFAULT again for the ORG-WIDE
-- roles: global-finops / platform-admin see the WHOLE COMPANY by role (all
-- regions, every Business Unit, the finance pack). That reverses #251's
-- grant-only model for those two roles only — it stranded a platform-admin on an
-- empty report shell when their backfilled grant landed on a different teammate
-- row.
--
-- A region `admin` is DELIBERATELY UNCHANGED by that reversal: still
-- region-bound — own region plus the Business Units their org subtree covers
-- (costCentre 'owned-or-subtree'), and NO finance pack. Widening a region admin
-- cross-region would drop the anti-IDOR region clamp that stops one region's
-- admin reading another region's billed spend.
--
-- The positive grants ('operational' / 'finance') still WIDEN any caller whose
-- BASELINE lacks that scope — which includes a region admin: an 'operational'
-- grant takes a region admin cross-region, and a 'finance' grant reaches them
-- into the finance pack. They are a no-op only where the baseline already holds
-- the scope (the org-wide roles).
--
-- But a role default with no way OFF is not governance. An org may want an admin
-- who operates the platform but must NOT read billed-spend reports — the
-- "administer, no data access" separation of duties. This migration adds the
-- lever: an active `permission = 'revoke-all'` row zeroes a teammate's report
-- access, below their role default and below any positive grant (DENY-WINS,
-- enforced in shared/auth/report-visibility.ts::effectiveReportGrants and
-- server/auth/report-scope.ts::resolveReportAccessRevoked).
--
-- SHAPE. 'revoke-all' rides the SAME table, unique index and RLS as the positive
-- grants: the existing partial unique index (teammate_id, permission) WHERE
-- revoked_at IS NULL gives one active revoke per teammate; the admin surface
-- writes it (POST) and clears it (soft-revoke via DELETE) with no new endpoint —
-- except that DELETE refuses (403) when the row is a 'revoke-all' targeting the
-- CALLER, so lifting your own revoke needs a different admin.
-- Finer per-scope deny (revoke finance only, keep operational) is a deliberate
-- TODO — this is the whole-access lever the immediate use case needs.
--
-- ROLLBACK & ROLLOUT (adversarial-review Alert 3). Down = re-narrow the CHECK to
-- ('operational','finance'); any live 'revoke-all' row must be deleted first (a
-- narrower CHECK cannot validate it). MORE IMPORTANT than the CHECK: a
-- deny-UNAWARE application revision reads report_access_grant through the two
-- positive literals only (server/auth/report-scope.ts::resolveReportPermissions
-- filters to REPORT_ACCESS_PERMISSIONS) and has NO resolveReportAccessRevoked —
-- so it silently ignores every persisted 'revoke-all' and serves the target
-- their role baseline. THEREFORE roll this out deny-aware-READERS-FIRST: deploy
-- the app revision that understands 'revoke-all' to EVERY replica before (or in
-- the same release as) this migration, and once any 'revoke-all' row is written,
-- do NOT roll the app back below that revision without first clearing revokes.
--
-- RESIDUAL RISK, STATED HONESTLY (adversarial-review round 2): this constraint is
-- NOT self-enforcing and there is NO runtime signal for its violation. A
-- deny-unaware rollback leaves the table PRESENT (it rolls back the APP, not the
-- schema), so resolveReportAccessRevoked's absent-table [SECURITY-REPORT-ACCESS]
-- warning never fires, and the rolled-back revision has no revoke-reading code at
-- all — it silently serves a revoked person their role baseline. (That warning
-- covers only the different, absent-table case.) Detection/enforcement would need
-- a DEPLOY-TIME guard — a CI/preflight check that refuses to ship a build whose
-- report-scope lacks 'revoke-all' handling while active revoke-all rows exist —
-- which is a follow-up. Until then this residual is EXPLICITLY ACCEPTED; the only
-- control is the readers-first discipline above.

ALTER TABLE report_access_grant
  DROP CONSTRAINT report_access_grant_permission_check;

ALTER TABLE report_access_grant
  ADD CONSTRAINT report_access_grant_permission_check
  CHECK (permission IN ('operational', 'finance', 'revoke-all'));
