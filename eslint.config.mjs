// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // Spike prototypes and captured evidence in docs/background/ are not
  // production code — exclude from lint to avoid false-positive gate failures.
  // Generated files (*.gen.ts) carry a blanket `/* eslint-disable */` emitted by
  // their generator and must NEVER be hand-edited — ignore them so lint (and its
  // --fix) can't mangle the generated content out of sync with the generator.
  { ignores: ['docs/background/**', '**/*.gen.ts'] },
  {
    rules: {
      // Project §Coding standards: never `console.log` — `consola` only.
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // AGENTS.md §Coding standards rule 9: no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Standalone CLI executables that run OUTSIDE the Nuxt app: Claude Code /
    // Copilot plugin-runtime scripts (statusline, status, redeem), dev/ops
    // scripts, and the dev-stack tools. Their contract IS to write to stdout
    // (JSON for the host to read, or human progress output) — `consola` is
    // neither available nor wanted here, so `console` is the correct and
    // intended interface.
    //
    // `tools/**` belongs to this set for the same reason and was simply
    // omitted: they are standalone CLI utilities and local dev-stack
    // containers (fake-azure-monitor, synthetic-anthropic-api,
    // mutation-sweep, the OTLP capture server) that never load the Nitro
    // runtime, so they cannot import consola. Leaving them out produced 12
    // permanently-unfixable warnings that trained readers to ignore lint
    // output — the rule was reporting a violation of a convention that does
    // not apply to those files.
    files: ['plugin/scripts/**', 'copilot-plugin/scripts/**', 'scripts/**', 'tools/**'],
    rules: {
      'no-console': 'off',
    },
  },
)
