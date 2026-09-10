/*
 * Demo persona role-mapping + landing paths.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 3 EVS: "4 demo personas → each
 * lands on role-correct page". The integration that exercises the wired
 * Nitro endpoint is covered by tests/smoke (which boots the dev server
 * and asserts /login renders the 4 buttons); this file pins the source
 * of truth — shared/auth/roles.ts DEMO_PERSONAS — against the four
 * required personas and the landing paths the dev-login handler returns.
 */
import { describe, it, expect } from 'vitest'
import { DEMO_PERSONAS, getPersona, ROLES } from '../../../shared/auth/roles'

describe('demo personas', () => {
  it('exposes exactly 5 personas matching the design spec', () => {
    // cc-owner added by the org-journey sprint (J3, mig 0048): developer
    // ROLE whose P&L view flows from cou_owner relationship rows.
    const keys = DEMO_PERSONAS.map((p) => p.key).sort()
    expect(keys).toEqual(['admin', 'cc-owner', 'developer', 'finance', 'manager'])
  })

  it('every persona maps to a valid role', () => {
    for (const p of DEMO_PERSONAS) {
      expect(ROLES, `role ${p.role} not in ROLES enum`).toContain(p.role)
    }
  })

  it('each persona has the role-correct landing path', () => {
    expect(getPersona('developer')?.landing).toBe('/')
    // Reporting cutover: the former Team/Finance/CC landing pages collapsed into
    // the /reporting scopes, so the persona landings point at those scopes now.
    expect(getPersona('manager')?.landing).toBe('/reporting?scope=region')
    expect(getPersona('admin')?.landing).toBe('/admin')
    expect(getPersona('finance')?.landing).toBe('/reporting?scope=finance')
    expect(getPersona('cc-owner')?.landing).toBe('/reporting?scope=cost-centre')
  })

  it('finance persona is a plain DEVELOPER — its reach comes from grants, not a role', () => {
    /*
     * This asserted `global-finops` until that role was retired, then briefly
     * `platform-admin` because the persona was repointed there to keep its
     * landing page resolving — which silently made "Sign in as Global finance"
     * the 122-route org-wide super-admin.
     *
     * The company-wide finance lens is a per-teammate `report_access_grant`
     * (mig 0129), which is the whole reason the role could be retired at all.
     * The seed gives Mara `operational` + `finance`; she administers nothing.
     * So the persona demonstrates the grant model rather than quietly handing
     * a demo session the widest role in the product.
     */
    expect(getPersona('finance')?.role).toBe('developer')
    expect(getPersona('finance')?.landing).toBe('/reporting?scope=finance')
  })

  it('emails resolve to teammates seeded by drizzle/seed.ts', () => {
    const emails = DEMO_PERSONAS.map((p) => p.email)
    // The seed inserts exactly these emails; if a persona's email drifts
    // the dev-login handler can't resolve the teammate row.
    expect(emails).toContain('demo-priya.iyer@example.com')
    expect(emails).toContain('demo-anil.verma@example.com')
    expect(emails).toContain('demo-lena.park@example.com')
    expect(emails).toContain('demo-mara.holloway@example.com')
  })

  it('unknown persona key returns undefined', () => {
    expect(getPersona('martian')).toBeUndefined()
  })
})
