/*
 * Roles + demo personas — pilot-shaped.
 *
 * Six canonical roles per the design / chrome.jsx RoleMenu (see ROLES below:
 * developer, manager, admin, finance, global-finops, platform-admin). Per
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

/** Roles that can reach the admin area at all (region-scoped or wider). */
export const ADMIN_ROLES = ['admin', 'global-finops', 'platform-admin'] as const

/** Org-wide (cross-region) roles: unbounded data scope, edit platform defaults. */
export const ORG_WIDE_ROLES = ['global-finops', 'platform-admin'] as const

/** True for any role that may enter /admin (Region admin, Global finance, Platform admin). */
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && (ADMIN_ROLES as readonly string[]).includes(role)
}

/** True for the cross-region roles (Global finance, Platform admin). */
export function isOrgWideRole(role: string | null | undefined): boolean {
  return !!role && (ORG_WIDE_ROLES as readonly string[]).includes(role)
}

/**
 * Roles offered in role-assignment dropdowns. Excludes `finance` — a retired
 * enum member never assigned to anyone (kept in ROLES only for exhaustiveness /
 * historical data). Never offer an unassignable role. See the "Roles & terms"
 * glossary for why `finance` still exists in the enum.
 */
export const SELECTABLE_ROLES: readonly Role[] = ROLES.filter((r) => r !== 'finance')

/**
 * Canonical human-facing role labels — ONE source so no surface renders a raw
 * enum code. `admin` is region-scoped ("Region admin"); `global-finops` is the
 * cross-region finance super-role ("Global finance"), deliberately distinct
 * from the retired `finance`. See docs/design/admin-ia.md §Vocabulary.
 */
export const ROLE_LABELS: Record<Role, string> = {
  developer: 'Developer',
  manager: 'Manager',
  admin: 'Region admin',
  finance: 'Finance (retired)',
  'global-finops': 'Global finance',
  'platform-admin': 'Platform admin',
}

/** Display label for a role value; falls back to the raw value if unknown. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—'
  return (ROLE_LABELS as Record<string, string>)[role] ?? role
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
