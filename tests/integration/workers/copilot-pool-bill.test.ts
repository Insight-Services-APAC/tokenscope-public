// @vitest-environment node
/*
 * Intent: reporting-consolidation build-design §7 Wave-0 correctness invariants for the POOLED
 * Copilot chargeback (docs/design/provider-billing-attribution-model.md §B). Executable against
 * real Postgres (testcontainers). Covers:
 *
 *  (1) Σ v_finance_chargeback_month (incl. NULL-CoU + unallocated residual) = Σ
 *      v_finance_bill_totals_month, with the Copilot term sourced SOLELY from copilot_pool_bill
 *      and copilot ABSENT from every actual_spend-rooted chargeback operand.
 *  (2) Exempt org in the bill report → ZERO copilot_pool_bill rows, yet non-zero indicative
 *      usage-lane rows (v_teammate_usage_daily copilot branch).
 *  (3) Missing SKU line → no license row (NULL) + alert emitted + month reports unsettled +
 *      flat_seat_price_usd never feeds a chargeback figure (grep + seeded).
 *  (4) Bill-read fidelity: worker license/overage/included EXACTLY equal the seeded report's
 *      net/net/discount under a MID-MONTH SEAT-CHANGE fixture (the recomputation-divergence case).
 *  (5) source='copilot-overage' rows deleted; v_teammate_usage_daily unaffected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import {
  runCopilotPoolBill,
  aggregateOrgBill,
  type BillingReportClient,
} from '../../../server/workers/copilot-pool-bill'
import { BillingUsageReportSchema } from '../../../server/reconciliation/adapters/github-client'
import type { GithubBillingUsageItem, GithubBillingUsageReport } from '../../../server/reconciliation/adapters/github-client'

let t: TestDb
let regionId = ''
let couA = ''
let couB = ''
let entId = ''
let orgAcme = ''
let orgGamma = ''
const ENT = 'ts-pool-ent'
const NOW = new Date('2026-06-15T09:00:00.000Z')
const MONTH = '2026-06-01'

/* Build one billing-report usage item (the enhanced-billing shape). */
function item(
  org: string | null,
  sku: string,
  opts: { gross?: number; discount?: number; net?: number; quantity?: number },
): GithubBillingUsageItem {
  return {
    date: '2026-06-10',
    product: 'Copilot',
    sku,
    quantity: opts.quantity ?? 0,
    unitType: '',
    pricePerUnit: 0,
    grossAmount: opts.gross ?? 0,
    discountAmount: opts.discount ?? 0,
    netAmount: opts.net ?? 0,
    organizationName: org,
    repositoryName: null,
  }
}
const LICENSE = 'Copilot Enterprise'
const CREDITS = 'Copilot AI Credits'

/** A stub billing client returning a fixed report regardless of (year, month). */
function stub(report: GithubBillingUsageReport): BillingReportClient {
  return { getEnterpriseBillingUsage: async () => report }
}

async function mkCou(code: string, path: string): Promise<string> {
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path, code, displayName: code, unitType: 'bu', isCostOwningUnit: true })
    .returning({ id: schema.orgUnit.id })
  return ou!.id
}

async function mkOrg(externalOrgId: string, couId: string | null, displayName?: string): Promise<string> {
  const [po] = await t.db
    .insert(schema.providerOrg)
    .values({
      provider: 'github',
      externalOrgId,
      displayName: displayName ?? externalOrgId,
      reconciliationMode: 'reconciled',
      providerEnterpriseId: entId,
      costOwningUnitId: couId,
    })
    .returning({ id: schema.providerOrg.id })
  return po!.id
}

async function mkTeammate(orgUnitId: string, role = 'developer'): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-pb-${randomUUID().slice(0, 8)}`,
      email: `pb.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId,
      role,
    })
    .returning({ id: schema.teammate.id })
  return tm!.id
}

