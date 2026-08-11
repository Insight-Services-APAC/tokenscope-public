<script setup lang="ts">
/*
 * OAuth consent page. The GET /api/v1/oauth/authorize endpoint gates the Entra
 * session + validates the client, then 302s the browser here with the OAuth
 * params. We show the requested scopes + Approve/Deny and POST the decision to
 * /api/v1/oauth/authorize with Accept: application/json — the server returns the
 * callback URL as DATA (not a 302), so we can render a Copy button. That is the
 * paste-back path for containerized clients whose loopback redirect can never be
 * reached; clients that CAN receive it just "open" the callback. (Mirrors the
 * production-proven a sibling project flow.)
 */
// Shared with the server grant-review UIs so consent + review read the same words.
import { oauthScopeLabel as scopeLabel } from '#shared/oauth-scopes'

definePageMeta({ layout: false })

const route = useRoute()

const responseType = computed(() => (route.query.response_type as string) || '')
const clientId = computed(() => (route.query.client_id as string) || '')
const redirectUri = computed(() => (route.query.redirect_uri as string) || '')
const codeChallenge = computed(() => (route.query.code_challenge as string) || '')
const codeChallengeMethod = computed(() => (route.query.code_challenge_method as string) || '')
const state = computed(() => (route.query.state as string) || '')
const scope = computed(() => (route.query.scope as string) || '')

const paramError = computed(() => {
  if (!clientId.value) return 'Missing client_id parameter'
  if (!redirectUri.value) return 'Missing redirect_uri parameter'
  if (!codeChallenge.value) return 'Missing code_challenge parameter (PKCE required)'
  if (codeChallengeMethod.value && codeChallengeMethod.value !== 'S256')
    return 'Invalid code_challenge_method — only S256 is supported'
  return null
})

/*
 * Client identity + the effective granted scope set (S6) — fetched from the
 * SAME GET /api/v1/oauth/authorize handler that already validated client_id +
 * redirect_uri against the DB (server/api/v1/oauth/authorize.get.ts), never
 * read from route.query. This page is a directly-navigable Nuxt route, so an
 * attacker can link straight to it with any query params they like — a
 * client_name (or scope list) sourced from route.query would be exactly as
 * trustworthy as whatever the attacker put in the link. Sourcing it from this
 * fetch's response instead means the rendered name/host/scopes are always the
 * server's own validated row for the given client_id, and an unknown scope
 * can never reach scopeLabel() from this page.
 */
interface ClientInfo {
  client_name: string
  redirect_host: string
  granted_scopes: string[]
}
type ClientInfoFetcher = (
  path: string,
  opts: { method: 'GET'; query: Record<string, string>; headers: Record<string, string> },
) => Promise<ClientInfo>

const clientInfo = ref<ClientInfo | null>(null)
const clientInfoError = ref<string | null>(null)
const scopes = computed(() => clientInfo.value?.granted_scopes ?? [])

async function loadClientInfo() {
  if (paramError.value) return
  // useRequestFetch forwards the SSR cookie (mirrors useSession.ts) — without
  // it this call would look unauthenticated during server rendering.
  const fetcher: ClientInfoFetcher = import.meta.server
    ? (useRequestFetch() as ClientInfoFetcher)
    : ($fetch as ClientInfoFetcher)
  try {
    clientInfo.value = await fetcher('/api/v1/oauth/authorize', {
      method: 'GET',
      query: {
        response_type: responseType.value || 'code',
        client_id: clientId.value,
        redirect_uri: redirectUri.value,
        code_challenge: codeChallenge.value,
        code_challenge_method: codeChallengeMethod.value || 'S256',
        scope: scope.value,
        state: state.value,
      },
      headers: { accept: 'application/json' },
    })
  } catch (err) {
    const e = err as { data?: { error_description?: string; error?: string }; message?: string }
    clientInfoError.value =
      e?.data?.error_description || e?.data?.error || e?.message || 'Could not verify this client.'
  }
}
await loadClientInfo()

const submitting = ref(false)
const callbackUrl = ref<string | null>(null)
const submitError = ref<string | null>(null)
const copied = ref(false)
const submitAction = ref<'approve' | 'deny' | null>(null)

async function handleSubmit(action: 'approve' | 'deny') {
  submitting.value = true
  submitError.value = null
  submitAction.value = action
  try {
    const body = await $fetch<{ redirect_url?: string; error?: string; error_description?: string }>(
      '/api/v1/oauth/authorize',
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: {
          response_type: responseType.value || 'code',
          client_id: clientId.value,
          redirect_uri: redirectUri.value,
          code_challenge: codeChallenge.value,
          code_challenge_method: codeChallengeMethod.value || 'S256',
          state: state.value,
          scope: scope.value,
          action,
        },
      },
    )
    if (body.redirect_url) {
      callbackUrl.value = body.redirect_url
    } else {
      submitError.value = body.error_description || body.error || 'Unexpected response from server'
    }
  } catch (err) {
    const e = err as { data?: { error_description?: string; error?: string }; message?: string }
    submitError.value = e?.data?.error_description || e?.data?.error || e?.message || 'Request failed'
  } finally {
    submitting.value = false
  }
}

/*
 * Validate the callback URL's scheme before opening (port of a sibling project's guard).
 * The redirect_uri is already validated server-side against the registered client
 * (loopback-only per RFC 8252), but defence-in-depth: never window.open a
 * javascript:/data:/file: URL rendered into the address bar.
 */
