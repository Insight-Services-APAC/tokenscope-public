import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'lib/**/__tests__/**/*.test.ts',
      'server/**/__tests__/**/*.test.ts',
      'shared/**/__tests__/**/*.test.ts',
    ],
    /*
     * CONTAINER CONCURRENCY IS A MEMORY BUDGET, NOT A SPEED KNOB.
     *
     * 205 test files each start their own testcontainers Postgres. Vitest's
     * default forks pool runs as many files in parallel as there are cores, so
     * an unbounded run holds that many postgres containers at once — and several
     * agents running suites concurrently multiplies it again. On 2026-08-02 that
     * exhausted the host, the OOM killer took vitest mid-run, and the containers
     * it had not yet stopped leaked (see tests/integration/helpers/db.ts).
     *
     * Cap it. Override with VITEST_MAX_FORKS on a machine with room to spare.
     *
     * TOP-LEVEL `maxWorkers`, NOT `poolOptions.forks.maxForks`. Vitest 4 removed
     * `poolOptions` and the cap above silently stopped applying — every run
     * printed a DEPRECATED line nobody read, and on 2026-09-01 the integration
     * suite ran 11 forks wide on a 6-core devcontainer against one shared
     * Postgres, which is how a 5-second timing assertion measured 32 minutes.
     */
    // Fails the run if any test wrote the developer's real enrolment files.
    globalSetup: ['tests/helpers/real-device-guard.ts'],
    maxWorkers: Number(process.env.VITEST_MAX_FORKS) || 4,
    // Each integration test file spins up its own testcontainers Postgres
    // (slow startup, ~5-10 s); allow plenty of room for the hook + tests.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    /*
     * nuxt-oidc-auth's runtime must go through Vite's transform, not Node's
     * native ESM resolver. Since 1.0.0-beta.12 `utils/redirect.js` imports
     * Nuxt's `#imports`, which Node resolves against the PACKAGE's own
     * `imports` field and cannot find — an externalised dep never sees the
     * `#imports` alias below. Inlining is what makes that alias apply.
     */
    server: {
      deps: {
        inline: [/nuxt-oidc-auth/],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['lib/**', 'server/**', 'app/**', 'shared/**'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '~': new URL('./app', import.meta.url).pathname,
      '~~': new URL('.', import.meta.url).pathname,
      // Nuxt 4 auto-aliases `#shared` → the repo-root `shared/` dir in the app
      // build; Vitest has no Nuxt resolver, so mirror it here (e.g.
      // `#shared/reports/types` → `./shared/reports/types`).
      '#shared': new URL('./shared', import.meta.url).pathname,
      // Nuxt's `#imports` virtual module resolves only inside a Nuxt build.
      // nuxt-oidc-auth's runtime and one app composable import it; point them
      // at a stub so a deep-import test can load the real module under test.
      '#imports': new URL(
        './tests/helpers/nuxt-imports-stub.ts',
        import.meta.url,
      ).pathname,
      // nuxt-oidc-auth's runtime uses Nuxt's `#imports` virtual module
      // which only resolves inside a Nuxt build. In Vitest we point the
      // import at a stub that returns null sessions; the actual auth
      // resolution is bypassed in tests via injectTestSession (which
      // pre-populates event.context['__tokenscope_session'] so tryAuth's
      // fast-path returns before calling getUserSession).
      'nuxt-oidc-auth/runtime/server/utils/session.js': new URL(
        './tests/helpers/nuxt-oidc-auth-stub.ts',
        import.meta.url,
      ).pathname,
    },
  },
})
