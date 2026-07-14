import { describe, it, expect } from 'vitest'
import {
  classifyDeployEnv,
  isDemoCapableEnv,
  type DeployEnv,
} from '../../../shared/env/deploy-env'

describe('classifyDeployEnv', () => {
  // [label, input, expected classification, expected demo-capable]
  const cases: Array<[string, Parameters<typeof classifyDeployEnv>[0], DeployEnv, boolean]> = [
    // Named envs win and classify literally.
    ['local', { deployEnv: 'local' }, 'local', true],
    ['sandbox', { deployEnv: 'sandbox' }, 'sandbox', true],
    ['dev', { deployEnv: 'dev' }, 'dev', false],
    ['staging', { deployEnv: 'staging' }, 'staging', false],
    ['production', { deployEnv: 'production' }, 'production', false],
    ['prod alias → production', { deployEnv: 'prod' }, 'production', false],
    ['case + whitespace tolerant', { deployEnv: '  DEV  ' }, 'dev', false],
    ['SANDBOX uppercase', { deployEnv: 'SANDBOX' }, 'sandbox', true],

    // Unrecognized non-empty → unknown (fail closed).
    ['garbage → unknown', { deployEnv: 'garbage' }, 'unknown', false],
    ['typo "sandboxx" → unknown', { deployEnv: 'sandboxx' }, 'unknown', false],

    // Empty deployEnv: the dropped-env fail-closed rule. NO flag can rescue a
    // deployed container — the classifier consults only deployEnv + NODE_ENV.
    ['empty + NODE_ENV=production → unknown (DROPPED ENV FAILS CLOSED)', { deployEnv: '', nodeEnv: 'production' }, 'unknown', false],
    ['unset + NODE_ENV=production → unknown', { nodeEnv: 'production' }, 'unknown', false],
    ['empty + NODE_ENV=test → local', { deployEnv: '', nodeEnv: 'test' }, 'local', true],
    ['empty + NODE_ENV=development → local', { deployEnv: '', nodeEnv: 'development' }, 'local', true],
    ['empty + no nodeEnv → local (developer box)', {}, 'local', true],
    // A genuine local production-mode build must opt in EXPLICITLY (no flag inference).
    ['explicit local even on NODE_ENV=production → local', { deployEnv: 'local', nodeEnv: 'production' }, 'local', true],
  ]

  for (const [label, input, expected, demo] of cases) {
    it(`${label} → ${expected} (demo-capable=${demo})`, () => {
      const got = classifyDeployEnv(input)
      expect(got).toBe(expected)
      expect(isDemoCapableEnv(got)).toBe(demo)
    })
  }
})

describe('isDemoCapableEnv — only {local, sandbox}', () => {
  it('allows exactly local and sandbox', () => {
    expect(isDemoCapableEnv('local')).toBe(true)
    expect(isDemoCapableEnv('sandbox')).toBe(true)
  })
  it('refuses dev, staging, production, unknown', () => {
    for (const e of ['dev', 'staging', 'production', 'unknown'] as DeployEnv[]) {
      expect(isDemoCapableEnv(e)).toBe(false)
    }
  })
})
