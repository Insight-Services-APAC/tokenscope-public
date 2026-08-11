/*
 * reporting/region-scope — the ONE place the Region scope decides its WIDTH.
 *
 * Region absorbed Across (04-prototype-delta.md §6). The whole-company rollup is
 * no longer a second route with a second gate; it is this scope's UNCLAMPED width,
 * reached by the `?region=all` first option of the region selector. So exactly one
 * question has to be answered per request — "all regions, or this one?" — and every
 * `/reports/region*` endpoint answers it here rather than five times.
 *
 * WHY A RESOLVER AND NOT A `region === 'all'` CHECK IN EACH HANDLER. Three things
 * have to stay locked together, and each is a different kind of mistake if it drifts:
 *
 *   1. The AUTHORIZATION. `all` requires `across`; a single region requires
 *      `regional`. Split across five handlers, one of them eventually gates the
 *      unclamped answer on the clamped grant — a whole-company total served to a
 *      region-bound caller, with no predicate underneath to contain the damage.
 *   2. The SELECTOR. `regionOptions` + `allRegionsAvailable` are what the client
 *      renders, and §6's rule is that the options ARE the grant. Computed anywhere
 *      other than beside the gate, the UI eventually offers a width the endpoint
 *      403s (or hides one it would serve).
 *   3. The ENGINE SCOPE. `all` ⇒ `wholeCompanyUsage`, one region ⇒ `clampedUsage`.
 *      engine/scope.ts makes "forgot the clamp" a value you have to write; this
 *      makes "wrote the wrong one" a single decision instead of five.
 *
 * The return type is a DISCRIMINATED UNION for the same reason engine/scope.ts is:
 * the clamped branch carries a `RegionalScope` and the unclamped branch structurally
 * has none, so a handler cannot read a scope that was never resolved, and cannot
 * forget to notice which width it is serving.
 */
import { createError } from 'h3'
import type { H3Event } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireReportScope } from '../auth/report-scope'
import { requireRole } from '../auth/rbac'
import { regionScopeGrant, type RegionScopeGrant } from '../../shared/auth/report-visibility'
import { ALL_REGIONS } from '../../shared/reports/types'
import {
  resolveRegionalScope,
  fetchRegionOptions,
  type RegionalScope,
  type RegionRef,
} from './regional'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * The `?region=` value as it arrives: the `all` sentinel, a region uuid, or absent.
 * Validated by each handler's zod schema as `RegionParam`, below.
 */
export type RegionParam = string | undefined

/** What the client needs to render the region selector — the grant, as options. */
export interface RegionSelector {
  /** The regions this caller may pick. Empty for a caller bound to their own region. */
  regionOptions: RegionRef[]
  /** Whether "All regions" (the whole-company width) is one of the options. */
  allRegionsAvailable: boolean
}

export type ResolvedRegionRequest =
  | ({ width: 'all-regions'; grant: RegionScopeGrant } & RegionSelector)
  | ({ width: 'region'; grant: RegionScopeGrant; scope: RegionalScope } & RegionSelector)

/** True iff `?region=` names the whole-company width rather than a single region. */
export function isAllRegions(region: RegionParam): boolean {
  return region === ALL_REGIONS
}

/**
 * The zod-compatible validator for `?region=`: the `all` sentinel OR a uuid.
 *
 * Handlers keep `z.string().uuid()` semantics for a real region id — a malformed
 * uuid is still a 400, not a silent fall-through to the caller's default region —
 * and add exactly one extra accepted literal.
 */
