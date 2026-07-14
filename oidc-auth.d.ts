/*
 * Local type augmentation for nuxt-oidc-auth.
 *
 * Wave-V (R1 F2 follow-on) — the upstream module ships
 * `dist/runtime/augments.app.d.ts` which declares the `#imports` extension
 * for `useOidcAuth`, but vue-tsc doesn't pick it up because the file isn't
 * inside any tsconfig.app.json `include` glob (node_modules paths aren't
 * traversed for ambient declarations under moduleResolution=Bundler).
 *
 * We re-declare the minimal slice the app actually uses. Keep the shape
 * in sync with `node_modules/nuxt-oidc-auth/dist/runtime/composables/
 * oidcAuth.d.ts` — re-check on every nuxt-oidc-auth version bump (the
 * package.json pin to `1.0.0-beta.11` exact is the upstream version this
 * matches).
 */
declare module '#imports' {
  export function useOidcAuth(): {
    loggedIn: import('vue').ComputedRef<boolean>
    user: import('vue').ComputedRef<unknown>
    currentProvider: import('vue').ComputedRef<string | undefined>
    fetch: () => Promise<void>
    refresh: () => Promise<void>
    login: (provider?: string | 'dev', params?: Record<string, string>) => Promise<void>
    logout: (provider?: string | 'dev', logoutRedirectUri?: string) => Promise<void>
    clear: () => Promise<void>
  }
}

export {}
