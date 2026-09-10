-- Retire the `global-finops` APPLICATION role (2026-09-05).
--
-- WHY: it read as a finance-reporting role but was the org-wide ADMINISTRATOR —
-- 122 routes, 66 of them writes, including changing a teammate's role and
-- granting report access. Company-wide report access is now a per-teammate
-- `report_access_grant` (mig 0129), which needs no role, so the reporting half
-- was redundant and the admin half was never intended to be handed out. The
-- role now sits in NO capability set: not admin, not org-wide, not reporting,
-- not selectable. See docs/security-sprint/epic-mdash-remediation.md Wave 4.
--
-- SCOPE — READ THIS BEFORE "TIDYING" THE STRING ELSEWHERE. This migration
-- retires the value of `teammate.role` ONLY. The identical string
-- 'global-finops' in `app.user_role` (this file's siblings from
-- 0098_rls_policy_convergence.sql onward, server/db/rls.ts, worker-db.ts,
-- org-subtree-scope.ts, allocation-scope.ts) is a SCOPE VALUE, not this role:
-- `platform-admin` maps ONTO it (rls.ts rlsRoleFor) and the worker lane runs AS
-- it. Removing it there would break platform-admin's own data scope and every
-- worker. Two vocabularies, one spelling.
--
-- Expected to affect ZERO rows: the owner confirmed no teammate holds the role
-- (2026-09-05). It is written anyway so the retirement is true in DATA and not
-- only in code, and so a row created between that confirmation and this deploy
-- cannot survive as a silent org-wide administrator.
UPDATE teammate
SET role = 'developer'
WHERE role = 'global-finops';
