/*
 * Region-attribute catalog — the ONE source for which Entra directory attributes
 * can drive region derivation, their display metadata, and their precedence.
 *
 * The placement engine (server/reconciliation/region-derivation.ts) and the
 * admin UI both import this, so a new candidate attribute is added in exactly
 * one place. Pure data + normalisers (no Vue/Nitro/DB imports) → unit-testable.
 *
 * Precedence = ARRAY ORDER: most-specific entity/geo signal first, org-function
 * last. When a tenant only curates rules for ONE attribute (the common case)
 * precedence is moot; it only decides ties when rules exist for several. This
 * is the documented single source — a per-tenant reorder is a future option.
 */

// NOTE: `division` (and `costCenter`) are deliberately EXCLUDED. They come from
// Entra `employeeOrgData`, whose tenant population is unverified — per
// docs/design/entra-auto-placement.md they are SUGGESTION-grade only and must
// never drive AUTOMATIC placement. `department` IS included: it is a base User
// property and was the original mig-0068 auto-placement signal.
export type RegionAttributeKey =
  | 'companyName'
  | 'country'
  | 'officeLocation'
  | 'state'
  | 'department'

/** How a rule's value is compared to the user's attribute value. */
export type MatchMode = 'exact' | 'prefix'
export const MATCH_MODES: readonly MatchMode[] = ['exact', 'prefix'] as const
export function isMatchMode(v: string): v is MatchMode {
  return (MATCH_MODES as readonly string[]).includes(v)
}

export interface RegionAttribute {
  key: RegionAttributeKey
  /** Human label for the picker. */
  label: string
  /** Graph `$select` property name (identical to `key` for all current attrs). */
  graph: string
  /** "What this usually looks like" — shown in the UI so a non-expert admin
   *  can tell attributes apart. */
  hint: string
  example: string
  /** Whether prefix matching is a sensible default suggestion (site codes like
   *  "AU-Brisbane" want prefix; a company name wants exact). */
  suggestsPrefix: boolean
}

/**
 * Ordered by precedence (index 0 wins ties). Entity/geo signals that correlate
 * cleanly to region come first; org-function attributes (department/division),
 * which are often flat, come last.
 */
export const REGION_ATTRIBUTES: readonly RegionAttribute[] = [
  {
    key: 'companyName',
    label: 'Company name',
    graph: 'companyName',
    hint: 'The legal entity — often one per country. The cleanest region signal on most tenants.',
    example: 'Insight Australia',
    suggestsPrefix: false,
  },
  {
    key: 'country',
    label: 'Country or region',
    graph: 'country',
    hint: 'The profile country. Clean, but groups every country into one region and can vary in casing.',
    example: 'Australia',
    suggestsPrefix: false,
  },
  {
    key: 'officeLocation',
    label: 'Office location',
    graph: 'officeLocation',
    hint: 'Site/office code, often prefixed by country or state (AU-…, GA-…). Use PREFIX matching to map a whole country at once.',
    example: 'AU-Brisbane',
    suggestsPrefix: true,
  },
  {
    key: 'state',
    label: 'State or province',
    graph: 'state',
    hint: 'State/province. Sparse on many tenants; useful for within-country sub-regions.',
    example: 'Queensland',
    suggestsPrefix: false,
  },
  {
    key: 'department',
    label: 'Department',
    graph: 'department',
    hint: 'Org function (Sales, Services…). Only region-correlated on AEUF-shaped tenants where department encodes geography.',
    example: 'APAC Digital',
    suggestsPrefix: false,
  },
]

export const REGION_ATTRIBUTE_KEYS: readonly RegionAttributeKey[] = REGION_ATTRIBUTES.map((a) => a.key)

export function isRegionAttributeKey(v: string): v is RegionAttributeKey {
  return (REGION_ATTRIBUTE_KEYS as readonly string[]).includes(v)
}

export function regionAttribute(key: string): RegionAttribute | undefined {
  return REGION_ATTRIBUTES.find((a) => a.key === key)
}

export function regionAttributeLabel(key: string): string {
  return regionAttribute(key)?.label ?? key
}

/** Precedence index (lower wins). Unknown keys sort last. */
export function attributePrecedence(key: string): number {
  const i = REGION_ATTRIBUTE_KEYS.indexOf(key as RegionAttributeKey)
  return i === -1 ? REGION_ATTRIBUTES.length : i
}

/** The normalised comparison key for a rule value or a user's attribute value. */
export function normalizeMatchValue(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase()
}
