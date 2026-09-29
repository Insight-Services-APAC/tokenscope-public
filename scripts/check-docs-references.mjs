#!/usr/bin/env node
/*
 * check-docs-references.mjs — CI guard, also run by tools/publish/publish.sh
 * against the substituted public snapshot.
 *
 * Every reference a user-facing doc makes must resolve in the tree it ships in:
 * `npm run` scripts, repo paths and markdown links, Bicep parameters/outputs
 * named in the deploy docs, NUXT_/TOKENSCOPE_ variables, the secrets-file
 * variables the example parameter files read, and provider credential names the
 * template actually wires, and every secret the example workflows pass on is
 * read by an example parameter file. Drift between these and the code is what broke the
 * public docs (docs/DEPLOY-AZURE.md §Troubleshooting has the history).
 *
 *   node scripts/check-docs-references.mjs [--root <dir>]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_DIRS = ['app', 'server', 'shared', 'drizzle', 'infra', 'scripts', 'tools', 'tests', 'docs', 'examples', 'plugin', 'copilot-plugin', '.github']
const CODE_DIRS = ['server', 'shared', 'app', 'drizzle', 'infra', 'scripts', 'plugin', 'copilot-plugin', 'examples', 'tools']
const CODE_FILES = ['nuxt.config.ts', '.env.example', 'entrypoint.sh', 'Dockerfile', 'docker-compose.yml']
const SECRET_VAR = /^(PG_ADMIN_|SESSION_SECRET|HMAC_SESSION_KEY|INTERNAL_WORKER_HMAC_KEY|OIDC_|ENTRA_CLIENT_SECRET|ANTHROPIC_API_KEY|GH_PAT_|GH_APP_KEY_|GITHUB_PAT_|GITHUB_APP_KEY_)[A-Z0-9_]*$/
const DEPLOY_DOCS = ['docs/DEPLOY-AZURE.md', 'examples/github-actions/README.md']
const BICEP_FUNCTIONS = new Set(['readEnvironmentVariable', 'fail', 'resourceGroup', 'subscription'])
// A deliberate exception (a file the reader creates, a path in another repo) is
// marked on the line itself or the line above, so it stays visible in review.
const IGNORE = '<!-- docs-check: ignore'

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.output' || e.name === '.nuxt') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}

/** The user-facing docs this guard covers, relative to root. */
export function docFiles(root) {
  const md = (p) => p.endsWith('.md')
  const top = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md'].filter((f) => existsSync(join(root, f)))
  const docs = existsSync(join(root, 'docs'))
    ? readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)
    : []
  const nested = [
    ...walk(join(root, 'docs/wiki'), md),
    ...walk(join(root, 'examples'), md),
    ...walk(join(root, 'plugin/commands'), md),
    ...walk(join(root, 'copilot-plugin/skills'), (p) => p.endsWith('SKILL.md')),
    ...walk(join(root, 'infra/parameters'), (p) => /example-.*\.bicepparam$/.test(p)),
  ].map((p) => relative(root, p).split(sep).join('/'))
  const extra = ['plugin/README.md', 'tests/deploy/README.md'].filter((f) => existsSync(join(root, f)))
  // Files the publish drops are not user-facing; skip them in the source tree.
  const listFile = join(root, 'tools/publish/internal-only-paths.txt')
  const internal = existsSync(listFile)
    ? readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : []
  const isInternal = (f) => internal.some((pre) => f === pre || f.startsWith(pre.endsWith('/') ? pre : `${pre}/`))
  return [...new Set([...top, ...docs, ...nested, ...extra])].filter((f) => !isInternal(f)).sort()
}

/** What the tree offers: npm scripts, Bicep params/outputs, code text, secret reads, wired credentials. */
export function buildContext(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const main = existsSync(join(root, 'infra/main.bicep')) ? readFileSync(join(root, 'infra/main.bicep'), 'utf8') : ''
  const bicepNames = new Set([...main.matchAll(/^(?:param|output)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]))
  const codeText = [
    ...CODE_DIRS.flatMap((d) => walk(join(root, d), (p) => /\.(ts|mjs|js|vue|sh|bicep|bicepparam|yml|yaml|json|py)$/.test(p))),
    ...CODE_FILES.map((f) => join(root, f)).filter((f) => existsSync(f)),
  ].map((f) => readFileSync(f, 'utf8')).join('\n')
  // Only a parameter file reading a variable gets it into the deployment; a
  // workflow mapping a secret into the environment does not.
  const readsEnv = new Set(
    walk(join(root, 'infra/parameters'), (p) => /example-.*\.bicepparam$/.test(p))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/readEnvironmentVariable\('([A-Z0-9_]+)'/g)])
      .map((m) => m[1]),
  )
  const containerApp = existsSync(join(root, 'infra/modules/container-app.bicep'))
    ? readFileSync(join(root, 'infra/modules/container-app.bicep'), 'utf8')
    : ''
  const wiredKeys = new Set([...containerApp.matchAll(/'(NUXT_(?:ANTHROPIC_KEY|GITHUB_PAT|GITHUB_APP_KEY)_[A-Z0-9_]+)'/g)].map((m) => m[1]))
  return { scripts: new Set(Object.keys(pkg.scripts ?? {})), bicepNames, codeText, readsEnv, wiredKeys }
}

