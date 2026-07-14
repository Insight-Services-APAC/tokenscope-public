/*
 * POST /api/v1/setup/redeem { handoff_code, instance_id? } — redeem the one-time
 * emit-provisioning handoff minted by the provision_emit MCP tool for the durable
 * emit credential + the OTel bundle the CLI needs to emit.
 *
 * This is the SECOND leg of the secret-isolating device-provisioning flow
 * (docs/design/mcp-client-backbone.md §"One auth → also provisions the device"):
 * provision_emit (read-scoped MCP tool) returns ONLY a short-TTL handoff code so
 * the durable emit refresh token never enters the LLM's context; the local
 * emit-redeem helper then calls THIS endpoint directly (process→server, NOT MCP)
 * and writes the credential into ~/.claude/settings.json itself.
 *
 * Auth: the handoff code IS the auth (no cookie, no CSRF surface — like
 * /setup/exchange and /bearer). Single-use is enforced by an atomic CAS in
 * consumeEmitHandoff (UPDATE ... WHERE consumed_at IS NULL ... RETURNING), so a
 * replayed/concurrent redeem gets 401. The response carries one-time credential
 * material → Cache-Control: no-store (mirrors the OAuth token endpoint).
 *
 * The minted emit credential is tokenscope.emit ONLY (issueEmitCredential never
 * widens scope) and is bound to the handoff's instance, rotating out any prior
 * live emit credential for that device.
 */
import { createError, defineEventHandler, readValidatedBody, setResponseHeaders } from 'h3'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { getDb } from '../../../db'
import { issueEmitCredential } from '../../../auth/emit-credential'
import {
  consumeEmitHandoff,
  issueInstanceEmitCredentialTx,
  buildOtelBundle,
} from '../../../auth/emit-provision'
import { recordAuditEvent } from '../../../db/audit'
import { getPublicRequestURL } from '../../../utils/public-url'

const Body = z.object({
  handoff_code: z.string().min(10).max(512),
  // Optional defence-in-depth: the helper passes the instance it provisioned; if
  // present it MUST match the handoff's bound instance (a mismatched id → 401, so
  // a code can't be redirected onto another device).
  instance_id: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
  const { handoff_code, instance_id } = await readValidatedBody(event, (d) => Body.parse(d))
  const db = getDb()

  // ONE transaction for consume → attestation check → mint → audit (AUTH-1):
  // any mid-sequence failure (incl. a throwing recordAuditEvent) rolls back to
  // a still-redeemable handoff with the prior emit credential still live, so the
  // device can simply retry instead of being bricked. The consume CAS and the
  // per-instance advisory xact lock (issueInstanceEmitCredentialTx) both work
  // inside it.
  const { claimed, att, emit } = await db.transaction(async (tx) => {
    // Atomic single-use claim. Unknown / expired / already-used → null → 401.
    const claimed = await consumeEmitHandoff(tx as never, handoff_code)
    if (!claimed) {
      throw createError({ statusCode: 401, statusMessage: 'Invalid, expired, or already-used handoff code' })
    }
    // Bound-instance check (defence-in-depth; the handoff already carries it).
    if (instance_id && instance_id !== claimed.instanceId) {
      throw createError({ statusCode: 401, statusMessage: 'Handoff is not bound to that instance' })
    }

    // The attestation provision_emit created/located (state derives the bundle's
    // tagged/untagged shape). It must still exist + belong to this teammate.
    const attRows = await tx.execute<{ project_code_hash: string | null; tool: string | null }>(sql`
      SELECT project_code_hash, tool
        FROM instance_attestation
       WHERE instance_id = ${claimed.instanceId}::uuid
         AND teammate_id = ${claimed.teammateId}::uuid
       LIMIT 1
    `)
    const att = [...attRows][0]
    if (!att) {
      throw createError({ statusCode: 401, statusMessage: 'Handoff references a missing instance' })
    }

    // Mint the durable emit credential, bound to this instance and rotating out any
    // prior live emit credential for it. Scope stays tokenscope.emit ONLY.
    const emit = await issueInstanceEmitCredentialTx(
      tx as never,
      claimed.teammateId,
      claimed.instanceId,
      issueEmitCredential,
    )

    await recordAuditEvent(tx as never, {
      eventType: 'emit-provisioned',
      actorTeammateId: claimed.teammateId,
      actorSystem: 'setup-redeem',
      subjectKind: 'instance',
      subjectId: claimed.instanceId,
      payload: { oauth_emit_credential: true, tool: att.tool ?? 'claude-code' },
    })

    return { claimed, att, emit }
  })

  const tool = (att.tool ?? 'claude-code') as 'claude-code' | 'copilot-cli'

  // PUBLIC origin (pinned APP_PUBLIC_ORIGIN, else the Front Door host, else the
  // request Host — see getPublicRequestURL) so the baked bearer/OTLP endpoints
  // are reachable, not the firewalled internal CA FQDN. Same discipline as
  // setup/exchange.
  const origin = getPublicRequestURL(event).origin
  const { bearerEndpoint, oauthTokenEndpoint, bundle } = buildOtelBundle(
    origin,
    claimed.instanceId,
    att.project_code_hash,
    tool,
  )

  // Mirror setup/exchange.post's response shape exactly (the helper reuses the
  // same env-builder). No read credential here — the read+tag credential came
  // from the SAME OAuth consent that authorised provision_emit (the MCP grant),
  // so this leg ships only the device's durable emit credential.
  // For copilot-cli, the bundle is the CopilotBundle shape (no OTEL_LOGS_EXPORTER etc).
  const telemetry = tool === 'copilot-cli' ? { copilot: bundle } : { claude: bundle }
  return {
    instance_id: claimed.instanceId,
    session_id: claimed.instanceId, // legacy alias (exchange.post used session_id)
    bearer_endpoint: bearerEndpoint,
    oauth_refresh_token: emit.refreshToken,
    oauth_token_endpoint: oauthTokenEndpoint,
    oauth_client_id: emit.clientId,
    project_code: null, // provision_emit mints unassigned; tag per-repo/per-session
    unassigned: att.project_code_hash === null,
    tool,
    telemetry,
  }
})