async function sumChargebackMonth(): Promise<number> {
  const [r] = await t.client<{ s: string }[]>`
    SELECT COALESCE(SUM(charge_usd), 0)::text AS s FROM v_finance_chargeback_month WHERE period_month = ${MONTH}::date`
  return Number(r!.s)
}
async function sumBillTotals(): Promise<number> {
  const [r] = await t.client<{ s: string }[]>`
    SELECT COALESCE(SUM(bill_usd), 0)::text AS s FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date`
  return Number(r!.s)
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'pb', displayName: 'PB' }).returning()
  regionId = r!.id
  couA = await mkCou('pb-a', 'pba')
  couB = await mkCou('pb-b', 'pbb')
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId: ENT, displayName: ENT, reconciliationMode: 'reconciled' })
    .returning({ id: schema.providerEnterprise.id })
  entId = ent!.id
  orgAcme = await mkOrg('acme', couA)
  await mkOrg('beta', couB)
  await mkOrg('lonely', null) // registered but no CoU → visible unallocated
  await mkOrg('partner-demo', couA) // exempt-by-name → never written
  // Login 'gamma' but a DISTINCT display name — the MEDIUM-2 display-name-match fixture.
  orgGamma = await mkOrg('gamma', couB, 'Gamma Display')
  // A global-finops recipient so the unsettled alert has somewhere to route.
  await mkTeammate(couA, 'global-finops')
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM copilot_pool_bill`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM inbox_item`
  await t.client`DELETE FROM reconciliation_record`
})