function cleanPath(raw) {
  return raw.replace(/[#§].*$/, '').replace(/:\d+(-\d+)?$/, '').replace(/[.,;:)]+$/, '')
}

/** Problems in one doc: [{ line, message }]. */
export function checkDoc(root, file, ctx) {
  const text = readFileSync(join(root, file), 'utf8')
  const problems = []
  const lines = text.split('\n')
  const isDeployDoc = DEPLOY_DOCS.includes(file)
  const exists = (p) => existsSync(join(root, p)) || existsSync(join(root, dirname(file), p))
  lines.forEach((line, i) => {
    const n = i + 1
    if (line.includes(IGNORE) || (i > 0 && lines[i - 1].includes(IGNORE))) return
    for (const m of line.matchAll(/npm run (?:-s )?([a-z0-9][a-z0-9:_-]*)(\*)?/g)) {
      if (m[2]) continue // a pattern such as test:*
      if (!ctx.scripts.has(m[1])) problems.push({ line: n, message: `npm script "${m[1]}" does not exist` })
    }
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]
      if (/^(https?:|mailto:|#)/.test(target) || target.includes('<')) continue
      const p = cleanPath(target.split('#')[0])
      if (!p) continue
      if (!existsSync(resolve(join(root, dirname(file)), p))) problems.push({ line: n, message: `link target "${target}" does not exist` })
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim()
      // repo path
      const pm = tok.match(/^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*<>{}-]+)+\/?)/)
      if (pm && REPO_DIRS.includes(pm[1].split('/')[0]) && !/[<*{$]|\.\.\./.test(pm[1]) && !tok.includes(' ')) {
        const p = cleanPath(pm[1])
        // A trailing `_` names a prefix (e.g. a migration number), not a file.
        if (!p.endsWith('_') && !exists(p)) problems.push({ line: n, message: `path "${p}" does not exist` })
      }
      // our env vars
      for (const v of tok.matchAll(/\b((?:NUXT|TOKENSCOPE)_[A-Z0-9_]+)\b/g)) {
        if (!v[1].endsWith('_') && !new RegExp(`\\b${v[1]}\\b`).test(ctx.codeText)) {
          problems.push({ line: n, message: `variable ${v[1]} is not mentioned anywhere in the code or config` })
        }
      }
      if (!isDeployDoc) continue
      // secrets-file variables the example parameter files / workflows must read
      if (SECRET_VAR.test(tok) && !tok.startsWith('GITHUB_') && !ctx.readsEnv.has(tok)) {
        problems.push({ line: n, message: `secrets variable ${tok} is not read by the example parameter files` })
      }
      // Bicep parameters/outputs: `name = ...` or a bare camelCase identifier
      const assign = tok.match(/^([a-z][A-Za-z0-9]+)\s*=/)
      const bare = tok.match(/^([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)$/)
      const name = (assign ?? bare)?.[1]
      if (name && !BICEP_FUNCTIONS.has(name) && !ctx.bicepNames.has(name)) problems.push({ line: n, message: `"${name}" is not a parameter or output of infra/main.bicep` })
    }
    if (isDeployDoc) {
      // Provider credential names must map to a key the template wires. The
      // phrase can wrap, so it is matched against this line joined with the next.
      const joined = `${line} ${lines[i + 1] ?? ''}`.replace(/\s+/g, ' ')
      const creds = [...joined.matchAll(/credential name `([a-z0-9-]+)`/g)]
        .filter((m) => m.index < line.replace(/\s+/g, ' ').length)
        .map((m) => m[1])
      const row = line.match(/^\s*\|\s*`((?:GH_PAT|GH_APP_KEY)_[A-Z0-9_]+)`[^|]*\|\s*`([a-z0-9-]+)`\s*\|/)
      if (row) creds.push(row[2])
      for (const c of creds) {
        const up = c.toUpperCase().replace(/-/g, '_')
        const keys = [`NUXT_ANTHROPIC_KEY_${up}`, `NUXT_GITHUB_PAT_${up}`, `NUXT_GITHUB_APP_KEY_${up}`]
        if (!keys.some((k) => ctx.wiredKeys.has(k))) {
          problems.push({ line: n, message: `credential name "${c}" maps to no key the template wires (${keys[0]} / ${keys[1]})` })
        }
      }
    }
  })
  return problems
}

/** Secrets the example workflows hand to the deployment must be read by a parameter file. */
export function checkWorkflows(root, ctx) {
  return walk(join(root, 'examples'), (p) => /\.ya?ml$/.test(p)).flatMap((f) => {
    const file = relative(root, f).split(sep).join('/')
    return readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      [...line.matchAll(/secrets\.([A-Z0-9_]+)/g)]
        .map((m) => m[1])
        .filter((v) => SECRET_VAR.test(v) && !v.startsWith('GITHUB_') && !ctx.readsEnv.has(v))
        .map((v) => ({ file, line: i + 1, message: `secret ${v} is passed to the deployment but no example parameter file reads it` })),
    )
  })
}

export function checkTree(root) {
  const ctx = buildContext(root)
  return [...docFiles(root).flatMap((f) => checkDoc(root, f, ctx).map((p) => ({ file: f, ...p }))), ...checkWorkflows(root, ctx)]
}

function main() {
  const i = process.argv.indexOf('--root')
  const root = resolve(i > 0 ? process.argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..'))
  if (!statSync(root).isDirectory()) {
    console.error(`not a directory: ${root}`)
    process.exit(2)
  }
  const problems = checkTree(root)
  for (const p of problems) console.error(`✗ ${p.file}:${p.line}: ${p.message}`)
  if (problems.length) {
    console.error(`\n${problems.length} doc reference(s) do not resolve in ${root}`)
    process.exit(1)
  }
  console.log(`✓ doc references resolve (${docFiles(root).length} docs, ${root})`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
