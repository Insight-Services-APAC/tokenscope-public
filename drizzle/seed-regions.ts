/*
 * Clean-environment bootstrap seed — regions + a default cost-owning BU each,
 * and NOTHING else. This is the minimum the JIT teammate path needs
 * (server/auth/jit-teammate.ts picks the lexicographically-first region + its
 * first org_unit), so first Entra sign-in on a fresh corporate environment
 * (DEV) succeeds instead of looping on "no region rows".
 *
 * Unlike drizzle/seed.ts (the APAC pilot seed, which also plants synthetic
 * DEMO-region fixtures), this inserts ONLY the real regions — keep DEV clean.
 * Idempotent + safe to re-run: regions upsert by their unique code, and the
 * default BU is created only if the region has no org_unit yet.
 *
 *   DATABASE_URL=… tsx drizzle/seed-regions.ts        # npm run db:seed:regions
 *
 * SEED_REGIONS_IF_EMPTY=true makes it a no-op when ANY region already exists —
 * the mode the container entrypoint uses, so a fresh environment self-bootstraps
 * on boot but an already-populated one (sandbox/staging/prod) is never touched.
 * Without the flag (manual invocation) it always ensures the three regions.
 *
 * The first sign-in lands in the lexicographically-first region ('apac'). Set
 * NUXT_BOOTSTRAP_ADMIN_EMAIL to the first signer's Entra email BEFORE they sign
 * in so they are provisioned super-admin (otherwise: plain 'developer').
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import { createDbClient } from './connect'
import * as schema from './schema'

// Canonical real regions — kept in lockstep with seedRealRegions() in seed.ts.
const REGIONS = [
  { code: 'apac', displayName: 'APAC' },
  { code: 'emea', displayName: 'EMEA' },
  { code: 'north-america', displayName: 'North America' },
]

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }
  const client = createDbClient(url, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema })

  try {
    // Boot path (entrypoint): only bootstrap a DB that has NO regions yet, so an
    // already-seeded environment is left untouched.
    if (process.env.SEED_REGIONS_IF_EMPTY === 'true') {
      const [{ n }] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM region`)
      if (n > 0) {
        console.warn(`SEED_REGIONS_IF_EMPTY: ${n} region(s) already present — skipping.`)
        return
      }
    }
    for (const r of REGIONS) {
      // Upsert the region by its unique code — re-runs are no-ops.
      await db.insert(schema.region).values({ code: r.code, displayName: r.displayName }).onConflictDoNothing()
      const [region] = await db
        .select({ id: schema.region.id })
        .from(schema.region)
        .where(eq(schema.region.code, r.code))
      if (!region) throw new Error(`seed-regions: ${r.code} region missing after upsert`)

      // Ensure exactly one default cost-owning BU exists for the region.
      const existing = await db
        .select({ id: schema.orgUnit.id })
        .from(schema.orgUnit)
        .where(eq(schema.orgUnit.regionId, region.id))
        .limit(1)
      if (existing.length === 0) {
        await db.insert(schema.orgUnit).values({
          regionId: region.id,
          path: r.code.replace(/-/g, '_'),
          code: 'default',
          displayName: `${r.displayName} (default)`,
          unitType: 'bu',
          isCostOwningUnit: true,
        })
      }
      console.warn(`region ready: ${r.displayName} (${r.code})`)
    }

    // Insight-specific EXAMPLE region rules (opt-in). Maps the Entra `companyName`
    // legal entity → region — the signal that is region-correlated on Insight's
    // directory (verified: "Insight Australia/United Kingdom/USA/Canada"). Gated
    // behind SEED_INSIGHT_REGION_RULES so open-source adopters NEVER inherit
    // Insight's values; they curate their own in the Region rules UI (Discover
    // shows which attribute maps to region on their tenant). Canada currently
    // rolls into north-america (no separate region); re-point via the UI if it
    // becomes its own region.
    if (process.env.SEED_INSIGHT_REGION_RULES === 'true') {
      const INSIGHT_COMPANY_RULES: Array<[string, string]> = [
        ['Insight Australia', 'apac'],
        ['Insight United Kingdom', 'emea'],
        ['Insight USA', 'north-america'],
        ['Insight Canada', 'north-america'],
      ]
      for (const [company, regionCode] of INSIGHT_COMPANY_RULES) {
        const [region] = await db
          .select({ id: schema.region.id })
          .from(schema.region)
          .where(eq(schema.region.code, regionCode))
        if (!region) {
          console.warn(`region-rule seed: region '${regionCode}' missing — skipping ${company}`)
          continue
        }
        await db
          .insert(schema.directoryRegionRule)
          .values({
            attribute: 'companyName',
            matchMode: 'exact',
            matchValue: company.trim().toLowerCase(),
            matchValueRaw: company,
            regionId: region.id,
          })
          .onConflictDoNothing()
      }
      console.warn('Insight companyName → region rules seeded (SEED_INSIGHT_REGION_RULES).')
    }
    console.warn('Clean-environment regions seeded. First Entra sign-in can now JIT-provision.')
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
