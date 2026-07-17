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
    // Copilot plugin-runtime scripts (statusline, status, redeem) and dev/ops
    // scripts. Their contract IS to write to stdout (JSON for the host to read,
    // or human progress output) — `consola` is neither available nor wanted
    // here, so `console` is the correct and intended interface.
    files: ['plugin/scripts/**', 'copilot-plugin/scripts/**', 'scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
)
