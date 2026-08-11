/*
 * placement-provenance — the vocabulary for "this home was DERIVED, and here is
 * what derived it", as one module rather than a string literal per call site.
 *
 * WHY IT MATTERS. `teammate.metadata.placedVia` is not decoration: it is the flag
 * that decides whether a later pass may re-derive someone. A derived placement
 * (manager chain, or a curated attribute rule) is a standing inference and must
 * follow the configuration when the configuration changes — that is exactly what
 * spec C7's "Re-resolve placement" applies. An ADMIN placement is an assertion
 * and must NOT be re-derived, which is why server/db/place-teammate.ts strips
 * these keys on every manual move.
 *
 * So the set of derived kinds is the re-resolve candidate set, and the key list
 * is what a manual placement must clear. Both were previously spelled out as
 * literals in four files; adding the mig-0112 rule kind to three of them and
 * missing the fourth would have left rule-placed teammates permanently frozen
 * (never re-derived) or admin placements silently re-derived away.
 */
import { sql, type SQL } from 'drizzle-orm'

/** Placed by the Entra manager-chain walk → a cost-owning unit. */
export const PLACED_VIA_MANAGER_CHAIN = 'manager-chain'

/** Placed by a curated directory-attribute rule naming a unit (mig 0112). */
export const PLACED_VIA_ATTRIBUTE_RULE = 'attribute-rule'

/**
 * Every DERIVED placement kind — i.e. every value of `metadata.placedVia` whose
 * holder may be re-derived by a later pass. An admin placement has no
 * `placedVia` at all and is therefore never in this set.
 */
export const DERIVED_PLACEMENT_VIAS = [PLACED_VIA_MANAGER_CHAIN, PLACED_VIA_ATTRIBUTE_RULE] as const

export type DerivedPlacementVia = (typeof DERIVED_PLACEMENT_VIAS)[number]

/**
 * The metadata keys a placement provenance occupies. A manual placement strips
 * ALL of them; a derived placement rewrites them wholesale. Listed once so a new
 * key cannot be written by the setter and left behind by the stripper.
 */
export const PLACEMENT_PROVENANCE_KEYS = [
  'placedVia',
  'placedOwnerOid',
  'placedAttribute',
  'placedAt',
] as const

/** What derived this home. Discriminated so each kind carries only its own facts. */
export type PlacementProvenance =
  | { via: typeof PLACED_VIA_MANAGER_CHAIN; ownerOid: string }
  | { via: typeof PLACED_VIA_ATTRIBUTE_RULE; attribute: string }

/**
 * `- 'placedVia' - 'placedOwnerOid' - …` for every provenance key, to append to a
 * jsonb expression. Both the derived writer (which rewrites provenance and must
 * not leave a previous kind's key behind) and the manual placement (which erases
 * it) build their SQL from this one list.
 */
export function stripProvenanceKeys(): SQL {
  return sql.join(
    PLACEMENT_PROVENANCE_KEYS.map((k) => sql`- ${k}::text`),
    sql` `,
  )
}
