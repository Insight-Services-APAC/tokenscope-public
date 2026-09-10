/*
 * Admin guards — pure decision functions for the Wave VI / VII admin
 * mutations.
 *
 * Mirrors the pattern in server/auth/persona-override.ts: extract the
 * decision so it's unit-testable without an h3 event mock, then have
 * the handler thread the resolved (caller, target, state) inputs in.
 *
 * Gates:
 *   evaluateRoleChange     — guard for PATCH /api/v1/admin/users/:id
 *   evaluateRevokeSessions — guard for POST  /api/v1/admin/users/:id/revoke-sessions
 *
 * Refusal modes for evaluateRoleChange (status, reason):
 *     400 self-demote-blocked — caller is changing their OWN role. The
 *         "lock-yourself-out" foot-gun applies whether the caller is
 *         admin or platform-admin (both are privileged roles that the
 *         user could lock themselves out of). A peer admin must demote
 *         you. R1 F3 — narrowing this to only admin callers left
 *         platform-admin with the same lock-out vector.
 *     400 same-role-noop      — target already has the requested role.
 *         400 (not 200) so the UI surfaces a clear "nothing to do"
 *         signal instead of silently succeeding.
 *     409 last-admin-protected — target is the LAST active admin in
 *         their REGION and is being demoted. Per-region (not install-
 *         wide) because admin scope IS region-scoped; platform-admin
 *         peers are cross-region and intentionally NOT counted. The
 *         handler runs the count under withRequestRls in the target's
 *         region, so this is consistent with what the mutation sees.
 *
 *   Allow:
 *     { allowed: true } — handler proceeds with the update + audit
 *     row.
 *
 * The caller's role gate (admin / platform-admin only) is NOT
 * evaluated here — requireRole(...) handles that at the handler edge.
 * This module assumes the caller is already an authorised mutator.
 */
import type { Session } from '../utils/auth'
import type { Role } from '../../shared/auth/roles'
import { isRetiredRole } from '../../shared/auth/roles'

export interface RoleChangeTarget {
  id: string
  role: Role
}

export type RoleChangeVerdict =
  | { allowed: true }
  | { allowed: false; status: 400 | 403 | 409; reason: string }

export function evaluateRoleChange(
  callerSession: Pick<Session, 'role' | 'teammateId'>,
  target: RoleChangeTarget,
  newRole: Role,
  currentAdminCount: number,
): RoleChangeVerdict {
  // Self-role-change — block ANY caller from changing their OWN role
  // (R1 F3 — earlier scope was admin-callers-only, which left global-
  // finops able to lock themselves out by self-demoting to developer).
  // The brief was explicit: "Both checks (Recommended)" — interpret
  // strictly. Even an admin promoting themselves to platform-admin is
  // refused — same-id changes require a peer mutator. The same-role-no-op
  // case is handled by the predicate below, so this only fires on a
  // genuine role-change.
  if (
    callerSession.teammateId === target.id &&
    callerSession.role !== newRole
  ) {
    return { allowed: false, status: 400, reason: 'self-role-change-blocked' }
  }

  // Same-role no-op — surface as 400 so the UI doesn't silently swallow.
  if (target.role === newRole) {
    return { allowed: false, status: 400, reason: 'same-role-noop' }
  }

  // Last-admin protection — if the target is currently admin and the
  // new role is non-admin, and there is exactly one admin in the
  // install, refuse. currentAdminCount is the caller-supplied count
  // queried inside the same RLS-scoped txn so this is consistent
  // with what the mutation will see.
  if (
    target.role === 'admin' &&
    newRole !== 'admin' &&
    currentAdminCount <= 1
  ) {
    return { allowed: false, status: 409, reason: 'last-admin-protected' }
  }

  return { allowed: true }
}

// ── evaluateRevokeSessions ────────────────────────────────────────────
//
// Pure decision for POST /api/v1/admin/users/:id/revoke-sessions.
//
// Wave VII brief explicitly carves out the contour: revoking sessions
// does NOT change the role — the user just has to sign back in. The
// "last-admin protection" that gates evaluateRoleChange does NOT apply
// here. Self-revoke is allowed (forced sign-out of oneself is a
// legitimate operator action).
//
// The decision surface therefore reduces to a single positive verdict.
// This stub exists for two reasons:
//   1. Symmetry with evaluateRoleChange — every admin-guard mutation
//      has a corresponding pure decision function the handler threads.
//   2. Future-proofing — if a refusal contour ever lands (e.g. rate-
//      limiting, last-admin-of-only-region with no other operator who
//      could re-promote), the gate point already exists.
//
// Caller role + RBAC are validated at the handler edge (requireRole +
// requireRegionScope); this function assumes that's already passed.
export interface RevokeSessionsTarget {
  id: string
  regionId: string
}

export type RevokeSessionsVerdict =
  | { allowed: true }
  | { allowed: false; status: 400 | 403 | 409; reason: string }

export function evaluateRevokeSessions(
  _callerSession: Pick<Session, 'role' | 'teammateId'>,
  _target: RevokeSessionsTarget,
): RevokeSessionsVerdict {
  return { allowed: true }
}

// ── canAssignRole ─────────────────────────────────────────────────────
//
// Privilege-escalation guard for any mutation that SETS a teammate's role
// (provision-from-directory; also applicable to the role-change PATCH). The
// `platform-admin` is the one org-wide privileged role and is cross-region by
// nature, so only an org-wide actor may grant it — a region-scoped `admin`
// minting it would be handing out a role outside their own scope. The
// region-scoped roles (developer / manager / admin) are assignable by any
// authorised mutator; the region clamp on the endpoint bounds WHERE they land.
/**
 * May `callerRole` MODIFY a teammate who currently HOLDS `currentRole`?
 *
 * Distinct from `canAssignRole`, which answers "may they GRANT this role". The
 * role-change route asks both, and collapsing them stranded the retirement's own
 * cleanup path: a retired role is not assignable BY ANYONE, so running the
 * current-role direction through `canAssignRole` meant not even a platform-admin
 * could demote a stray `global-finops` or `finance` holder. Migration 0140 exists
 * precisely for rows that should not be there; refusing to let anyone fix a row
 * it missed, raced, or that reappeared is the opposite of what the retirement is
 * for.
 *
 * Holding a retired role confers nothing, so its holder is not a privileged
 * target — but the remediation is an org-wide anomaly cleanup, so it stays with
 * platform-admin rather than any region admin who happens to see the row.
 */
export function canModifyHolderOf(callerRole: Role, currentRole: Role): boolean {
  if (isRetiredRole(currentRole)) return callerRole === 'platform-admin'
  if (currentRole === 'platform-admin') return callerRole === 'platform-admin'
  return true
}

export function canAssignRole(callerRole: Role, targetRole: Role): boolean {
  // A retired role grants nothing and may never be minted — by anyone, including
  // platform-admin. Without this arm, retiring `global-finops` would have
  // LOOSENED the guard: once it stopped counting as an org-wide grant it fell
  // through to the permissive tail below, so a region admin could have assigned
  // it. The same arm closes the identical, older hole for `finance`.
  if (isRetiredRole(targetRole)) return false
  const orgWideGrant = targetRole === 'platform-admin'
  if (orgWideGrant) return callerRole === 'platform-admin'
  return true
}