export function isValidRegionParam(v: string): boolean {
  return (
    v === ALL_REGIONS ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
}

/**
 * Resolve + AUTHORISE one `/reports/region*` request at whichever width it asked for.
 *
 * `?region=all` → the whole-company width. Gated on the caller's `across` grant via
 * `requireReportScope(..., { width: 'all-regions' })`, so a deny is audited exactly
 * as the retired `/reports/across-regions` gate audited it — that answer still has no
 * in-query clamp behind it, so the audit row is still the only forensic record.
 *
 * Anything else → the clamped width, resolved by `resolveRegionalScope` unchanged:
 * admin own-region force, org-wide roles any region, dev/manager subtree, `ou` drill
 * anti-IDOR. The report-visibility grant is threaded in as a LEVEL exactly as before.
 */
export async function resolveRegionRequest(
  event: H3Event,
  tx: Tx,
  params: { region?: RegionParam; ou?: string | null },
): Promise<ResolvedRegionRequest> {
  const wantsAll = isAllRegions(params.region)

  if (wantsAll) {
    /*
     * The whole-company width has NO region clamp and no `ou` drill: there is
     * nothing to clamp to. An `ou` alongside `region=all` is a contradiction the
     * caller should see rather than have silently dropped — dropping it would draw
     * a practice's heading over the whole company's money.
     */
    if (params.ou) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Bad Request',
        data: {
          type: 'https://tokenscope.example.com/errors/bad-request',
          title: 'Bad Request',
          status: 400,
          detail: "`ou` is a drill within one region and cannot be combined with `region=all`.",
        },
      })
    }
    const { session, grants } = await requireReportScope(event, tx, 'region', {
      width: 'all-regions',
    })
    const grant = regionScopeGrant(grants)
    return {
      width: 'all-regions',
      grant,
      // The selector still has to be rendered ON the whole-company view — it is how
      // the reader gets back to a single region. `crossRegion` decides whether that
      // list is every region or (see below) just their own.
      ...(await selectorFor(tx, grant, session.regionId)),
    }
  }

  const caller = await requireRole(
    event,
    'developer',
    'manager',
    'admin',
    'global-finops',
    'platform-admin',
  )
  // Gate the TAB before resolving: a caller with `regional: false` holds no single
  // region at all, and `resolveRegionalScope` would otherwise hand them their home
  // region's figures on the strength of their role enum alone.
  const { grants } = await requireReportScope(event, tx, 'region', { width: 'region' })
  const grant = regionScopeGrant(grants)
  const scope = await resolveRegionalScope(
    tx,
    caller,
    { region: params.region, ou: params.ou },
    { crossRegion: grant.crossRegion },
  )
  return {
    width: 'region',
    grant,
    scope,
    ...(await selectorFor(tx, grant, caller.regionId, scope)),
  }
}

/**
 * The selector, built from the grant and nothing else.
 *
 * `regionOptions` keeps its pre-merge meaning EXACTLY: the regions a caller may
 * pick OTHER than by default — empty for a caller bound to their own region, whose
 * selector therefore has nothing to offer and is not rendered. What the merge adds
 * is the "All regions" option, which is `across` and only `across`.
 *
 * The one new case is a caller who may read the whole company but is NOT cross-region
 * (`allRegions && !crossRegion`). Today's role matrix never produces it — `across`
 * always arrives with `regional: 'all-regions'` — but if it ever did, an empty option
 * list would leave them on "All regions" with no way back to a single region: the
 * "never stranded" failure, in the other direction. They get exactly the one region
 * they hold, their own, and nothing wider.
 */
async function selectorFor(
  tx: Tx,
  grant: RegionScopeGrant,
  ownRegionId: string,
  scope?: RegionalScope,
): Promise<RegionSelector> {
  if (grant.crossRegion) {
    return {
      // The clamped branch already ran this query inside `resolveRegionalScope`;
      // reading its result rather than repeating it keeps the options the request
      // was authorised against identical to the ones it reports.
      regionOptions: scope ? scope.regionOptions : await fetchRegionOptions(tx),
      allRegionsAvailable: grant.allRegions,
    }
  }
  if (!grant.allRegions || !grant.ownRegion) {
    return { regionOptions: [], allRegionsAvailable: grant.allRegions }
  }
  const own =
    scope?.region ?? (await fetchRegionOptions(tx)).find((r) => r.id === ownRegionId) ?? null
  return { regionOptions: own ? [own] : [], allRegionsAvailable: true }
}
