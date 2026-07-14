/*
 * Emit-provisioning orchestration (MCP client backbone — provision_emit + redeem).
 *
 * Two-step, secret-isolating device provisioning (docs/design/mcp-client-backbone.md
 * §"One auth → also provisions the device, WITHOUT a durable secret in the LLM"):
 *
 *   1. provision_emit (read-scoped MCP tool) → locateOrCreateInstance + mintEmitHandoff.
 *      Returns ONLY a short-TTL one-time HANDOFF code + redeem URL. The durable
 *      emit refresh token is NEVER minted here, so it can never enter the LLM's
 *      context (the broadly-readable emit credential is the most widely-exposed
 *      secret in the system — it must not transit the agent).
 *   2. redeem (direct process→server call, NOT MCP) → consumeEmitHandoff +
 *      issueEmitCredential. Returns the durable credential + the OTel bundle.
 *
 * Secrets discipline mirrors setup_token / oauth_auth_code: the handoff code is a
 * 32-byte random value; only its HMAC-SHA-256 hash is stored; single-use is an
 * atomic compare-and-swap on consumed_at (like consumeAuthCode), so a replayed or
 * concurrent redeem sees at most one success.
 *
 * The instance_attestation this creates is derived from the BEARER TEAMMATE (the
 * authenticated read identity), NOT a setup token — the teammate binding is the
 * unspoofable join key attribution requires. It is minted 'unassigned' (no
 * project): the device emits untagged and is tagged per-repo/per-session later.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken } from './hmac'
import { REFRESH_TOKEN_TTL_MS } from './oauth'
import { currentServerDeployEnv } from '../../shared/env/deploy-env'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** Handoff TTL: ~5 min, single-use (docs §"short-TTL (~5 min) handoff code"). */
export const EMIT_HANDOFF_TTL_MS = 5 * 60 * 1000

/** The teammate identity provision_emit derives an attestation from (the bearer). */
export interface ProvisioningTeammate {
  teammateId: string
  principalOid: string
  email: string | null
  regionId: string
  orgUnitId: string
}

/**
 * Load the columns provision_emit needs to mint an attestation, straight from the
 * teammate row (the BearerTeammate carries region but not org_unit / entra_oid).
 * Returns null if the teammate vanished.
 */
