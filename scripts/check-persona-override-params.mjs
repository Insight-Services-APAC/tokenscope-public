#!/usr/bin/env node
/*
 * CI guard: a bicepparam may set allowPersonaOverride=true ONLY when its own
 * `param env` is 'sandbox'. (Since 2026-08-13 no deployable sandbox parameter
 * file exists — `infra/parameters/sandbox.bicepparam` was deleted with the
 * workflow option lists — so today the only file this permits is the
 * `example-sandbox.bicepparam` template shipped for self-hosters.)
 *
 * The persona gate is allowlist-gated in code (only {local, sandbox} are
 * demo-capable; shared/env/deploy-env.ts), so a stray allowPersonaOverride=true on
 * a deployed env is already inert — but this check fails the build LOUDLY so the
 * misconfig is caught at PR time rather than relied on being neutralized at runtime.
 * It is the "single trust root" assertion: demo-capable infra config and the code
 * allowlist must agree.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PARAMS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'parameters')
// The only DEPLOYABLE demo-capable env. This is the deploy-target subset of the
// shared {local, sandbox} allowlist (shared/env/deploy-env.ts) — 'local' is not a
// deploy target, so 'sandbox' is the sole value a bicepparam may carry here.
const ALLOWED_DEMO_ENVS = new Set(['sandbox'])

/** Effective (non-comment) value of `param <name> = ...`, or null. */
function paramValue(body, name) {
  const line = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .find((l) => new RegExp(`^\\s*param\\s+${name}\\s*=`).test(l))
  if (!line) return null
  const m = line.match(/=\s*'([^']*)'/) // string value
  if (m) return m[1]
  const b = line.match(/=\s*(true|false)\b/) // bool value
  return b ? b[1] : null
}

let failed = false
for (const file of readdirSync(PARAMS_DIR).filter((f) => f.endsWith('.bicepparam'))) {
  const body = readFileSync(join(PARAMS_DIR, file), 'utf8')
  const on = paramValue(body, 'allowPersonaOverride') === 'true'
  // Cross-check against the EFFECTIVE `param env` value (the deploy identity),
  // NOT the filename — so a file whose env param disagrees with its name can't slip
  // a demo-capable flag through.
  const env = paramValue(body, 'env')
  if (on && env !== null && !ALLOWED_DEMO_ENVS.has(env)) {
    console.error(`✗ ${file}: allowPersonaOverride=true with env='${env}' — only env='sandbox' may be demo-capable.`)
    failed = true
  }
  if (on && env === null) {
    console.error(`✗ ${file}: allowPersonaOverride=true but no \`param env\` to verify against — refuse to assume.`)
    failed = true
  }
}

if (failed) {
  console.error("\nallowPersonaOverride may be true ONLY in a bicepparam whose `param env` is 'sandbox'.")
  process.exit(1)
}
process.stdout.write('✓ allowPersonaOverride params consistent with the demo-capable allowlist (sandbox only).\n')
