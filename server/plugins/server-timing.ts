/*
 * O1 — Server-Timing on buffered /api responses
 * (docs/design/performance-observability-baseline.md).
 *
 * Registration only; the substance is in server/observability/request-timing.ts
 * so tests can drive it without a built server (the oidc-session-store.ts
 * precedent — a Nitro plugin is reachable only from a booted build).
 *
 * Scope is honest per dr-H1: h3 skips `beforeResponse` for handled/direct-write
 * responses, so the MCP direct-`res` path (server/api/v1/mcp/[...].ts) and
 * OAuth redirects never carry the header — DOCUMENTED behaviour, not forced.
 * Static assets are excluded by the /api/ gate in wrapAppHandlerWithTiming.
 */
import { defineNitroPlugin } from 'nitropack/runtime'
import { wrapAppHandlerWithTiming, writeServerTiming } from '../observability/request-timing'

export default defineNitroPlugin((nitroApp) => {
  // Root-handler wrap, NOT a request-hook enterWith — an awaited hook
  // callback cannot bind ALS context for the rest of the request (see the
  // wrapper's doc; proven live on the built artifact). Nitro reassigns
  // h3App.handler itself (runtime/internal/app.mjs:140), same pattern.
  nitroApp.h3App.handler = wrapAppHandlerWithTiming(
    nitroApp.h3App.handler,
  ) as typeof nitroApp.h3App.handler
  nitroApp.hooks.hook('beforeResponse', (event) => {
    writeServerTiming(event)
  })
})
