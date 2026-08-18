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
 *
 * LANE: machine, ADOPTED MID-TRANSACTION (docs/design/rls-enforcement.md §2).
 * This is the one handler whose identity cannot be known before the transaction
 * opens: the teammate is DISCOVERED by consuming the one-time handoff code, and
 * that consume has to be the first statement of the same transaction as
 * everything after it — a mid-sequence failure must roll back to a
 * still-redeemable code rather than bricking the device. So it opens the
 * transaction, learns who it is from the handoff + attestation join, and then
 * calls `applyRlsContext` (server/db/rls.ts) before the credential mint and the
 * audit write, which are the statements that actually touch policy-bearing
 * tables (`oauth_token`, `audit_event`).
 *
 * The identity is REAL, not asserted: the handoff was minted by the read-scoped
 * `provision_emit` MCP tool behind a completed OAuth consent, so `teammate_id`
 * comes from a credential the server issued — the opposite of /setup/enroll's
 * caller-supplied `claimed_email`.
 */
import { createError, defineEventHandler, readValidatedBody, setResponseHeaders } from 'h3'
import { assertTrustedPublicOrigin } from '../../../utils/public-url'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { withDeferredMachineRls } from '../../../db/machine-rls'
import { issueEmitCredential } from '../../../auth/emit-credential'
import {
  consumeEmitHandoff,
  issueInstanceEmitCredentialTx,
  buildOtelBundle,
  requireEmitTool,
} from '../../../auth/emit-provision'
import { recordAuditEvent } from '../../../db/audit'

const Body = z.object({
  handoff_code: z.string().min(10).max(512),
  // Optional defence-in-depth: the helper passes the instance it provisioned; if
  // present it MUST match the handoff's bound instance (a mismatched id → 401, so
  // a code can't be redirected onto another device).
  instance_id: z.string().uuid().optional(),
})

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
  // BEFORE anything is consumed. This request commits its transaction before the
  // bundle is built, and that transaction spends the ONE-TIME handoff code. So
  // discovering an untrusted origin at bundle-build time would cost the caller a
  // single-use code they cannot get back, for a purely server-side fault.
  assertTrustedPublicOrigin(event)
  const { handoff_code, instance_id } = await readValidatedBody(event, (d) => Body.parse(d))

  // ONE transaction for consume → attestation check → mint → audit (AUTH-1):
  // any mid-sequence failure (incl. a throwing recordAuditEvent) rolls back to
  // a still-redeemable handoff with the prior emit credential still live, so the
  // device can simply retry instead of being bricked. The consume CAS and the
  // per-instance advisory xact lock (issueInstanceEmitCredentialTx) both work
  // inside it.
  const { claimed, att, emit, tool } = await withDeferredMachineRls(async (tx, adopt) => {
    // Atomic single-use claim. Unknown / expired / already-used → null → 401.
    const claimed = await consumeEmitHandoff(tx as never, handoff_code)
    if (!claimed) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Invalid, expired, or already-used handoff code',
      })
    }
    // Bound-instance check (defence-in-depth; the handoff already carries it).
    if (instance_id && instance_id !== claimed.instanceId) {
      throw createError({ statusCode: 401, statusMessage: 'Handoff is not bound to that instance' })
    }

    // The attestation provision_emit created/located (state derives the bundle's
    // tagged/untagged shape). It must still exist + belong to this teammate.
    //
    // The join to teammate/org_unit rides ALONG — it is what turns the handoff's
    // `teammate_id` into the four RLS GUCs, at zero extra round-trips. Inner
    // joins: `teammate.org_unit_id` and `teammate.region_id` are both NOT NULL
    // with FK targets (drizzle/schema/identity.ts), so they cannot drop the row.
    const attRows = await tx.execute<{
      project_code_hash: string | null
      tool: string | null
      region_id: string
      org_path: string
      role: string
    }>(sql`
      SELECT ia.project_code_hash,
             ia.tool,
             tm.region_id::text AS region_id,
             ou.path::text      AS org_path,
             tm.role            AS role
        FROM instance_attestation ia
        JOIN teammate tm ON tm.id = ia.teammate_id
        JOIN org_unit ou ON ou.id = tm.org_unit_id
       WHERE ia.instance_id = ${claimed.instanceId}::uuid
         AND ia.teammate_id = ${claimed.teammateId}::uuid
       LIMIT 1
    `)
    const att = [...attRows][0]
    if (!att) {
      throw createError({ statusCode: 401, statusMessage: 'Handoff references a missing instance' })
    }

    // ADOPT the identity for the REST of this transaction (SET LOCAL — gone when
    // it ends).
    //
    // This comment used to say everything above touched "only policy-free tables
    // (`emit_handoff`, `instance_attestation`)". `emit_handoff` is policy-free;
    // `instance_attestation` is NOT — it has had RLS enabled since 0002 (as
    // `session_attestation`, renamed by 0019), as do `teammate` and `org_unit`
    // in the join above. Under a non-owner role those reads return no row and
    // this endpoint 401s a perfectly valid handoff, so all three are in
    // server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and must be DISABLEd
    // before the role switch. tests/integration/db/rls-bootstrap-set.test.ts
    // exercises this path as a non-owner and fails if that set is short — with
    // a COPY of this query's shape, not this query, so an edit here does not
    // reach it. Its `drift` suite is what actually guards completeness: it
    // reads this file's SQL and fails if an RLS-enabled table appears here
    // without being in the constant.
    await adopt({
      teammateId: claimed.teammateId,
      regionId: att.region_id,
      orgPath: att.org_path,
      role: att.role,
    })
    // Narrow the stored tool HERE, inside the transaction, rather than casting
    // it after the commit. A cast asserts instead of checking, and doing the
    // check after the commit would burn the one-time handoff over a broken row.
    // Throwing here rolls the whole thing back to a still-redeemable code.
    const tool = requireEmitTool(att.tool)

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

    return { claimed, att, emit, tool }
  })

  // buildOtelBundle derives the PUBLIC origin from the event itself and refuses
  // to bake an untrusted one — the endpoints it returns are durable, so an
  // unreachable host here means a silently dead enrolment. See its docstring.
  const { bearerEndpoint, oauthTokenEndpoint, bundle } = buildOtelBundle(
    event,
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
