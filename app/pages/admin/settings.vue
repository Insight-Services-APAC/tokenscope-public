<script setup lang="ts">
/*
 * Admin → Settings (Wave VI). Sectioned read-only configuration view.
 *
 * No mutations this wave — settings flows in a later slice. The page
 * surfaces:
 *   - Auth (dev-mode + persona-override flags + bootstrap admin email)
 *   - Entra (tenant / client / redirect — all public-IDs, never secrets)
 *   - Region (caller's home region)
 *   - Governance dials (S4 — editable, see AdminGovernanceDialsSection)
 *   - Features (empty placeholder)
 *
 * The endpoint NEVER returns any secret value; the UI doesn't render
 * an `entra.clientSecret` field even speculatively, so accidental
 * future-leak via a backend tweak is harder.
 */
import { computed, ref, watch } from 'vue'
import type { GovernanceDialsData } from '../../components/admin/GovernanceDialsSection.vue'
import type { DirectoryExclusionRow } from '../../components/admin/DirectoryExclusionsSection.vue'

interface SettingsResp {
  auth: {
    devMode: boolean
    allowPersonaOverride: boolean
    bootstrapAdminEmail: string
    deployEnv: string
    demoCapable: boolean
  }
  // Wave-VII: build provenance — surfaces the running revision so an
  // operator can confirm what's actually live. Both fields are
  // nullable: commitSha is null when neither the Dockerfile ARG bake
  // nor the Bicep env-var override populated the value; imageTag is
  // null outside Container Apps (local dev).
  build: {
    commitSha: string | null
    imageTag: string | null
  }
  entra: {
    tenantId: string
    clientId: string
    redirectUri: string
  }
  features: Record<string, boolean>
  region: { id: string; code: string; displayName: string } | null
  nodeEnv: string
}

const { session, ensure } = useSession()
await ensure()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'global-finops' || r === 'platform-admin'
})

const isOrgWide = computed(() => {
  const r = session.value?.role
  return r === 'global-finops' || r === 'platform-admin'
})

const { data, pending } = await useFetch<SettingsResp>('/api/v1/admin/settings', {
  default: () => null as unknown as SettingsResp,
  immediate: isAdmin.value,
})

const flagBadge = (v: boolean) =>
  v ? { kind: 'rag-amber' as const, label: 'on' } : { kind: 'neutral' as const, label: 'off' }

// Project-lifecycle platform cadence (D9). Editable by org-wide admins; region
// admins see it read-only (they override on their own region page).
interface LifecycleResp {
  platform: { grace_hours: number; warn_days: number }
}
const { data: lifecycle, refresh: refreshLifecycle } = await useFetch<LifecycleResp>(
  '/api/v1/admin/settings/project-lifecycle',
  { default: () => null as unknown as LifecycleResp, immediate: isAdmin.value },
)
const graceHours = ref<number | null>(null)
const warnDays = ref<number | null>(null)
watch(
  lifecycle,
  (v) => {
    if (v) {
      graceHours.value = v.platform.grace_hours
      warnDays.value = v.platform.warn_days
    }
  },
  { immediate: true },
)
// Governance dials (S4) — GET feeds the section; the section PUTs and
// emits `saved`, and we re-fetch (optimistic-refresh). Region list only
// matters for the org-wide scope picker.
const { data: governance, refresh: refreshGovernance } = await useFetch<GovernanceDialsData>(
  '/api/v1/admin/governance-settings',
  { default: () => null as unknown as GovernanceDialsData, immediate: isAdmin.value },
)
const { data: regionsData } = await useFetch<{
  regions: { id: string; code: string; display_name: string }[]
}>('/api/v1/admin/regions', {
  default: () => ({ regions: [] }),
  immediate: isAdmin.value && isOrgWide.value,
})
const { data: exclusions, refresh: refreshExclusions } = await useFetch<{
  patterns: DirectoryExclusionRow[]
}>('/api/v1/admin/directory-exclusions', {
  default: () => ({ patterns: [] }),
  immediate: isAdmin.value,
})