export async function loadProvisioningTeammate(
  db: Db,
  teammateId: string,
): Promise<ProvisioningTeammate | null> {
  const rows = await db.execute<{
    entra_oid: string
    email: string | null
    region_id: string
    org_unit_id: string
  }>(sql`
    SELECT entra_oid, email, region_id::text AS region_id, org_unit_id::text AS org_unit_id
      FROM teammate WHERE id = ${teammateId}::uuid LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) return null
  return {
    teammateId,
    principalOid: row.entra_oid,
    email: row.email,
    regionId: row.region_id,
    orgUnitId: row.org_unit_id,
  }
}

/** The tool emitting telemetry. Determines which OTel bundle shape redeem returns. */
export type EmitTool = 'claude-code' | 'copilot-cli'

/**
 * Locate-or-create the instance_attestation for (teammate, instanceId).
 *
 * Idempotency (docs §F2.3): if `instanceId` is supplied AND a LIVE attestation
 * (ts_actual_end IS NULL) for that id is owned by THIS teammate, reuse it — re-
 * provisioning the same device must NOT mint unbounded attestations. Otherwise
 * mint a fresh one (a supplied id NOT owned by this teammate is treated as absent:
 * we never adopt another teammate's instance, and we never leak that it exists).
 *
 * CROSS-ENVIRONMENT REUSE GUARD (mig 0060): an instance belongs to the deployment
 * environment that minted it (`deployment_env`, the NUXT_DEPLOY_ENV-classified
 * label). If a client re-provisions against a DIFFERENT deployment (Sandbox → Dev,
 * later Dev → Production) while still carrying the OLD environment's
 * tokenscope.instance_id, that id usually won't exist in the new DB at all and we'd
 * silently mint a duplicate. But if a row IS found and owned by this teammate yet
 * its stored deploy-env differs from this deployment's, we REJECT loudly (409)
 * rather than silently re-mint — a stale id pointed at the wrong environment is an
 * operator-visible error, not something to paper over. Legacy rows (deployment_env
 * NULL, pre-0060) are treated as same-env and back-filled on reuse.
 *
 * The attestation is 'unassigned' — provision_emit derives identity from the
 * bearer, which has no project. ts_expected_end tracks the durable emit
 * credential's life (90d) like setup/exchange (session-gc + /bearer gate on it).
 *
 * @param deployEnv this deployment's environment label, classified from
 *   NUXT_DEPLOY_ENV via the canonical currentServerDeployEnv() (the same resolver
 *   dev-login / admin-settings / obo use). Stable across a custom-domain cutover,
 *   unlike the public origin host (container-app.bicep:223: host is NOT the env
 *   signal, NUXT_DEPLOY_ENV is). Defaults to the running deployment's env — callers
 *   (e.g. tests) MAY override.
 * @returns the instance_id to mint the handoff against, and whether it was reused.
 */
export async function locateOrCreateInstance(
  db: Db,
  tm: ProvisioningTeammate,
  instanceId: string | undefined,
  tool: EmitTool = 'claude-code',
  deployEnv: string = currentServerDeployEnv(),
): Promise<{ instanceId: string; reused: boolean }> {
  const currentEnv = deployEnv?.trim() || null
  if (instanceId) {
    const existing = await db.execute<{ instance_id: string; deployment_env: string | null }>(sql`
      SELECT instance_id::text AS instance_id, deployment_env
        FROM instance_attestation
       WHERE instance_id = ${instanceId}::uuid
         AND teammate_id = ${tm.teammateId}::uuid
         AND ts_actual_end IS NULL
       LIMIT 1
    `)
    const row = [...existing][0]
    if (row) {
      const storedEnv = row.deployment_env?.trim() || null
      // Cross-env guard: a non-null stored deploy-env that differs from this
      // deployment means the id was minted elsewhere. Refuse — do NOT silently
      // mint a duplicate (the old silent fall-through). The message tells the
      // client exactly how to recover (omit instance_id to mint fresh).
      if (storedEnv !== null && currentEnv !== null && storedEnv !== currentEnv) {
        throw createError({
          statusCode: 409,
          statusMessage:
            'This device id belongs to a different TokenScope environment; omit instance_id to mint a fresh device for this environment.',
        })
      }
      // Legacy null-env row (pre-0060): treat as same-env and back-fill so a
      // subsequent re-provision is guarded too. Only stamps when we actually
      // know the current env.
      if (storedEnv === null && currentEnv !== null) {
        await db.execute(sql`
          UPDATE instance_attestation
             SET deployment_env = ${currentEnv}
           WHERE instance_id = ${row.instance_id}::uuid
             AND deployment_env IS NULL
        `)
      }
      return { instanceId: row.instance_id, reused: true }
    }
  }

  // Fresh device. Mint a new instance id (server-chosen, a real UUIDv4 — the
  // instance_id column is uuid and the client/redeem args validate .uuid()).
  // A supplied-but-unowned/ended id falls through to here — we DON'T reuse it.
  // Stamp deployment_env so a later re-provision against another environment
  // is detected (the cross-env guard above).
  const newId = randomUUID()
  const tsExpectedEnd = new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
  await db.execute(sql`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool,
       ts_expected_end, region_id, org_unit_id, attestation_state, deployment_env)
    VALUES (${newId}::uuid, ${tm.principalOid}, ${tm.email}, ${tm.teammateId}::uuid, ${tool},
            ${tsExpectedEnd.toISOString()}::timestamptz, ${tm.regionId}::uuid, ${tm.orgUnitId}::uuid,
            'unassigned', ${currentEnv})
  `)
  return { instanceId: newId, reused: false }
}

/**
 * Invalidate any UNCONSUMED, still-live handoffs for an instance (rotate). Called
 * before minting a fresh handoff so a re-provision can't leave multiple redeemable
 * codes outstanding for one device.
 */
export async function revokePriorHandoffsForInstance(db: Db, instanceId: string): Promise<void> {
  await db.execute(sql`
    UPDATE emit_handoff SET consumed_at = now()
     WHERE instance_id = ${instanceId}::uuid AND consumed_at IS NULL
  `)
}

export interface MintedHandoff {
  /** Raw handoff code — returned to the tool caller ONCE, never persisted. */
  code: string
  expiresAt: Date
}

/**
 * Mint a one-time, short-TTL handoff bound to (teammate, instance). Stores only
 * the HMAC hash; returns the raw code for the redeem helper.
 */
export async function mintEmitHandoff(
  db: Db,
  teammateId: string,
  instanceId: string,
): Promise<MintedHandoff> {
  const code = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + EMIT_HANDOFF_TTL_MS)
  await db.execute(sql`
    INSERT INTO emit_handoff (code_hash, teammate_id, instance_id, expires_at)
    VALUES (${hashSessionToken(code)}, ${teammateId}::uuid, ${instanceId}::uuid,
            ${expiresAt.toISOString()}::timestamptz)
  `)
  return { code, expiresAt }
}

export interface ConsumedHandoff {
  teammateId: string
  instanceId: string
}

/**
 * Consume a handoff atomically: mark it consumed iff it was unconsumed AND not
 * expired, returning its binding. A single-statement CAS (UPDATE ... WHERE
 * consumed_at IS NULL AND expires_at > now() RETURNING) — concurrent/replayed
 * redeems see at most one success (replay-safe, like consumeAuthCode). Returns
 * null for an unknown / expired / already-used code.
 */
export async function consumeEmitHandoff(db: Db, rawCode: string): Promise<ConsumedHandoff | null> {
  const rows = await db.execute<{ teammate_id: string; instance_id: string }>(sql`
    UPDATE emit_handoff SET consumed_at = now()
     WHERE code_hash = ${hashSessionToken(rawCode)}
       AND consumed_at IS NULL
       AND expires_at > now()
    RETURNING teammate_id::text AS teammate_id, instance_id::text AS instance_id
  `)
  const row = [...rows][0]
  if (!row) return null
  return { teammateId: row.teammate_id, instanceId: row.instance_id }
}

export interface OtelBundle {
  OTEL_LOGS_EXPORTER: 'otlp'
  OTEL_METRICS_EXPORTER: 'none'
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: string
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf'
  otel_headers_helper_url: string
  OTEL_RESOURCE_ATTRIBUTES: string
}

/**
 * The Copilot-specific provisioning bundle.
 *
 * Unlike Claude (which reads env from ~/.claude/settings.json), Copilot CLI has no
 * app-managed env block. The bundle therefore carries the shell-rc env vars the
 * redeem helper writes to ~/.bashrc / ~/.zshrc (inside a delimited removable block),
 * plus the durable emit credential for ~/.tokenscope/config.json. The forwarder
 * lifecycle hooks are declared by the plugin's own hooks.json (NOT written by redeem).
 * See spec §2a and Slice 1.
 */
export interface CopilotBundle {
  /** Durable emit credential endpoints — the helper writes these to ~/.tokenscope/config.json. */
  TOKENSCOPE_BEARER_ENDPOINT: string
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: string
  TOKENSCOPE_OAUTH_CLIENT_ID: string
  /** The Azure Monitor DCR logs ingest URL for the file-forwarder. */
  TOKENSCOPE_LOGS_ENDPOINT: string
  /**
   * ADVISORY ONLY — a home-agnostic logical path (`~/.tokenscope/...`). The client
   * (copilot-redeem.mjs) MUST resolve its OWN absolute path from the client's home;
   * do NOT write this string to the filesystem as-is (the `~` will not expand). The
   * server cannot know the client's $HOME — this field exists for the bundle shape.
   */
  COPILOT_OTEL_FILE_EXPORTER_PATH: string
  /** Shell-rc env var the helper appends alongside the client-resolved path export. */
  OTEL_RESOURCE_ATTRIBUTES: string
  /** The attested instance UUID — the helper must emit EXACTLY this value. Security invariant. */
  instance_id: string
}

/**
 * Build the OTel telemetry bundle for an instance — the EXACT shape
 * setup/exchange.post returns (so the redeem endpoint mirrors it). `origin` MUST
 * be the PUBLIC origin (getPublicRequestURL) so the baked bearer/OTLP endpoints
 * are reachable behind Front Door. `projectCodeHash` null ⇒ untagged (no
 * project.code_hash in the resource attrs).
 */
export function buildOtelBundle(
  origin: string,
  instanceId: string,
  projectCodeHash: string | null,
  tool: EmitTool = 'claude-code',
): { bearerEndpoint: string; oauthTokenEndpoint: string; bundle: OtelBundle | CopilotBundle } {
  const bearerEndpoint = `${origin}/api/v1/instances/${instanceId}/bearer`
  const oauthTokenEndpoint = `${origin}/api/v1/oauth/token`
  const logsEndpoint =
    process.env.NUXT_AZURE_MONITOR_LOGS_ENDPOINT ??
    (process.env.NUXT_AZURE_MONITOR_ENDPOINT
      ? `${process.env.NUXT_AZURE_MONITOR_ENDPOINT}/v1/logs`
      : `${origin}/azmon-stub/v1/logs`)

  if (tool === 'copilot-cli') {
    // Copilot has no app-managed env block. The redeem helper writes these to:
    //   - ~/.tokenscope/config.json (durable emit credential)
    //   - ~/.bashrc / ~/.zshrc (shell-rc env vars, in a delimited block)
    // The forwarder lifecycle hooks come from the plugin's own hooks.json (NOT redeem).
    // CLIENT-local path: the redeem helper resolves the absolute path from the
    // CLIENT's own home. The server cannot know the client's $HOME — baking the
    // server container's $HOME here shipped `/home/tokenscope/...` to every client
    // (Copilot then wrote spans to a dir the forwarder never tailed → zero
    // telemetry). Send a home-agnostic logical path; copilot-redeem.mjs owns the
    // absolute resolution (from its own homedir) for both config.json and the rc env.
    const otelFilePath = '~/.tokenscope/copilot-otel.jsonl'
    const resourceAttrs = projectCodeHash
      ? `tokenscope.instance_id=${instanceId},project.code_hash=${projectCodeHash},tool=copilot-cli`
      : `tokenscope.instance_id=${instanceId},tool=copilot-cli`
    return {
      bearerEndpoint,
      oauthTokenEndpoint,
      bundle: {
        TOKENSCOPE_BEARER_ENDPOINT: bearerEndpoint,
        TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: oauthTokenEndpoint,
        TOKENSCOPE_OAUTH_CLIENT_ID: process.env.NUXT_OAUTH_CLIENT_ID ?? '',
        TOKENSCOPE_LOGS_ENDPOINT: logsEndpoint,
        COPILOT_OTEL_FILE_EXPORTER_PATH: otelFilePath,
        OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
        instance_id: instanceId,
      } satisfies CopilotBundle,
    }
  }

  // claude-code bundle (the existing shape — unchanged)
  const resourceAttrs = projectCodeHash
    ? `tokenscope.instance_id=${instanceId},project.code_hash=${projectCodeHash},tool=claude-code`
    : `tokenscope.instance_id=${instanceId},tool=claude-code`
  return {
    bearerEndpoint,
    oauthTokenEndpoint,
    bundle: {
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logsEndpoint,
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
      otel_headers_helper_url: bearerEndpoint,
      OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
    } satisfies OtelBundle,
  }
}

/**
 * Mint a durable EMIT credential bound to a specific instance, rotating out any
 * prior LIVE emit credential for that device (revoke them) so at most ONE is live
 * per instance ("no unbounded creds"). The new oauth_token row carries
 * instance_id (mig 0031). Scope stays tokenscope.emit ONLY — no widening.
 *
 * Imported lazily by the redeem endpoint via issueEmitCredential; this wrapper
 * adds the instance binding + rotation that the setup-token path doesn't need.
 */
export async function issueInstanceEmitCredential(
  db: Db,
  teammateId: string,
  instanceId: string,
  issue: (db: Db, teammateId: string) => Promise<{ clientId: string; tokens: { refresh_token: string } }>,
): Promise<{ clientId: string; refreshToken: string }> {
  // ONE transaction, serialized per instance. The rotate→issue→bind sequence has a
  // TOCTOU window: the freshly-INSERTed credential is invisible to the rotate's
  // `WHERE instance_id = X` until the bind sets it, so two concurrent redeems for
  // the SAME instance could each leave a live emit credential (R2 F1). An advisory
  // xact lock keyed on the instance makes the rotate see the in-flight insert; the
  // partial-unique index (mig 0033) is the hard backstop if a future path forgets.
  return db.transaction(async (tx) =>
    issueInstanceEmitCredentialTx(tx as unknown as Db, teammateId, instanceId, issue),
  )
}

/**
 * Transaction-participating body of issueInstanceEmitCredential (AUTH-1): the
 * redeem endpoint runs consume→check→mint→audit inside ONE transaction so a
 * mid-sequence failure rolls everything back to a redeemable handoff with the
 * old credential still live. `tx` MUST be an open transaction — the advisory
 * lock is pg_advisory_xact_lock (released at commit/rollback) and the
 * rotate→issue→bind sequence relies on the caller's atomicity.
 */
export async function issueInstanceEmitCredentialTx(
  tx: Db,
  teammateId: string,
  instanceId: string,
  issue: (db: Db, teammateId: string) => Promise<{ clientId: string; tokens: { refresh_token: string } }>,
): Promise<{ clientId: string; refreshToken: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${instanceId}))`)
  await tx.execute(sql`
    UPDATE oauth_token SET revoked_at = now()
     WHERE instance_id = ${instanceId}::uuid
       AND revoked_at IS NULL
       AND scope = 'tokenscope.emit'
  `)
  const cred = await issue(tx, teammateId)
  // Bind the freshly-minted credential to this instance (issue() can't set it).
  await tx.execute(sql`
    UPDATE oauth_token SET instance_id = ${instanceId}::uuid
     WHERE refresh_token_hash = ${hashSessionToken(cred.tokens.refresh_token)}
  `)
  return { clientId: cred.clientId, refreshToken: cred.tokens.refresh_token }
}
