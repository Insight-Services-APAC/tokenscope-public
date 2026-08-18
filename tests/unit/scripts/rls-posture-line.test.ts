/*
 * The boot line is the whole deliverable of the pre-flight half of this probe:
 * one line in a deploy log that says whether the app is on the owner connection,
 * how much of the policy set actually executes, and whether the non-owner app
 * role exists yet. Nobody reads a JSON blob out of a container log.
 *
 * The states below are the ones the integration suite cannot cheaply
 * manufacture against a real database — a forced-and-enforced estate, and a
 * bootstrap set still enabled while the app is already on the app role (the
 * fleet-stop shape). Pure function, so they are asserted directly.
 */
import { describe, it, expect } from 'vitest'
import {
  formatRlsPostureLine,
  RLS_APP_ROLE,
  type RlsPostureReport,
} from '../../../scripts/preflight-rls'

type Report = Omit<RlsPostureReport, 'line'>

/** A posture report in the state this branch starts from, with overrides. */
function report(
  patch: {
    lane?: Report['connection']['lane']
    currentUser?: string
    rlsEnabled?: number
    rlsForced?: number
    policies?: number
    policiesApply?: number
    bootstrapStillEnabled?: string[]
    appRoleExists?: boolean
    appRoleCanLogin?: boolean
    provisionBasis?: Report['capability']['provisionBasis']
    viaSetRole?: string[]
  } = {},
): Report {
  const basis = patch.provisionBasis ?? 'superuser'
  return {
    measuredAt: '2026-08-15T00:00:00.000Z',
    capability: {
      currentUser: patch.currentUser ?? 'tokenscope',
      sessionUser: patch.currentUser ?? 'tokenscope',
      isSuperuser: basis === 'superuser',
      canCreateRole: basis === 'createrole',
      canBypassRls: false,
      azurePgAdmin: { rolePresent: false, isMember: null },
      createRoleViaSetRole: patch.viaSetRole ?? [],
      canProvisionRole: basis !== 'none',
      provisionBasis: basis,
    },
    appRole: {
      roleName: RLS_APP_ROLE,
      exists: patch.appRoleExists ?? false,
      canLogin: patch.appRoleExists ? (patch.appRoleCanLogin ?? true) : null,
      isSuperuser: patch.appRoleExists ? false : null,
      canBypassRls: patch.appRoleExists ? false : null,
      inherits: patch.appRoleExists ? false : null,
      memberOf: [],
      grants: null,
    },
    connection: {
      currentUser: patch.currentUser ?? 'tokenscope',
      lane: patch.lane ?? 'owner',
      ownedTables: patch.lane === 'owner' || !patch.lane ? 23 : 0,
      bypass: {
        superuser: basis === 'superuser',
        bypassRls: false,
        owner: patch.lane !== 'app-role',
      },
    },
    summary: {
      tablesReported: patch.rlsEnabled ?? 23,
      rlsEnabled: patch.rlsEnabled ?? 23,
      rlsForced: patch.rlsForced ?? 0,
      policies: patch.policies ?? 40,
      policiesApply: patch.policiesApply ?? 0,
      bootstrapStillEnabled: patch.bootstrapStillEnabled ?? [],
    },
    tables: [],
  }
}

describe('formatRlsPostureLine', () => {
  it('states today: owner connection, nothing forced, nothing enforced, no app role', () => {
    expect(formatRlsPostureLine(report())).toBe(
      "rls: owner-connection as 'tokenscope', 0/23 forced, 0/23 enforced, 40 policies, " +
        `app-role '${RLS_APP_ROLE}' absent, can-create-role=yes (superuser)`,
    )
  })

  it('states the target: app-role connection with every policy executing', () => {
    const line = formatRlsPostureLine(
      report({
        lane: 'app-role',
        currentUser: RLS_APP_ROLE,
        rlsForced: 23,
        policiesApply: 23,
        appRoleExists: true,
        provisionBasis: 'none',
      }),
    )
    expect(line).toContain(`app-role-connection as '${RLS_APP_ROLE}'`)
    expect(line).toContain('23/23 forced')
    expect(line).toContain('23/23 enforced')
    expect(line).toContain(`app-role '${RLS_APP_ROLE}' present (LOGIN)`)
    expect(line).toContain('can-create-role=no (none)')
  })

  it('distinguishes a role that exists but cannot log in', () => {
    const line = formatRlsPostureLine(report({ appRoleExists: true, appRoleCanLogin: false }))
    expect(line).toContain('present (NOLOGIN)')
    expect(line).not.toContain('present (LOGIN)')
  })

  it('names the roles CREATEROLE is only reachable through', () => {
    const line = formatRlsPostureLine(
      report({ provisionBasis: 'set-role', viaSetRole: ['azure_pg_admin'] }),
    )
    expect(line).toContain('can-create-role=yes (set-role azure_pg_admin)')
  })

  it('flags bootstrap tables still enabled — silent on the owner, fatal on the app role', () => {
    const clean = formatRlsPostureLine(report())
    expect(clean).not.toContain('bootstrap-still-enabled')

    const hazard = formatRlsPostureLine(
      report({ bootstrapStillEnabled: ['oauth_token', 'teammate', 'org_unit'] }),
    )
    expect(hazard).toContain('bootstrap-still-enabled=3')
  })

  it('never emits anything credential-shaped', () => {
    const line = formatRlsPostureLine(report())
    expect(line).not.toContain('://')
    expect(line.toLowerCase()).not.toContain('password')
  })
})
