/*
 * Single source of truth for OAuth scope → human metadata. Consumed by BOTH the
 * browser consent page (app/pages/oauth/authorize.vue) and the server grant
 * review surfaces (server/utils/me-queries.ts → account / admin grants), so a
 * user reads the SAME words at grant time and at review time. (The scope VALUE
 * vocabulary lives in server/auth/oauth.ts::OAUTH_SCOPES; this is the display
 * metadata for those values.)
 */
export const OAUTH_SCOPE_LABELS: Record<string, string> = {
  'tokenscope.read': 'Read your usage, projects, and activity tags',
  'tokenscope.tag': 'Tag your sessions to a budget or activity (no budget changes)',
  'tokenscope.emit': 'Ship usage telemetry from this device',
}

/** Plain-language label for a scope; unknown scopes fall back to the raw string. */
export function oauthScopeLabel(scope: string): string {
  return OAUTH_SCOPE_LABELS[scope] ?? scope
}
