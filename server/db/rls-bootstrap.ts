/*
 * The RLS BOOTSTRAP SET — tables that must have row-level security DISABLED
 * before the app connects as a non-owner role.
 *
 * WHY THIS FILE EXISTS. `FORCE ROW LEVEL SECURITY` binds the table OWNER. A
 * NON-OWNER is bound by `ENABLE` alone. So the moment `DATABASE_URL` points at
 * `tokenscope_app`, every table with RLS enabled starts filtering — whether or
 * not it is in any "FORCE set", and whether or not FORCE is ever run.
 *
 * That is fatal for any query that has to run BEFORE an RLS identity can exist,
 * because the identity is what those queries are looking up. `requireOAuthBearer`
 * reads a token to discover which teammate it belongs to; `/setup/redeem` reads
 * an attestation to discover the same. With no GUCs set, those reads return zero
 * rows, every device fails to authenticate, and the entire emit fleet stops.
 *
 * THIS LIST HAS BEEN GOT WRONG TWICE. The first attempt named `oauth_token`
 * alone; the second added `teammate` and stopped there — both times because the
 * list was written by reading one query and reasoning about the rest. An
 * external review found `org_unit` (the bearer path joins it for `org_path`) and
 * `instance_attestation` (the redeem path reads it) still missing.
 *
 * So it is a constant with a test, not a sentence in a runbook:
 * `tests/integration/db/rls-bootstrap-set.test.ts` runs the REAL bootstrap
 * queries as a real non-owner with exactly this set disabled, and proves each
 * entry is load-bearing by re-enabling one at a time. Adding a join to a
 * bootstrap path without adding its table here turns that test red.
 *
 * TO ADD A TABLE: add it here with the query that forced it. Do not add one
 * "to be safe" — every entry is a table whose policies do not run in production,
 * so the set is a hole in the control and must stay as small as the code allows.
 */

/*
 * THE APP ROLE'S NAME — one spelling in the tree, re-exported here.
 *
 * `RLS_APP_ROLE` is the non-owner login role the app connects as once
 * enforcement is on (design §9 step 1). It is DEFINED in `scripts/rls-roles.ts`
 * for a mechanical reason, not a stylistic one: the capability probe that
 * reports whether the role exists also runs at boot from the entrypoint
 * pre-flight, and the runtime image copies `scripts/` and `drizzle/` but NOT
 * `server/` (Dockerfile stage 4) — a constant boot-time code needs cannot live
 * here.
 *
 * It is re-exported beside RLS_BOOTSTRAP_TABLES so server-side code (the track
 * that PROVISIONS the role, the admin route that REPORTS on it) has one obvious
 * import site and there is never a second literal to drift from.
 *
 * THAT IS TRUE OF THE ROLE NAME AND NOT OF THE TABLE SET. The set is written
 * down twice on purpose — bare names in `scripts/` for the boot path, names
 * plus their reasons here for the readers — because the reasons must not enter
 * the boot path and the names must. The re-export on the last line of this file
 * means both spellings import from here, which makes that duplication easy to
 * miss, so it is held together mechanically by
 * `tests/unit/db/rls-bootstrap-lists-agree.test.ts` rather than by this comment.
 */
export { RLS_APP_ROLE } from '../../scripts/rls-roles'

export interface RlsBootstrapTable {
  table: string
  /** The pre-identity read that forces this table into the set. */
  reason: string
}

export const RLS_BOOTSTRAP_TABLES: readonly RlsBootstrapTable[] = [
  {
    table: 'oauth_token',
    reason:
      'requireOAuthBearer looks the presented token up to DISCOVER the teammate — there is no identity to set before this read (server/auth/oauth-bearer.ts).',
  },
  {
    table: 'teammate',
    reason:
      'Joined by both bootstrap paths to resolve region and role from the token/attestation owner.',
  },
  {
    table: 'org_unit',
    reason:
      "Joined by both bootstrap paths for the caller's org_path (teammate.org_unit_id → org_unit.path). Missed by the first two versions of this list.",
  },
  {
    table: 'instance_attestation',
    reason:
      '/setup/redeem reads the attestation named by a consumed handoff code, before withDeferredMachineRls can adopt an identity (server/api/v1/setup/redeem.post.ts).',
  },
  {
    table: 'audit_event',
    reason:
      'The pre-identity paths AUDIT themselves: /setup/enroll writes audit_event at :144 inside a transaction that never adopts an identity, and oauth/token, /register and /revoke do the same. Its only policy (audit_event_admin_only) admits global-finops/platform-admin and nothing else, so the INSERT is denied and the whole enrolment rolls back — a 500 for every new device. Found by the THIRD review of this list; the design doc had made the same ENABLE-vs-FORCE mistake in its §4 as it had in §5.',
  },
] as const

/** Just the table names, for a runbook step or a migration. */
export { RLS_BOOTSTRAP_TABLE_NAMES } from '../../scripts/rls-roles'
