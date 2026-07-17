/*
 * admin route middleware — the ONE gate for /admin/**. Replaces the per-page
 * copy-pasted `v-if="isAdmin"` client guards with a real redirect. Server-side
 * endpoints still enforce their own RBAC; this is the navigation boundary.
 *
 * Opt in per page via definePageMeta({ middleware: 'admin' }).
 */
import { isAdminRole } from '#shared/auth/roles'

export default defineNuxtRouteMiddleware(async () => {
  const { session, ensure } = useSession()
  if (!session.value) {
    try {
      await ensure()
    } catch {
      // Mirror auth.global (FE-8): a transient /auth/me failure must not
      // hard-crash navigation. Fall through with no session → fail closed to
      // '/' below rather than throwing the Nuxt error screen.
    }
  }
  if (!isAdminRole(session.value?.role)) {
    // Non-admins (and the fail-closed no-session case) never see the admin
    // area — send them home. The global auth middleware runs first and already
    // redirects the genuinely unauthenticated to /login.
    return navigateTo('/')
  }
})