describe('copilot-pool-bill Wave-0 invariants', () => {
  it('(1) Σ chargeback_month = Σ bill_totals_month; copilot solely from copilot_pool_bill; copilot absent from actual_spend chargeback', async () => {
    // Anthropic bill (chargeable) homed to couA + a per-seat COPILOT actual_spend row that must
    // NOT enter any chargeback operand.
    const tmA = await mkTeammate(couA)
    await t.db.insert(schema.actualSpend).values({ teammateId: tmA, date: '2026-06-10', tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '123.45', source: 'anthropic-analytics-api' })
    await t.db.insert(schema.actualSpend).values({ teammateId: tmA, date: '2026-06-01', tool: 'copilot-cli', inputTokens: 0n, outputTokens: 0n, costUsd: '39.00', source: 'copilot-seat:acme' })

    const report: GithubBillingUsageReport = {
      usageItems: [
        item('acme', LICENSE, { net: 4000, quantity: 100 }),
        item('acme', CREDITS, { gross: 5000, discount: 5000, net: 0 }), // pool covered → net 0
        item('beta', LICENSE, { net: 2000, quantity: 50 }),
        item('beta', CREDITS, { gross: 800, discount: 500, net: 300 }), // paid overage 300
        item('lonely', LICENSE, { net: 1000, quantity: 25 }),
        item('lonely', CREDITS, { gross: 200, discount: 100, net: 100 }),
        item('partner-demo', LICENSE, { net: 999, quantity: 30 }), // EXEMPT — never written
        item(null, CREDITS, { gross: 60, discount: 10, net: 50 }), // org-less → residual
      ],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgRowsWritten).toBe(3) // acme, beta, lonely (partner-demo skipped)
    expect(res.residualRowsWritten).toBe(1)
    expect(res.orgsExemptSkipped).toBe(1)

    // partner-demo (exempt) is NOT in copilot_pool_bill.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM copilot_pool_bill cpb
      JOIN provider_org po ON po.id = cpb.provider_org_id
      WHERE po.external_org_id = 'partner-demo'`
    expect(Number(n)).toBe(0)

    // Copilot chargeback term = pool net only: 4000 + 2300 + 1100(lonely) + 50(residual) = 7450.
    const [{ c }] = await t.client<{ c: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS c FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date AND tool = 'copilot-cli'`
    expect(Number(c)).toBe(7450) // NOT 7450 + 39 (the copilot-seat actual_spend row is excluded)

    // NULL-CoU bucket (unmapped 'lonely' 1100 + residual 50) is present + visible.
    const [{ nullcou }] = await t.client<{ nullcou: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS nullcou FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date AND cost_owning_unit_id IS NULL`
    expect(Number(nullcou)).toBe(1150)

    // The bill_totals Copilot term comes ONLY from copilot_pool_bill.
    const [{ gh }] = await t.client<{ gh: string }[]>`
      SELECT bill_usd::text AS gh FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date AND provider = 'github'`
    expect(Number(gh)).toBe(7450)

    // THE INVARIANT: Σ chargeback_month == Σ bill_totals_month (= 123.45 anthropic + 7450 copilot).
    const cb = await sumChargebackMonth()
    const bt = await sumBillTotals()
    expect(cb).toBeCloseTo(7573.45, 4)
    expect(bt).toBeCloseTo(7573.45, 4)
    expect(cb).toBeCloseTo(bt, 6)

    // Copilot is ABSENT from the actual_spend-rooted chargeback lane (the copilot-seat row).
    const [{ copcb }] = await t.client<{ copcb: string }[]>`
      SELECT COALESCE(SUM(bill_usd),0)::text AS copcb FROM v_finance_bill_chargeback WHERE tool = 'copilot-cli'`
    expect(Number(copcb)).toBe(0)
  })

  it('(2) exempt org in the report → ZERO copilot_pool_bill rows, yet non-zero indicative usage-lane rows', async () => {
    // A teammate seated in the exempt org, with per-user gross usage in reconciliation_record.
    const tmD = await mkTeammate(couA)
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId: tmD, provider: 'github', enterpriseRef: ENT, licenseOrg: 'partner-demo',
      periodDate: '2026-06-10', category: 'copilot_interactive', scope: 'teammate',
      actualUsd: '50', otelAttributedUsd: '0', deltaUsd: '50', spendClass: 'indicative',
      disposition: 'under', status: 'proposed',
    })
    const report: GithubBillingUsageReport = {
      usageItems: [item('partner-demo', LICENSE, { net: 999, quantity: 30 }), item('partner-demo', CREDITS, { gross: 60, net: 0, discount: 60 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgsExemptSkipped).toBe(1)
    expect(res.orgRowsWritten).toBe(0)
    expect(res.residualRowsWritten).toBe(0)

    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM copilot_pool_bill`
    expect(Number(n)).toBe(0) // exempt org: never written

    // But the usage lane DOES surface the exempt org's usage (indicative), never $0-hidden.
    const [{ usd }] = await t.client<{ usd: string }[]>`
      SELECT COALESCE(SUM(usage_usd),0)::text AS usd FROM v_teammate_usage_daily
      WHERE teammate_id = ${tmD}::uuid AND tool = 'copilot-cli'`
    expect(Number(usd)).toBe(50)
  })

  it('(3) missing SKU line → NULL license, alert emitted, month unsettled, flat rate never charged', async () => {
    // Configure a flat seat price on the enterprise — it must NEVER become a chargeback figure.
    await t.client`UPDATE provider_enterprise SET flat_seat_price_usd = 39 WHERE external_id = ${ENT}`
    const report: GithubBillingUsageReport = {
      // acme has usage/overage but NO "Copilot Enterprise" license line.
      usageItems: [item('acme', CREDITS, { gross: 500, discount: 200, net: 300 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.unsettledOrgMonths).toBe(1)
    expect(res.alertsEmitted).toBe(1)

    const [row] = await t.client<{ license: string | null; overage: string; gross: string }[]>`
      SELECT license_net_usd::text AS license, overage_net_usd::text AS overage, usage_gross_usd::text AS gross
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(row!.license).toBeNull() // NO license row (never a flat-rate fallback)
    expect(Number(row!.overage)).toBe(300)

    // An alert was raised.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item WHERE category = 'copilot-bill-unsettled'`
    expect(Number(n)).toBe(1)

    // The month reports UNSETTLED on the bill-totals check.
    const [{ unsettled }] = await t.client<{ unsettled: boolean }[]>`
      SELECT unsettled FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date AND provider = 'github'`
    expect(unsettled).toBe(true)

    // The chargeback figure for acme's CoU is the OVERAGE ONLY (300) — NOT 39 (flat) or 339.
    const [{ charge }] = await t.client<{ charge: string }[]>`
      SELECT charge_usd::text AS charge FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date AND tool = 'copilot-cli' AND cost_owning_unit_id = ${couA}::uuid`
    expect(Number(charge)).toBe(300)

    // reset the flat price so it can't leak into other tests
    await t.client`UPDATE provider_enterprise SET flat_seat_price_usd = NULL WHERE external_id = ${ENT}`
  })

  it('(3b) flat_seat_price_usd never appears in the pooled chargeback surfaces (grep)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const worker = readFileSync(join(here, '../../../server/workers/copilot-pool-bill.ts'), 'utf8')
    const mig = readFileSync(join(here, '../../../drizzle/migrations/0081_finance_copilot_pool_chargeback_views.sql'), 'utf8')
    expect(worker).not.toContain('flat_seat_price')
    expect(worker).not.toContain('flatSeatPrice')
    expect(mig).not.toContain('flat_seat_price')
  })

  it('(4) bill-read fidelity under a mid-month seat change: license/overage/included EXACTLY equal the bill net/net/discount', async () => {
    // A mid-month seat change → TWO subscription lines (50 seats then 60 seats), plus split
    // AI-credit lines. A seats×rate recompute (e.g. 60×39=2340) would DIVERGE from the bill.
    const midMonthItems: GithubBillingUsageItem[] = [
      item('acme', LICENSE, { net: 2000, quantity: 50 }),
      item('acme', LICENSE, { net: 2400, quantity: 60 }),
      item('acme', CREDITS, { gross: 700, discount: 400, net: 150 }),
      item('acme', CREDITS, { gross: 300, discount: 100, net: 150 }),
    ]
    // Pure aggregation (the recomputation-divergence unit case).
    const agg = aggregateOrgBill(midMonthItems)
    expect(agg.licenseNetUsd).toBe(4400) // 2000 + 2400 EXACTLY (not seats×rate)
    expect(agg.overageNetUsd).toBe(300) // 150 + 150
    expect(agg.includedAllowanceUsd).toBe(500) // 400 + 100
    expect(agg.usageGrossUsd).toBe(1000) // 700 + 300
    expect(agg.seats).toBe(60) // max seat count across lines

    // End-to-end through the worker → the persisted row equals the bill exactly.
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub({ usageItems: midMonthItems }) })
    expect(res.orgRowsWritten).toBe(1)
    const [row] = await t.client<{ license: string; overage: string; included: string; gross: string; seats: number }[]>`
      SELECT license_net_usd::text AS license, overage_net_usd::text AS overage,
             included_allowance_usd::text AS included, usage_gross_usd::text AS gross, seats
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(Number(row!.license)).toBe(4400)
    expect(Number(row!.overage)).toBe(300)
    expect(Number(row!.included)).toBe(500)
    expect(Number(row!.gross)).toBe(1000)
    expect(row!.seats).toBe(60)
  })

  it('(5) source=copilot-overage rows are deleted; v_teammate_usage_daily is unaffected', async () => {
    const tm = await mkTeammate(couA)
    // A legacy forecast row (the kind mig 0081 purges) + the real per-user usage in the ledger.
    await t.db.insert(schema.actualSpend).values({ teammateId: tm, date: '2026-06-10', tool: 'copilot-cli', inputTokens: 0n, outputTokens: 0n, costUsd: '999.00', source: 'copilot-overage' })
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId: tm, provider: 'github', enterpriseRef: ENT, licenseOrg: 'acme',
      periodDate: '2026-06-10', category: 'copilot_interactive', scope: 'teammate',
      actualUsd: '42', otelAttributedUsd: '0', deltaUsd: '42', spendClass: 'indicative',
      disposition: 'under', status: 'proposed',
    })

    // The migration's delete statement (mig 0081): removes ONLY the forecast rows.
    await t.client`DELETE FROM actual_spend WHERE source = 'copilot-overage'`
    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM actual_spend WHERE source = 'copilot-overage'`
    expect(Number(n)).toBe(0)

    // The usage lane (sourced from reconciliation_record, not actual_spend) is unchanged.
    const [{ usd }] = await t.client<{ usd: string }[]>`
      SELECT COALESCE(SUM(usage_usd),0)::text AS usd FROM v_teammate_usage_daily
      WHERE teammate_id = ${tm}::uuid AND tool = 'copilot-cli'`
    expect(Number(usd)).toBe(42)
  })

  it('(6) MEDIUM-2: organizationName = the DISPLAY name (not the login) homes via display_name to the right CoU', async () => {
    // The live bill uses gamma's DISPLAY name ('Gamma Display'), not its login ('gamma').
    const report: GithubBillingUsageReport = {
      usageItems: [item('Gamma Display', LICENSE, { net: 500, quantity: 10 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    // Matched via display_name → its OWN org row (couB), NOT folded to residual, no mismatch alert.
    expect(res.orgRowsWritten).toBe(1)
    expect(res.residualRowsWritten).toBe(0)
    expect(res.alertsEmitted).toBe(0)

    const [row] = await t.client<{ org: string; cou: string | null; license: string }[]>`
      SELECT provider_org_id::text AS org, cost_owning_unit_id::text AS cou, license_net_usd::text AS license
      FROM copilot_pool_bill`
    expect(row!.org).toBe(orgGamma) // homed to gamma via display_name
    expect(row!.cou).toBe(couB)
    expect(Number(row!.license)).toBe(500)

    // No org-name-mismatch alert (an org DID match).
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item WHERE category = 'copilot-bill-unsettled' AND body->>'kind' = 'org-name-mismatch'`
    expect(Number(n)).toBe(0)
  })

  it('(7) MEDIUM-2: registered orgs exist but NO bill org matches any → loud org-name-mismatch alert (not a silent all-residual)', async () => {
    // A bill org that matches NO registered login OR display name → folds to residual.
    const report: GithubBillingUsageReport = {
      usageItems: [item('Totally Unknown Org', LICENSE, { net: 100, quantity: 5 })],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgRowsWritten).toBe(0)
    expect(res.residualRowsWritten).toBe(1) // folded to the visible residual (never dropped)
    expect(res.alertsEmitted).toBe(1) // the mismatch signal (residual is NOT unsettled here — has license)

    const [row] = await t.client<{ kind: string; registered: string }[]>`
      SELECT body->>'kind' AS kind, body->>'registeredOrgCount' AS registered
      FROM inbox_item WHERE category = 'copilot-bill-unsettled' AND body->>'kind' = 'org-name-mismatch'`
    expect(row!.kind).toBe('org-name-mismatch')
    expect(Number(row!.registered)).toBeGreaterThan(0)
  })

  it('(8) MEDIUM-1a: an ABSENT net money field THROWS at parse → the month is isolated, not a silent $0', async () => {
    // A bill line with NO netAmount (the field renamed/dropped by an unverified-live report).
    const raw = { usageItems: [{ product: 'Copilot', sku: LICENSE, grossAmount: 4000, quantity: 100, organizationName: 'acme' }] }
    // (a) the schema fails LOUD rather than coercing the missing net to a $0.
    expect(() => BillingUsageReportSchema.parse(raw)).toThrow()
    // (b) end-to-end: the real client parses via the same schema, so the worker's per-(enterprise,
    //     month) try/catch isolates the month — no copilot_pool_bill row is written.
    const parsingClient: BillingReportClient = { getEnterpriseBillingUsage: async () => BillingUsageReportSchema.parse(raw) }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: parsingClient })
    expect(res.enterprisesErrored).toBe(1)
    expect(res.monthsProcessed).toBe(0)
    expect(res.orgRowsWritten).toBe(0)
    const [{ n }] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM copilot_pool_bill`
    expect(Number(n)).toBe(0) // NOT a silent $0 row
  })

  it('(9) MEDIUM-1b: usage present but ALL money reads $0 → sentinel forces unsettled + alert, not a confident $0', async () => {
    const report: GithubBillingUsageReport = {
      usageItems: [
        item('acme', LICENSE, { net: 0, quantity: 100 }), // license line PRESENT but $0 (shape drift)
        item('acme', CREDITS, { gross: 5000, discount: 5000, net: 0 }), // real usage, net reads 0
      ],
    }
    const res = await runCopilotPoolBill(t.db, { now: NOW, monthsBack: 0, clientOverride: stub(report) })
    expect(res.orgRowsWritten).toBe(1)
    expect(res.unsettledOrgMonths).toBe(1)
    expect(res.alertsEmitted).toBe(1)

    // The sentinel forced license to NULL (unsettled), NOT a confident $0.
    const [row] = await t.client<{ license: string | null; gross: string; overage: string }[]>`
      SELECT license_net_usd::text AS license, usage_gross_usd::text AS gross, overage_net_usd::text AS overage
      FROM copilot_pool_bill WHERE provider_org_id = ${orgAcme}::uuid`
    expect(row!.license).toBeNull()
    expect(Number(row!.gross)).toBe(5000)
    expect(Number(row!.overage)).toBe(0)

    // The month reports UNSETTLED on the Σ=bill view (license NULL + usage present).
    const [{ unsettled }] = await t.client<{ unsettled: boolean }[]>`
      SELECT unsettled FROM v_finance_bill_totals_month WHERE period_month = ${MONTH}::date AND provider = 'github'`
    expect(unsettled).toBe(true)

    // An inbox alert was raised.
    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM inbox_item WHERE category = 'copilot-bill-unsettled'`
    expect(Number(n)).toBe(1)

    // The chargeback for acme's CoU is $0 — but flagged unsettled, NOT a confident settled $0.
    const [{ charge }] = await t.client<{ charge: string }[]>`
      SELECT COALESCE(SUM(charge_usd),0)::text AS charge FROM v_finance_chargeback_month
      WHERE period_month = ${MONTH}::date AND tool = 'copilot-cli' AND cost_owning_unit_id = ${couA}::uuid`
    expect(Number(charge)).toBe(0)
  })
})
