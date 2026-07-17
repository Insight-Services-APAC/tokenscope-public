/*
 * useAdminAccess — ONE source for the admin gating that was copy-pasted as
 * isAdmin / isOrgWide / isPlatformAdmin computeds across ~13 admin pages.
 *
 * Reads the shared session and the canonical role helpers in shared/auth/roles.
 * Pages should consume this instead of re-deriving role predicates.
 */
import { computed } from 'vue'
import { isAdminRole, isOrgWideRole, isPlatformAdmin, roleLabel } from '#shared/auth/roles'

export function useAdminAccess() {
  const { session } = useSession()

  const role = computed(() => session.value?.role ?? '')
  const regionId = computed(() => session.value?.regionId ?? '')
  const displayName = computed(() => session.value?.displayName ?? '')

  /** Any admin role (Region admin / Global finance / Platform admin). */
  const isAdmin = computed(() => isAdminRole(role.value))
  /** Cross-region roles (Global finance / Platform admin). */
  const isOrgWide = computed(() => isOrgWideRole(role.value))
  /** Platform admin only. */
  const isPlatform = computed(() => isPlatformAdmin(role.value))
  /** Human-facing label for the current role (never a raw enum code). */
  const roleDisplay = computed(() => roleLabel(role.value))

  return { role, regionId, displayName, isAdmin, isOrgWide, isPlatform, roleDisplay }
}
