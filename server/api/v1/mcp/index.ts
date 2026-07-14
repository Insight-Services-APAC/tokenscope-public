/*
 * Handle bare /api/v1/mcp requests (no trailing path segment).
 *
 * In Nitro production builds the [...].ts catch-all only matches
 * /api/v1/mcp/{subpath} — the bare /api/v1/mcp path (the canonical MCP
 * endpoint, and the `resource` advertised in the protected-resource metadata)
 * falls through to SSR otherwise. This re-export makes /api/v1/mcp work.
 */
export { default } from './[...]'