const savingLifecycle = ref(false)
const lifecycleError = ref<string | null>(null)
const lifecycleSaved = ref(false)
async function saveLifecycle() {
  if (graceHours.value === null || warnDays.value === null) return
  savingLifecycle.value = true
  lifecycleError.value = null
  try {
    await $fetch('/api/v1/admin/settings/project-lifecycle', {
      method: 'PUT',
      body: { grace_hours: graceHours.value, warn_days: warnDays.value },
    })
    lifecycleSaved.value = true
    setTimeout(() => (lifecycleSaved.value = false), 3000)
    await refreshLifecycle()
  } catch (e: unknown) {
    lifecycleError.value = apiErrorDetail(e, 'Save failed')
  } finally {
    savingLifecycle.value = false
  }
}
</script>

<template>
  <div v-if="isAdmin" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="admin-settings">
    <UiPageHead
      eyebrow="Administration"
      title="Settings"
      sub="Read-only public configuration. Secret material is never surfaced here."
      :crumbs="['Admin', 'Settings']"
    />
    <div v-if="pending" class="text-center text-sm text-carbon-3 py-8">Loading…</div>
    <div v-else-if="data" class="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <!-- Auth -->
      <UiCard accent="harmony" data-testid="admin-settings-auth">
        <UiEyebrow>Auth</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Sign-in + persona</h2>
        <dl class="space-y-3 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Dev mode</dt>
            <dd><UiBadge :kind="flagBadge(data.auth.devMode).kind">{{ flagBadge(data.auth.devMode).label }}</UiBadge></dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Persona override</dt>
            <dd><UiBadge :kind="flagBadge(data.auth.allowPersonaOverride).kind">{{ flagBadge(data.auth.allowPersonaOverride).label }}</UiBadge></dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Deploy env</dt>
            <dd class="font-mono text-xs text-carbon" data-testid="admin-settings-deploy-env">{{ data.auth.deployEnv }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Demo features</dt>
            <dd data-testid="admin-settings-demo-capable">
              <UiBadge :kind="data.auth.demoCapable ? 'rag-amber' : 'rag-green'">
                {{ data.auth.demoCapable ? 'Demo-capable (local/sandbox)' : 'Locked down' }}
              </UiBadge>
            </dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Bootstrap admin email</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.auth.bootstrapAdminEmail || '—' }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">NODE_ENV</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.nodeEnv }}</dd>
          </div>
        </dl>
      </UiCard>

      <!-- Entra -->
      <UiCard accent="vision" data-testid="admin-settings-entra">
        <UiEyebrow>Entra ID (public)</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">OIDC provider</h2>
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-carbon-2 mb-1">Tenant ID</dt>
            <dd class="font-mono text-xs text-carbon break-all">{{ data.entra.tenantId || '—' }}</dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Client ID</dt>
            <dd class="font-mono text-xs text-carbon break-all">{{ data.entra.clientId || '—' }}</dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Redirect URI</dt>
            <dd class="font-mono text-xs text-carbon break-all">{{ data.entra.redirectUri || '—' }}</dd>
          </div>
        </dl>
        <p class="text-[11px] text-carbon-3 mt-4 leading-relaxed italic">
          Client secret is held in Key Vault and never surfaced through this endpoint.
        </p>
      </UiCard>

      <!-- Region -->
      <UiCard accent="zeal" data-testid="admin-settings-region">
        <UiEyebrow>Region</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Your active region</h2>
        <dl v-if="data.region" class="space-y-3 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Code</dt>
            <dd class="font-mono text-xs text-carbon">{{ data.region.code }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-carbon-2">Display name</dt>
            <dd class="text-carbon">{{ data.region.displayName }}</dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Region ID</dt>
            <dd class="font-mono text-[11px] text-carbon-3 break-all">{{ data.region.id }}</dd>
          </div>
        </dl>
        <p v-else class="text-sm text-carbon-3 italic">No region assigned to this session.</p>
      </UiCard>

      <!-- Build (Wave VII) -->
      <UiCard accent="vision" data-testid="admin-settings-build">
        <UiEyebrow>Build</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Running revision</h2>
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-carbon-2 mb-1">Commit SHA</dt>
            <dd
              class="font-mono text-xs break-all"
              :class="data.build.commitSha ? 'text-carbon' : 'text-carbon-3 italic'"
              data-testid="admin-settings-build-commit-sha"
            >{{ data.build.commitSha ?? 'unknown' }}</dd>
          </div>
          <div>
            <dt class="text-carbon-2 mb-1">Image tag / revision</dt>
            <dd
              class="font-mono text-xs break-all"
              :class="data.build.imageTag ? 'text-carbon' : 'text-carbon-3 italic'"
              data-testid="admin-settings-build-image-tag"
            >{{ data.build.imageTag ?? 'unknown' }}</dd>
          </div>
        </dl>
        <p class="text-[11px] text-carbon-3 mt-4 leading-relaxed italic">
          Commit SHA is baked into the image at build time and may be overridden at deploy time
          via the GIT_COMMIT_SHA env var. <code class="font-mono">unknown</code> means neither path populated a value.
        </p>
      </UiCard>

      <!-- Project lifecycle (D9) -->
      <UiCard accent="zeal" data-testid="admin-settings-lifecycle">
        <UiEyebrow>Project lifecycle</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-1">End-date cadence</h2>
        <p class="text-xs text-carbon-3 mb-4 leading-relaxed">
          Platform defaults for the project end-date model. Regions can override these on their region page.
        </p>
        <div class="space-y-3 text-sm">
          <div>
            <label for="lifecycle-grace" class="text-[12px] font-semibold text-carbon">
              Grace — hours after a project ends before in-flight spend spills to unallocated
            </label>
            <input
              id="lifecycle-grace"
              v-model.number="graceHours"
              type="number"
              min="0"
              max="168"
              :disabled="!isOrgWide"
              data-testid="admin-settings-lifecycle-grace"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none disabled:bg-calm-1 disabled:text-carbon-3"
            >
          </div>
          <div>
            <label for="lifecycle-warn" class="text-[12px] font-semibold text-carbon">
              Warning window — days before the end date to warn assigned developers
            </label>
            <input
              id="lifecycle-warn"
              v-model.number="warnDays"
              type="number"
              min="1"
              max="90"
              :disabled="!isOrgWide"
              data-testid="admin-settings-lifecycle-warn"
              class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none disabled:bg-calm-1 disabled:text-carbon-3"
            >
          </div>
          <p v-if="lifecycleError" class="text-xs text-rag-red" role="alert">{{ lifecycleError }}</p>
          <p v-if="lifecycleSaved" class="text-xs text-brand-harmony" data-testid="admin-settings-lifecycle-saved">Saved.</p>
          <div v-if="isOrgWide" class="flex justify-end">
            <UiButton
              kind="primary"
              size="sm"
              :disabled="savingLifecycle"
              data-testid="admin-settings-lifecycle-save"
              @click="saveLifecycle"
            >
              {{ savingLifecycle ? 'Saving…' : 'Save' }}
            </UiButton>
          </div>
          <p v-else class="text-[11px] text-carbon-3 italic">
            Only platform / global-finops admins can change the platform default. You can override it for your region on its page.
          </p>
        </div>
      </UiCard>

      <!-- Governance dials (S4) -->
      <AdminGovernanceDialsSection
        class="lg:col-span-2"
        :data="governance"
        :regions="regionsData?.regions ?? []"
        :org-wide="isOrgWide"
        :region-id="session?.regionId ?? null"
        :region-code="data.region?.code ?? null"
        @saved="refreshGovernance()"
      />

      <!-- Directory exclusions (#121) — hide privileged/service accounts -->
      <AdminDirectoryExclusionsSection
        class="lg:col-span-2"
        :rows="exclusions?.patterns ?? []"
        :org-wide="isOrgWide"
        @changed="refreshExclusions()"
      />

      <!-- Features -->
      <UiCard accent="hunger" data-testid="admin-settings-features">
        <UiEyebrow>Features</UiEyebrow>
        <h2 class="text-lg font-bold text-carbon mt-1 mb-4">Feature flags</h2>
        <p v-if="Object.keys(data.features).length === 0" class="text-sm text-carbon-3 italic">
          No feature flags wired yet. This panel is a placeholder for a later slice.
        </p>
        <dl v-else class="space-y-2 text-sm">
          <div v-for="(v, k) in data.features" :key="k" class="flex items-center justify-between">
            <dt class="text-carbon-2 font-mono text-xs">{{ k }}</dt>
            <dd><UiBadge :kind="v ? 'rag-green' : 'neutral'">{{ v ? 'on' : 'off' }}</UiBadge></dd>
          </div>
        </dl>
      </UiCard>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
