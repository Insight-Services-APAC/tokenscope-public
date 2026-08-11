/*
 * Single source of truth for OAuth scope → human metadata. Consumed by BOTH the
 * browser consent page (app/pages/oauth/authorize.vue) and the server grant
 * review surfaces (server/utils/me-queries.ts → account / admin grants), so a
 * user reads the SAME words at grant time and at review time. (The scope VALUE
 * vocabulary lives in server/auth/oauth.ts::OAUTH_SCOPES; this is the display
 * metadata for those values.)
 */
export const OAUTH_SCOPE_LABELS: Record<string, string> = {
  // Discloses the ADR-0005 E1 read→emit crossing: granting read ALSO lets this
  // device provision itself to emit (provision_emit is a read-scoped MCP tool
  // by design — see server/utils/mcp.ts's provision_emit doc comment). The
  // crossing is ratified and stays; this label is S6's fix for it being
  // undisclosed at consent time. A separate grantable `tokenscope.provision`
  // scope is the correct end state but is a client-contract change (D12, not
  // this sprint).
  'tokenscope.read': 'Read your usage, projects, and activity tags — and provision this device to emit its usage',
  'tokenscope.tag': 'Tag your sessions to a budget or activity (no budget changes)',
  'tokenscope.emit': 'Ship usage telemetry from this device',
}

/**
 * Plain-language label for a KNOWN scope. Unknown scopes get a generic,
 * clearly-labelled fallback — NEVER the raw scope string — so a caller-chosen
 * scope value can't render as if it were a real, understood permission (the
 * consent page's own defence is upstream of this: it only ever renders the
 * server-computed effective granted set, which can't contain an unknown
 * scope — see server/auth/oauth.ts::computeGrantedScopes — but every consumer
 * of this label, present and future, gets the same protection here too).
 */
export function oauthScopeLabel(scope: string): string {
  return OAUTH_SCOPE_LABELS[scope] ?? 'Unrecognised permission'
}
