/*
 * POST /api/v1/oauth/code-status — lets the consent page tell whether the MCP
 * client exchanged, for a token, the code it just delivered to a loopback redirect, so it can
 * fall back to paste-back when the loopback is unreachable (e.g. a container).
 * Scoped to the caller's own codes; POST so the raw code never lands in a URL.
 */
import { defineEventHandler, setResponseHeaders } from 'h3'
import { requireAuth } from '../../../auth/rbac'
import { assertSameOrigin } from '../../../auth/csrf'
import { isAuthCodeRedeemed } from '../../../auth/oauth'
import { withRequestRls } from '../../../db/request-rls'
import { readValidated } from '../../../utils/validated-body'
import { codeStatusBodySchema } from '../../../../shared/schemas/oauth'

export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const body = await readValidated(event, codeStatusBodySchema)
  const redeemed = await withRequestRls(event, (tx) => isAuthCodeRedeemed(tx, body.code, session.teammateId))
  setResponseHeaders(event, { 'Cache-Control': 'no-store' })
  return { redeemed }
})