function isAllowedCallbackScheme(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin)
    if (parsed.protocol === 'https:') return true
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    if (parsed.protocol === 'http:' && /^(?:localhost|127\.\d+\.\d+\.\d+|::1)$/.test(host)) return true
    return false
  } catch {
    return false
  }
}

function openCallback() {
  if (!callbackUrl.value) return
  if (!isAllowedCallbackScheme(callbackUrl.value)) {
    submitError.value = 'Refusing to open callback URL with a disallowed scheme.'
    return
  }
  window.open(callbackUrl.value, '_blank', 'noopener,noreferrer')
}

async function copyCallbackUrl() {
  if (!callbackUrl.value) return
  try {
    await navigator.clipboard.writeText(callbackUrl.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    /* clipboard unavailable — the URL is selectable in the box */
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-calm p-4">
    <div class="w-full max-w-sm p-7 bg-white rounded-xl shadow-lg border border-calm-2">
      <div class="mb-5 text-center">
        <p class="text-[11px] font-bold uppercase tracking-[1.4px] text-brand-harmony">TokenScope</p>
        <h1 class="text-lg font-bold text-carbon mt-1">Authorize application</h1>
        <p class="mt-1 text-sm text-carbon-2">An MCP client wants to connect to your TokenScope account.</p>
      </div>

      <!-- Server-verified client identity — NEVER sourced from route.query
           (see loadClientInfo). "Self-registered, unverified" is honest: RFC
           7591 registration is open, so this is what the registrant CALLED
           itself, not a vetted identity. -->
      <div
        v-if="clientInfo"
        class="mb-4 rounded-lg border border-rag-amber/40 bg-rag-amber/10 px-3 py-2.5"
        data-testid="authorize-client-identity"
      >
        <p class="text-sm font-semibold text-carbon">{{ clientInfo.client_name }}</p>
        <p class="mt-0.5 text-[11px] text-[#92400E]">
          Self-registered, unverified — TokenScope hasn't vetted this application's identity.
          It will receive the authorization code at
          <span class="font-mono" data-testid="authorize-redirect-host">{{ clientInfo.redirect_host }}</span>.
        </p>
      </div>

      <div v-if="scopes.length" class="mb-5">
        <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-carbon-3">Requested permissions</p>
        <ul class="space-y-1.5">
          <li v-for="s in scopes" :key="s" class="flex items-start gap-2 rounded-md border border-calm-2 bg-calm px-3 py-2">
            <span class="mt-0.5 text-brand-harmony">✓</span>
            <span class="text-sm text-carbon">{{ scopeLabel(s) }}</span>
          </li>
        </ul>
      </div>

      <div v-if="paramError" class="mb-4 rounded-lg border border-rag-red/30 bg-rag-red/5 px-3 py-2.5 text-sm text-rag-red" data-testid="authorize-param-error">
        {{ paramError }}
      </div>
      <div v-else-if="clientInfoError" class="mb-4 rounded-lg border border-rag-red/30 bg-rag-red/5 px-3 py-2.5 text-sm text-rag-red" data-testid="authorize-client-info-error">
        {{ clientInfoError }}
      </div>
      <div v-else-if="submitError" class="mb-4 rounded-lg border border-rag-red/30 bg-rag-red/5 px-3 py-2.5 text-sm text-rag-red" role="alert">
        {{ submitError }}
      </div>

      <!-- Approved → show callback URL (Copy + try-open) -->
      <div v-else-if="callbackUrl && submitAction === 'approve'" class="space-y-3" data-testid="authorize-approved">
        <div class="rounded-lg border border-rag-green/30 bg-rag-green/5 p-3">
          <p class="text-sm font-semibold text-rag-green">Authorization approved</p>
          <p class="mt-1 text-xs text-carbon-2">Copy the URL below and paste it into your MCP client when prompted.</p>
        </div>
        <div class="relative rounded-lg border border-calm-2 bg-calm p-3">
          <button class="absolute right-2 top-2 rounded px-2 py-0.5 text-[11px] font-medium bg-calm-2 text-carbon-2 hover:bg-calm-3" data-testid="authorize-copy" @click="copyCallbackUrl">
            {{ copied ? 'Copied!' : 'Copy URL' }}
          </button>
          <p class="break-all pr-16 text-xs font-mono text-carbon-2">{{ callbackUrl }}</p>
        </div>
        <button class="block w-full text-center text-[11px] text-carbon-3 hover:text-carbon-2" @click="openCallback">
          Or try opening the callback in a new tab
        </button>
      </div>

      <!-- Denied -->
      <div v-else-if="callbackUrl && submitAction === 'deny'" class="rounded-lg border border-rag-red/30 bg-rag-red/5 p-3" data-testid="authorize-denied">
        <p class="text-sm font-semibold text-rag-red">Authorization denied.</p>
        <p class="mt-1 text-xs text-carbon-2">You may close this window.</p>
      </div>

      <!-- Consent buttons -->
      <div v-else class="flex gap-3">
        <UiButton kind="ghost" class="flex-1" :disabled="submitting" data-testid="authorize-deny" @click="handleSubmit('deny')">Deny</UiButton>
        <UiButton kind="primary" class="flex-1" :disabled="submitting" data-testid="authorize-approve" @click="handleSubmit('approve')">
          {{ submitting ? 'Authorizing…' : 'Approve' }}
        </UiButton>
      </div>

      <p class="mt-4 text-center text-[11px] text-carbon-3">You can revoke access any time from your account settings.</p>
    </div>
  </div>
</template>
