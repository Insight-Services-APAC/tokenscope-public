/*
 * Copilot flat-seat writer — SHOWBACK / DISPLAY-ONLY per-seat rows → actual_spend.
 *
 * SUPERSEDED FOR CHARGEBACK (reporting-consolidation Wave 0 / canonical §B): the Copilot
 * CHARGEBACK now comes from EXACTLY ONE surface — copilot_pool_bill (the POOLED bill net, read
 * by the copilot-pool-bill worker) — homed org→CoU. The per-seat rows this writer emits are
 * SHOWBACK / DISPLAY-ONLY: they are excluded from v_finance_bill_chargeback, from
 * v_finance_chargeback_month, and from the Σ=bill operand (test-enforced). The per-user OVERAGE
 * charge (`usage − $allowance`) that this writer used to emit was WRONG model #1
 * (docs/design/provider-billing-attribution-model.md §B) and has been REMOVED; the pooled
 * overage authority is copilot_pool_bill.overage_net_usd (read from the bill). The mig 0081
 * migration deletes the legacy source='copilot-overage' rows.
 *
 * What remains here: the whole-month flat per-seat rows (D1: a seat active any day owes the full
 * month), source='copilot-seat:<org>', tool='copilot-cli'. These are kept as a showback/display
 * signal only (a manager's "every dollar my people consume" view, rule 3); they are NOT a
 * chargeback figure and NEVER feed the pooled §B charge. Both dated the 1st of the month → a
 * re-run UPSERTS the same row (idempotent); each month gets its own set.
 *
 * NOTE (D-Showback): the owner decision REPLACES the per-seat showback rows with the §A-sanctioned
 * per-user usage display (the ai-credit usage lane, v_teammate_usage_daily copilot branch) in
 * user-facing lanes. This writer is retained for backward compatibility of the showback lane
 * until that display lands (Wave 5); its rows are firewalled out of every chargeback operand now.
 *
 * chargeback_exempt is still set from the license-org so NFR/exempt Copilot cost is shown in
 * showback (rule 3) but excluded from chargeback (rule 5) — the flag lives on the row; the
 * exclusion lives in the chargeback view. (Copilot is now excluded from chargeback wholesale by
 * tool anyway; the flag remains meaningful for the showback lane.)
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { GithubCopilotClient, type GithubSeat } from '../reconciliation/adapters/github-client'
import { seatLicenseOrg, isChargebackExemptOrg, chargebackExemptOrgSet } from '../reconciliation/adapters/github'

type Db = PostgresJsDatabase<typeof schema>

export interface CopilotBillOptions {
  enterpriseSlug: string
  /** manage_billing PAT for the enterprise. */
  credential: string
  /** Run clock; the bill rows are dated the 1st of this month (D1/M2). */
  now: Date
  /** ADR-0010 D1: whole-month flat per-seat price (provider_enterprise config). NULL → no flat row. */
  flatSeatPriceUsd: number | null
  /** Test seam: stub the seat list (no live GitHub call). */
  clientOverride?: Pick<GithubCopilotClient, 'listSeats'>
}

export interface CopilotBillResult {
  seatsTotal: number
  seatsResolved: number
  /** Seats whose login isn't bound to a teammate yet (identity-sync provisions them next run). */
  seatsCarriedUnmapped: number
  flatRowsWritten: number
  /** Always 0 — the per-user overage charge (WRONG model #1) was removed; the pooled overage
   *  is copilot_pool_bill.overage_net_usd. Kept for result-shape stability. */
  overageRowsWritten: number
}

function monthStartIso(now: Date): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/* login (lowercased) → teammateId for this enterprise, from the directory-seeded identity
 * map (github-identity.ts is the writer). Same read the reconciliation adapter uses.
 *
 * TWO LANES, enterprise-lane authoritative (identity-tail layer 2): reads BOTH the
 * directory-sync/admin enterprise lane (enterprise_slug = the slug) AND the self-service lane
 * (enterprise_slug IS NULL, source='self'), so a seat-holder who self-linked their github login
 * also has their flat-seat showback attributed. When both lanes hold the SAME login the
 * ENTERPRISE lane wins (DISTINCT ON + `(enterprise_slug IS NULL) ASC`) — a self-link only ever
 * ADDS a login, never overrides the authoritative binding. Mirrors resolveGithubRoster in
 * server/reconciliation/adapters/github.ts (kept in lock-step — both feed Copilot attribution).
 * §A/§B CAVEAT: the self lane is estate-global + unverified — deliberate for §A showback, but
 * reconfirm before F2 makes Copilot §B chargeable (see resolveGithubRoster's fuller note). */
