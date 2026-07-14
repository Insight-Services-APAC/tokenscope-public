/*
 * Global auth middleware — redirect unauthenticated requests to /login.
 *
 * Public routes: /login, /api/* (server handles its own auth).
 * Everything else requires a session.
 *
 * The OIDC → ts_session bridge runs server-side in /api/v1/auth/me on
 * the FIRST request after Entra callback (see that file for the
 * same-request cookie-write/read trap). This middleware just reads the
 * final result via useSession() and redirects on a missing session.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login' || to.path.startsWith('/api/')) return
  const { session, ensure } = useSession()
  if (!session.value) {
    try {
      await ensure()
    } catch {
      // FE-8: a transient /auth/me failure (500, network) must not hard-crash
      // navigation with the Nuxt error screen — fall through with no session
      // so the unauthenticated redirect below sends the user to /login.
    }
  }
  if (!session.value?.authenticated) {
    return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`)
  }
})
