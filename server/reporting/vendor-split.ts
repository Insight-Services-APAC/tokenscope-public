import { sql } from 'drizzle-orm'
import { laneListSql } from '../../shared/usage/vendor'
import { CLAUDE_FAMILY_TOOLS } from '../../shared/usage/surface'
import { GITHUB_USAGE_TOOLS } from '../../shared/usage/github-surface'

/**
 * The §A "Burn by vendor" split — ONE classifier, shared by every surface that
 * draws it.
 *
 * WHY IT IS SHARED. The cost-centre drill and the regional view each carried
 * their own copy of the same three FILTER aggregates, byte-identical, so the
 * defect was invisible in a diff: both matched the single literals
 * `'claude-code'` and `'copilot-cli'` and swept every other tool into "Other".
 * The estate carries seven tools; five of them were "Other":
 *
 *     claude-ai $13,161 · claude-office $1,310 · claude-cowork $693 ·
 *     claude-design $569   (Anthropic)         · copilot-agent $1,295 (GitHub)
 *
 * ~7% of org-wide burn — and 100% of it on a cost centre whose people work in
 * chat rather than the CLI. That was Practice Echo rendering "Other $20.20 ·
 * 100%" with the People card one row below splitting the same $20.20 by model
 * tier. Region looked correct only because `claude-code` dominates the org
 * total; it carried the identical defect.
 *
 * VENDOR IS COARSER THAN LANE, DELIBERATELY. The canon gives every non-Code
 * Claude surface its OWN lane (`VENDOR_LANES`, #142) — so `vendorCostSql()`
 * splits finer than this card asks. This card asks who BUILDS the tool, the
 * question `vendorProvider(lane)` answers, so it groups by provider family.
 * Re-shaping the whole reporting payload to per-lane is a real change worth
 * making on its own (93 references across 27 files); it is not this fix.
 *
 * THE SETS ARE THE CANON'S, NEVER HAND LITERALS. `CLAUDE_FAMILY_TOOLS` and
 * `GITHUB_USAGE_TOOLS` are both composed from the surface adapters, so a vendor
 * shipping a new surface classifies here the day it is registered. That is what
 * the original filter could not do: `claude-cowork` and `claude-design` both
 * entered after it was written and were silently wrong from their first row.
 *
 * `other` stays a live catch-all (`NOT IN (…) OR IS NULL`) so nothing can
 * vanish from the vendor total — a NULL tool is genuinely unattributed, and is
 * never assumed into a vendor.
 */
const CLAUDE_TOOLS = laneListSql(CLAUDE_FAMILY_TOOLS)
const GITHUB_TOOLS = laneListSql(GITHUB_USAGE_TOOLS)
const LANED = laneListSql([...CLAUDE_FAMILY_TOOLS, ...GITHUB_USAGE_TOOLS])

/** The three vendor aggregates over `u.cost_usd`, for a query aliasing usage `u`. */
export const vendorSplitAggregates = sql`
  COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool IN (${CLAUDE_TOOLS})), 0)::text AS claude,
  COALESCE(SUM(u.cost_usd) FILTER (WHERE u.tool IN (${GITHUB_TOOLS})), 0)::text AS copilot,
  COALESCE(SUM(u.cost_usd) FILTER (
    WHERE u.tool IS NULL OR u.tool NOT IN (${LANED})), 0)::text AS other`
