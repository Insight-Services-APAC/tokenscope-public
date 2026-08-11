/*
 * Insight org-structure seed — the canonical top-level structure: 4 regions and the cost-owning
 * units beneath them (the things projects attach to and people are placed into). SCAFFOLD from the
 * org charts (2026-06-29); items marked TODO(confirm) are my best guess — correct them.
 *
 *   DATABASE_URL=… tsx drizzle/seed-org-structure.ts        # npm run db:seed:org-structure
 *
 * Top level: APAC, EMEA, North America, Global IT. North America nests United States (which holds
 * the 15 business lines) and Canada (its own BU). Each region labels its units differently (EMEA
 * "Areas of Expertise", US "Business Lines", APAC "Business Units"); that label is display
 * vocabulary (region-configurable), not structure.
 *
 * VERSIONED (run-once, re-runnable on bump): the applied version is recorded in `seed_state`
 * (mig 0077). On boot the entrypoint sets SEED_ORG_STRUCTURE_IF_OUTDATED=true, so it runs only
 * when the recorded version is behind SEED_ORG_STRUCTURE_VERSION (fresh DB, or a deliberate bump
 * to roll a structural change to every environment on its next deploy) and otherwise no-ops —
 * never overriding manual UI edits. A manual run (no flag) always applies + stamps the version.
 *
 * Idempotent by (region, code): regions upsert by code; units upsert by (region, code), never
 * disturbing an existing unit's ltree path/children. The APAC codes here are ALIGNED to the live
 * structure ('apac-<x>'), so re-running upserts the existing rows rather than duplicating them.
 * CAUTION generally: dedup only works when codes MATCH — if EMEA / North America turn out to be
 * already set up with DIFFERENT codes than this scaffold, scope to just the empty regions with
 * `SEED_ONLY_REGIONS=emea,north-america,global-it npm run db:seed:org-structure` to avoid dupes.
 * It does NOT create region leaders or cou_owners (those need real Entra
 * OIDs/teammates) — set leaders via Admin → Regions → Leaders (resolves the OID from the
 * directory) and practice owners via the org-unit owners flow; both then drive manager-chain
 * placement.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { createDbClient } from './connect'
import * as schema from './schema'

// Bump when the structure below changes and you want every environment to re-apply it on its next
// deploy (the boot guard re-runs while seed_state.version < this). A manual run always applies.
const SEED_ORG_STRUCTURE_VERSION = 1

interface Unit { code: string; displayName: string; type?: 'bu' | 'practice'; costOwning?: boolean; children?: Unit[] }
interface RegionDef { code: string; displayName: string; unitTerm: string; units: Unit[] }

// The 15 US Level-1 business lines (cost-owning practices under the United States BU).
const US_LINES: Unit[] = [
  ['acquisition', 'Acquisition'],
  ['advisory-implementation', 'Advisory & Implementation Services'],
  ['apps-integration', 'Apps & Integration'],
  ['cloud', 'Cloud'],
  ['cloud-infrastructure', 'Cloud Infrastructure'],
  ['data-ai', 'Data & AI'],
  ['dedicated-managed-solutions', 'Dedicated Managed Solutions'],
  ['digital-enablement', 'Digital Enablement'],
  ['field', 'Field'],
  ['infrastructure-services', 'Infrastructure Services'],
  ['lifecycle-field-services', 'Lifecycle & Field Services'],
  ['managed-services', 'Managed Services'],
  ['managed-solutions', 'Managed Solutions'],
  ['modern-workplace', 'Modern Workplace'],
  ['security-advisory-services', 'Security & Advisory Services'],
].map(([code, displayName]) => ({ code, displayName, type: 'practice' as const }))

const ORG: RegionDef[] = [
  {
    // Codes/names match the LIVE APAC structure ('apac-<x>' → path 'apac.apac_<x>'), so a re-run
    // upserts the existing rows instead of duplicating them.
    code: 'apac', displayName: 'APAC', unitTerm: 'Business Unit',
    units: [
      { code: 'apac-ops', displayName: 'Operations', type: 'practice' },
      { code: 'apac-mpo', displayName: 'Modern Platform & Operations', type: 'practice' },
      { code: 'apac-aibt', displayName: 'AI & Business Transformation', type: 'practice' },
      { code: 'apac-appsdata', displayName: 'AI Apps & Data', type: 'practice' },
      { code: 'apac-cto', displayName: 'CTO', type: 'practice' },
      { code: 'apac-aibs', displayName: 'AI Business Solutions', type: 'practice' },
      { code: 'apac-sales', displayName: 'Sales', type: 'practice' },
    ],
  },
  {
    code: 'emea', displayName: 'EMEA', unitTerm: 'Area of Expertise',
    units: [
      { code: 'bts', displayName: 'Business Technology Strategy' },
      { code: 'cyber-security', displayName: 'Cyber Security' },
      { code: 'data-ai', displayName: 'Data & AI' },
      { code: 'modern-apps', displayName: 'Modern Apps' },
      { code: 'modern-infrastructure', displayName: 'Modern Infrastructure' },
      { code: 'modern-workplace', displayName: 'Modern Workplace' },
      { code: 'technology-lifecycle', displayName: 'Technology Lifecycle' },
    ],
  },
  {
    code: 'north-america', displayName: 'North America', unitTerm: 'Business Unit',
    units: [
      // United States is a container BU; its 15 Level-1 lines are the cost-owning units.
      { code: 'united-states', displayName: 'United States', costOwning: false, children: US_LINES },
      { code: 'canada', displayName: 'Canada' }, // a single cost-owning BU
    ],
  },
  {
    code: 'global-it', displayName: 'Global IT', unitTerm: 'Team',
    units: [{ code: 'global-it', displayName: 'Global IT' }], // TODO(confirm): the IT team breakdown.
  },
]

/** ltree label: lowercase, non-[a-z0-9_] → '_' (matches org-units.post.ts deriveLabel). */
function label(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9_]/g, '_')
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1) }
  const client = createDbClient(url, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema })

  // Upsert one unit (and recurse into its children). Cost-owning defaults to true for a leaf,
  // false for a container (a unit with children); unit_type defaults to 'bu'.
  async function upsertUnit(regionId: string, parentId: string | null, parentPath: string, u: Unit): Promise<void> {
    const path = `${parentPath}.${label(u.code)}`
    const costOwning = u.costOwning ?? !(u.children && u.children.length)
    const unitType = u.type ?? 'bu'
    const [{ id }] = await db.execute<{ id: string }>(sql`
      INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit, source)
      VALUES (${regionId}::uuid, ${parentId}::uuid, ${path}::ltree, ${u.code}, ${u.displayName}, ${unitType}, ${costOwning}, 'seed')
      ON CONFLICT (region_id, code) DO UPDATE
        SET display_name = EXCLUDED.display_name, is_cost_owning_unit = EXCLUDED.is_cost_owning_unit, retired_at = NULL
      RETURNING id::text AS id
    `)
    for (const c of u.children ?? []) await upsertUnit(regionId, id, path, c)
  }

  // Scope: SEED_ONLY_REGIONS=emea,north-america,global-it seeds just those (skip regions that are
  // already set up — e.g. APAC on Dev uses different codes/names than this scaffold, so re-seeding
  // it would create DUPLICATE cost centres). Unset = all regions (correct for a fresh environment).
  const only = (process.env.SEED_ONLY_REGIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const toSeed = only.length ? ORG.filter((r) => only.includes(r.code)) : ORG
  if (only.length) console.warn(`SEED_ONLY_REGIONS: seeding ${toSeed.map((r) => r.code).join(', ') || '(none matched)'}`)

  try {
    // Version guard (boot path): the entrypoint sets SEED_ORG_STRUCTURE_IF_OUTDATED=true, so a
    // deploy applies the structure only while the recorded version is behind the code, then no-ops.
    if (process.env.SEED_ORG_STRUCTURE_IF_OUTDATED === 'true') {
      const recorded = await db.execute<{ version: number }>(sql`SELECT version FROM seed_state WHERE name = 'org-structure'`)
      const applied = recorded[0]?.version ?? 0
      if (applied >= SEED_ORG_STRUCTURE_VERSION) {
        console.warn(`SEED_ORG_STRUCTURE_IF_OUTDATED: already at v${applied} (code v${SEED_ORG_STRUCTURE_VERSION}) — skipping.`)
        return
      }
      console.warn(`SEED_ORG_STRUCTURE_IF_OUTDATED: recorded v${applied} < code v${SEED_ORG_STRUCTURE_VERSION} — applying.`)
    }
    let regions = 0, units = 0
    const count = (us: Unit[]): number => us.reduce((n, u) => n + 1 + count(u.children ?? []), 0)
    for (const r of toSeed) {
      await db.insert(schema.region).values({ code: r.code, displayName: r.displayName }).onConflictDoNothing()
      const [{ id: regionId }] = await db.execute<{ id: string }>(sql`SELECT id::text AS id FROM region WHERE code = ${r.code}`)
      // Ensure the region's 'default' BU — the root the JIT teammate path needs and the
      // node the tree hangs off (seed-regions plants it at path = region label for the
      // real regions; this also covers global-it, which seed-regions doesn't). The seed's
      // units parent UNDER it, so the tree nests like APAC's existing practices-under-default
      // (OrgTree builds by parent_id), not as sibling roots. Idempotent by (region, code).
      const regionLabel = label(r.code)
      const [{ id: defaultId }] = await db.execute<{ id: string }>(sql`
        INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit, source)
        VALUES (${regionId}::uuid, NULL, ${regionLabel}::ltree, 'default', ${`${r.displayName} (default)`}, 'bu', true, 'seed')
        ON CONFLICT (region_id, code) DO UPDATE SET retired_at = NULL
        RETURNING id::text AS id
      `)
      for (const u of r.units) await upsertUnit(regionId, defaultId, regionLabel, u)
      regions++; units += count(r.units)
      console.warn(`region ready: ${r.displayName} (${r.code}) — ${count(r.units)} units`)
    }
    // Stamp the applied version so the boot guard no-ops next time. A partial run (SEED_ONLY_REGIONS)
    // is NOT the whole structure, so it must not claim the version — only a full run stamps.
    if (!only.length) {
      await db.execute(sql`
        INSERT INTO seed_state (name, version, applied_at) VALUES ('org-structure', ${SEED_ORG_STRUCTURE_VERSION}, now())
        ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, applied_at = now()`)
    }
    console.warn(`Org structure seeded: ${regions} regions, ${units} units (v${SEED_ORG_STRUCTURE_VERSION}). Set region leaders + practice owners next.`)
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
