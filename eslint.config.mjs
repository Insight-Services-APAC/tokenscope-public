// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  // Spike prototypes and captured evidence in docs/background/ are not
  // production code — exclude from lint to avoid false-positive gate failures.
  { ignores: ['docs/background/**'] },
  {
    rules: {
      // Project §Coding standards: never `console.log` — `consola` only.
      // Plugin scripts (plugin/scripts/*.mjs) disable per-file because
      // their contract is to write JSON to stdout for Claude to read.
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // AGENTS.md §Coding standards rule 9: no `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
