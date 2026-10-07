/*
 * client_connection_setting (mig 0151) — the admin "Client connection" policy
 * read by the connect dialog (#415).
 *
 * CONTRACT: an ABSENT row means DEFAULT_CLIENT_CONNECTION, which is what the
 * dialog showed before the table existed. So an un-configured deployment is
 * unchanged, and a dropped table degrades to the defaults rather than an error.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import {
  CONNECT_CLIENTS,
  DEFAULT_CLIENT_CONNECTION,
  type ClientConnectionPolicy,
  type ConnectClient,
} from '../../shared/connect'

type AnyDb = PostgresJsDatabase<typeof schema> | PostgresJsDatabase<Record<string, unknown>>

export interface ClientConnectionRow extends ClientConnectionPolicy {
  updatedBy: string | null
  updatedAt: string | null
}

type Raw = {
  marketplace_source: string
  marketplace_ref: string | null
  marketplace_name: string
  claude_plugin: string
  copilot_plugin: string
  enabled_clients: string[]
  support_url: string | null
  updated_by: string | null
  updated_at: string | null
}

function fromRaw(r: Raw): ClientConnectionRow {
  return {
    marketplaceSource: r.marketplace_source,
    marketplaceRef: r.marketplace_ref,
    marketplaceName: r.marketplace_name,
    claudePlugin: r.claude_plugin,
    copilotPlugin: r.copilot_plugin,
    enabledClients: CONNECT_CLIENTS.filter((c): c is ConnectClient => r.enabled_clients.includes(c)),
    supportUrl: r.support_url,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  }
}

/** The stored row, or null when none has been saved. */
export async function getClientConnectionRow(db: AnyDb): Promise<ClientConnectionRow | null> {
  const rows = await db.execute<Raw>(sql`
    SELECT marketplace_source, marketplace_ref, marketplace_name, claude_plugin, copilot_plugin,
           enabled_clients, support_url, updated_by::text AS updated_by, updated_at::text AS updated_at
      FROM client_connection_setting
     WHERE key = 'policy'
  `)
  const row = [...rows][0]
  return row ? fromRaw(row) : null
}

/** The effective policy: the stored row, else the defaults. */
export async function getClientConnectionPolicy(db: AnyDb): Promise<ClientConnectionPolicy> {
  const row = await getClientConnectionRow(db)
  if (!row) return { ...DEFAULT_CLIENT_CONNECTION, enabledClients: [...DEFAULT_CLIENT_CONNECTION.enabledClients] }
  return {
    marketplaceSource: row.marketplaceSource,
    marketplaceRef: row.marketplaceRef,
    marketplaceName: row.marketplaceName,
    claudePlugin: row.claudePlugin,
    copilotPlugin: row.copilotPlugin,
    enabledClients: row.enabledClients,
    supportUrl: row.supportUrl,
  }
}

/**
 * Serialise policy writers for the rest of the transaction. SHARE ROW EXCLUSIVE
 * conflicts with itself and with every writer's ROW EXCLUSIVE, and not with
 * plain reads, so the connect dialog keeps reading while a second save waits.
 * A TABLE lock, not a row lock: the first save has no row to lock.
 */
export async function lockClientConnectionPolicy(db: AnyDb): Promise<void> {
  await db.execute(sql`LOCK TABLE client_connection_setting IN SHARE ROW EXCLUSIVE MODE`)
}

export async function upsertClientConnectionPolicy(
  db: AnyDb,
  p: ClientConnectionPolicy,
  updatedBy: string,
): Promise<ClientConnectionRow> {
  const clients = `{${p.enabledClients.join(',')}}`
  const rows = await db.execute<Raw>(sql`
    INSERT INTO client_connection_setting
      (key, marketplace_source, marketplace_ref, marketplace_name, claude_plugin, copilot_plugin,
       enabled_clients, support_url, updated_by, updated_at)
    VALUES
      ('policy', ${p.marketplaceSource}, ${p.marketplaceRef}, ${p.marketplaceName}, ${p.claudePlugin},
       ${p.copilotPlugin}, ${clients}::text[], ${p.supportUrl}, ${updatedBy}::uuid, NOW())
    ON CONFLICT (key) DO UPDATE SET
      marketplace_source = EXCLUDED.marketplace_source,
      marketplace_ref    = EXCLUDED.marketplace_ref,
      marketplace_name   = EXCLUDED.marketplace_name,
      claude_plugin      = EXCLUDED.claude_plugin,
      copilot_plugin     = EXCLUDED.copilot_plugin,
      enabled_clients    = EXCLUDED.enabled_clients,
      support_url        = EXCLUDED.support_url,
      updated_by         = EXCLUDED.updated_by,
      updated_at         = EXCLUDED.updated_at
    RETURNING marketplace_source, marketplace_ref, marketplace_name, claude_plugin, copilot_plugin,
              enabled_clients, support_url, updated_by::text AS updated_by, updated_at::text AS updated_at
  `)
  return fromRaw([...rows][0]!)
}

/** The policy in the admin routes' snake_case wire shape. */
export function toWire(p: ClientConnectionPolicy) {
  return {
    marketplace_source: p.marketplaceSource,
    marketplace_ref: p.marketplaceRef,
    marketplace_name: p.marketplaceName,
    claude_plugin: p.claudePlugin,
    copilot_plugin: p.copilotPlugin,
    enabled_clients: [...p.enabledClients],
    support_url: p.supportUrl,
  }
}