async function resolveRoster(db: Db, enterpriseSlug: string): Promise<Map<string, string>> {
  const rows = await db.execute<{ login: string; teammate_id: string }>(sql`
    SELECT DISTINCT ON (lower(identifier))
           lower(identifier) AS login, teammate_id::text AS teammate_id
    FROM teammate_identity_map
    WHERE system = 'github'
      AND (lower(enterprise_slug) = lower(${enterpriseSlug}) OR enterprise_slug IS NULL)
    ORDER BY lower(identifier), (enterprise_slug IS NULL) ASC
  `)
  const map = new Map<string, string>()
  for (const r of rows) map.set(r.login, r.teammate_id)
  return map
}

/* Idempotent actual_spend upsert for a Copilot flat-seat showback row. Carries category +
 * chargeback_exempt (ADR-0010). Tokens are 0 — a flat license is a USD figure, not tokens. */
async function upsertCopilotBillRow(
  db: Db,
  row: {
    teammateId: string
    date: string
    source: string
    category: string
    costUsd: number
    chargebackExempt: boolean
    raw: unknown
  },
): Promise<boolean> {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, category, chargeback_exempt, raw_payload)
    VALUES
      (${row.teammateId}::uuid, ${row.date}::date, 'copilot-cli', 0::bigint, 0::bigint,
       ${row.costUsd.toFixed(6)}::numeric, ${row.source}, ${row.category}, ${row.chargebackExempt},
       ${JSON.stringify(row.raw)}::jsonb)
    ON CONFLICT (teammate_id, date, tool, source)
    DO UPDATE SET
      cost_usd = EXCLUDED.cost_usd,
      category = EXCLUDED.category,
      chargeback_exempt = EXCLUDED.chargeback_exempt,
      raw_payload = EXCLUDED.raw_payload,
      pulled_at = NOW()
    RETURNING id::text AS id
  `)
  return result.length > 0
}

export async function runCopilotBillWriter(db: Db, opts: CopilotBillOptions): Promise<CopilotBillResult> {
  const result: CopilotBillResult = {
    seatsTotal: 0,
    seatsResolved: 0,
    seatsCarriedUnmapped: 0,
    flatRowsWritten: 0,
    overageRowsWritten: 0,
  }

  const monthStart = monthStartIso(opts.now)

  const client = opts.clientOverride ?? GithubCopilotClient.withPat(opts.enterpriseSlug, opts.credential)
  const [seats, roster] = await Promise.all([client.listSeats(), resolveRoster(db, opts.enterpriseSlug)])

  const exemptConfigured = chargebackExemptOrgSet()

  for (const seat of seats as GithubSeat[]) {
    result.seatsTotal += 1
    const login = seat.assignee.login
    const teammateId = roster.get(login.toLowerCase())
    if (!teammateId) {
      // Unmapped: identity-sync (with bill-driven provisioning) binds the login next run,
      // then this writer attributes the seat. Counted, not silently dropped.
      result.seatsCarriedUnmapped += 1
      continue
    }
    result.seatsResolved += 1

    const licenseOrg = seatLicenseOrg(seat)
    const orgKey = licenseOrg?.toLowerCase() ?? 'unknown'
    const chargebackExempt = isChargebackExemptOrg(licenseOrg, exemptConfigured)

    // Flat seat (D1: whole-month, no proration) — PER SEAT, SHOWBACK/DISPLAY-ONLY. One row per
    // (teammate, org). NOT a chargeback figure (the pooled §B charge is copilot_pool_bill).
    if (opts.flatSeatPriceUsd != null) {
      const wrote = await upsertCopilotBillRow(db, {
        teammateId,
        date: monthStart,
        source: `copilot-seat:${orgKey}`,
        category: 'seat-license',
        costUsd: opts.flatSeatPriceUsd,
        chargebackExempt,
        raw: { kind: 'flat-seat', login, licenseOrg, month: monthStart, priceUsd: opts.flatSeatPriceUsd, showbackOnly: true },
      })
      if (wrote) result.flatRowsWritten += 1
    }
  }

  return result
}
