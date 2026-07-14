/*
 * reconciliation-sync worker — the hourly driver. Iterates every RECONCILED
 * credential-scope (Anthropic per-org, GitHub per-enterprise), instantiates that
 * provider's adapter (if registered), pulls normalised lines for [yesterday, today]
 * (idempotent re-pull), and runs the platform-agnostic engine.
 *
 * Phase 0: ADAPTER_FACTORIES is empty, so this is a clean no-op (scopesRun: 0) —
 * exactly like analytics-poll with zero reconciled orgs. It begins reconciling the
 * moment Stream A / Stream B registers a factory. See docs/design/reconciliation-engine.md.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { runReconcileEngine } from '../reconciliation/engine'
import { ADAPTER_FACTORIES } from '../reconciliation/adapters/registry'
import { resolveOrgCredential, resolveEnterpriseCredential } from '../reconciliation/credentials'
import { runCopilotBillWriter } from './copilot-bill'
import {
  GOV_RECONCILIATION_EPSILON_USD,
  GOV_RECONCILIATION_LAG_BUFFER_HOURS,
  resolveGovernanceSettings,
} from '../utils/governance-settings'

type Db = PostgresJsDatabase<typeof schema>

export interface ReconcileSyncResult {
  scopesConsidered: number
  scopesRun: number
  scopesSkippedNoAdapter: number
  scopesSkippedNoCredential: number
  /** Scopes whose adapter pull / engine run threw — isolated so one bad scope
   * does not starve the rest of the run (re-attempted next tick). */
  scopesErrored: number
  /** Named so worker_run.rows_affected (extractRowsAffected) captures it. */
  rowsWritten: number
  // ADR-0010: Copilot flat-seat + overage rows written to actual_spend this run.
  copilotFlatRows: number
  copilotOverageRows: number
  copilotSeatsCarriedUnmapped: number
  // Engine aggregates summed across scopes — persisted to worker_run.result so the
  // run drill-down shows what reconciled vs didn't, and deriveRunWarnings surfaces the
  // skips (keys named to match run-warnings.ts).
  over: number
  under: number
  matched: number
  skippedInvalid: number
  skippedUnresolved: number
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function runReconciliationSync(
  db: Db,
  opts?: { now?: Date; runId?: string | null },
): Promise<ReconcileSyncResult> {
  const now = opts?.now ?? new Date()
  const runId = opts?.runId ?? null // stamped onto reconciliation_record.run_id by the engine
  const endDate = utcDay(now)
  const y = new Date(now)
  y.setUTCDate(y.getUTCDate() - 1)
  const startDate = utcDay(y) // re-pull yesterday + today; the engine upsert is idempotent

  // Engine dials (mig 0049; platform defaults 0.01 USD / 48h), resolved once
  // per run and injected as options — the engine itself stays pure/injectable.
  const dials = await resolveGovernanceSettings(db, [
    GOV_RECONCILIATION_EPSILON_USD,
    GOV_RECONCILIATION_LAG_BUFFER_HOURS,
  ])
  const epsilonUsd = dials[GOV_RECONCILIATION_EPSILON_USD]
  const lagBufferHours = dials[GOV_RECONCILIATION_LAG_BUFFER_HOURS]

  const result: ReconcileSyncResult = {
    scopesConsidered: 0,
    scopesRun: 0,
    scopesSkippedNoAdapter: 0,
    scopesSkippedNoCredential: 0,
    scopesErrored: 0,
    rowsWritten: 0,
    copilotFlatRows: 0,
    copilotOverageRows: 0,
    copilotSeatsCarriedUnmapped: 0,
    over: 0,
    under: 0,
    matched: 0,
    skippedInvalid: 0,
    skippedUnresolved: 0,
  }

  // Anthropic — credential grain is the org.
  const orgs = await db.execute<{ external_org_id: string }>(sql`
    SELECT external_org_id FROM provider_org
    WHERE provider = 'anthropic' AND reconciliation_mode = 'reconciled'
    ORDER BY external_org_id
  `)
  for (const o of orgs) {
    result.scopesConsidered += 1
    const factory = ADAPTER_FACTORIES.anthropic
    if (!factory) {
      result.scopesSkippedNoAdapter += 1
      continue
    }
    const credential = await resolveOrgCredential(db, {
      provider: 'anthropic',
      externalOrgId: o.external_org_id,
    })
    if (!credential) {
      result.scopesSkippedNoCredential += 1
      continue
    }
    try {
      // Thread the org's api_kind (mig 0063) onto the scope so the anthropic
      // adapter branches Enterprise-Analytics vs claude-code-admin. resolveOrgCredential
      // read it off provider_org alongside the credential.
      const adapter = factory(db, {
        externalRef: o.external_org_id,
        credential,
        apiKind: credential.apiKind ?? null,
      })
      const lines = await adapter.pull({ startDate, endDate })
      const r = await runReconcileEngine(db, lines, { now, runId, epsilonUsd, lagBufferHours })
      result.rowsWritten += r.recordsWritten
      result.over += r.over
      result.under += r.under
      result.matched += r.matched
      result.skippedInvalid += r.skippedInvalid
      result.skippedUnresolved += r.skippedUnresolved
      result.scopesRun += 1
    } catch (err) {
      // Isolate one bad scope so it cannot starve the rest of the run (the hourly
      // re-pull retries it next tick); surface it so a persistently-failing scope
      // is visible in logs, not a silent green run.
      result.scopesErrored += 1
      console.warn(`[reconciliation-sync] anthropic scope ${o.external_org_id} failed: ${String(err)}`)
    }
  }

  // GitHub — credential grain is the enterprise (one PAT reads all child orgs).
  // flat_seat_price_usd / included_allowance_usd (ADR-0010 D1/D2) drive the bill writer.
  const ents = await db.execute<{
    external_id: string
    flat_seat_price_usd: string | null
    included_allowance_usd: string | null
  }>(sql`
    SELECT external_id, flat_seat_price_usd, included_allowance_usd FROM provider_enterprise
    WHERE provider = 'github' AND reconciliation_mode = 'reconciled'
    ORDER BY external_id
  `)
  for (const e of ents) {
    result.scopesConsidered += 1
    const factory = ADAPTER_FACTORIES.github
    if (!factory) {
      result.scopesSkippedNoAdapter += 1
      continue
    }
    const credential = await resolveEnterpriseCredential(db, {
      provider: 'github',
      externalId: e.external_id,
    })
    if (!credential) {
      result.scopesSkippedNoCredential += 1
      continue
    }
    try {
      const adapter = factory(db, { externalRef: e.external_id, credential })
      const lines = await adapter.pull({ startDate, endDate })
      const r = await runReconcileEngine(db, lines, { now, runId, epsilonUsd, lagBufferHours })
      result.rowsWritten += r.recordsWritten
      result.over += r.over
      result.under += r.under
      result.matched += r.matched
      result.skippedInvalid += r.skippedInvalid
      result.skippedUnresolved += r.skippedUnresolved
      result.scopesRun += 1

      // ADR-0010 / reporting-consolidation Wave 0: the flat per-seat SHOWBACK rows in
      // actual_spend (display-only; the pooled §B chargeback is copilot_pool_bill, written by
      // the copilot-pool-bill worker). Own try/catch — a bill-writer hiccup must not undo the
      // reconciliation that already committed. Runs every tick; rows are dated the 1st and
      // upserted, so re-runs refresh idempotently. (The per-user overage charge was removed —
      // WRONG model #1; overageRowsWritten is always 0.)
      try {
        const bill = await runCopilotBillWriter(db, {
          enterpriseSlug: e.external_id,
          credential: credential.value,
          now,
          flatSeatPriceUsd: e.flat_seat_price_usd != null ? Number(e.flat_seat_price_usd) : null,
        })
        result.rowsWritten += bill.flatRowsWritten + bill.overageRowsWritten
        result.copilotFlatRows += bill.flatRowsWritten
        result.copilotOverageRows += bill.overageRowsWritten
        result.copilotSeatsCarriedUnmapped += bill.seatsCarriedUnmapped
      } catch (err) {
        console.warn(`[reconciliation-sync] copilot bill writer ${e.external_id} failed: ${String(err)}`)
      }
    } catch (err) {
      result.scopesErrored += 1
      console.warn(`[reconciliation-sync] github scope ${e.external_id} failed: ${String(err)}`)
    }
  }

  return result
}
