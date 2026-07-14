/*
 * Roles + demo personas — pilot-shaped.
 *
 * Five canonical roles per the design / chrome.jsx RoleMenu. Per
 * docs/build/mvp-lite-epic.md §Epic 3: "4 demo personas → each lands on
 * role-correct page". The fifth (`global-finops`) is the cross-region
 * super-finance role used in RLS bypass; `finance` (region-finance) is
 * the persona shown in the demo grid.
 *
 * Persona records below are the dev-mode mapping. Real Entra OIDC
 * (Epic 10) replaces dev-login but the role enum stays.
 */

// `platform-admin` is the cross-region super-admin (region-unbounded; passes
// any requireRole and maps to the unbounded scope at the RLS layer). `admin`
// is the per-region admin (region-scoped via requireRegionScope).
// TODO(region-model): relabel `admin` → `region-admin` for clarity once the
// role rename churn is worth it (see docs/build/dogfood-followups.md).
export const ROLES = ['developer', 'manager', 'admin', 'finance', 'global-finops', 'platform-admin'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

/** Cross-region super-admin: satisfies any role gate, unbounded data scope. */
export function isPlatformAdmin(role: string): boolean {
  return role === 'platform-admin'
}

export const DEMO_PERSONAS = [
  {
    key: 'developer',
    role: 'developer' as Role,
    email: 'demo-priya.iyer@example.com',
    displayName: 'Priya Iyer (demo)',
    landing: '/',
  },
  {
    key: 'manager',
    role: 'manager' as Role,
    email: 'demo-anil.verma@example.com',
    displayName: 'Anil Verma (demo)',
    landing: '/reporting?scope=regional',
  },
  {
    key: 'admin',
    role: 'admin' as Role,
    email: 'demo-lena.park@example.com',
    displayName: 'Lena Park (demo)',
    landing: '/admin',
  },
  {
    key: 'finance',
    role: 'global-finops' as Role,
    email: 'demo-mara.holloway@example.com',
    displayName: 'Mara Holloway (demo)',
    landing: '/reporting?scope=finance',
  },
  // CC owner (J1, mig 0048): org role is plain developer — the P&L
  // visibility flows from cou_owner relationship rows, not the role enum.
  {
    key: 'cc-owner',
    role: 'developer' as Role,
    email: 'demo-owen.cole@example.com',
    displayName: 'Owen Cole (demo)',
    landing: '/reporting?scope=cost-centre',
  },
] as const

export type PersonaKey = (typeof DEMO_PERSONAS)[number]['key']

export function getPersona(key: string) {
  return DEMO_PERSONAS.find((p) => p.key === key)
}
