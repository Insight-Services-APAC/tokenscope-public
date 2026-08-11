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
     */
    poolOptions: {
      forks: { maxForks: Number(process.env.VITEST_MAX_FORKS) || 4 },
    },
    // Each integration test file spins up its own testcontainers Postgres
    // (slow startup, ~5-10 s); allow plenty of room for the hook + tests.
    hookTimeout: 180_000,
    testTimeout: 60_000,
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
