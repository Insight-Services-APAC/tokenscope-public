#!/usr/bin/env node
/*
 * classify-release.mjs — what a release changes for someone who deploys it.
 * Run by tools/publish/publish.sh between the last RELEASED tree and the new
 * one.
 *
 *   node scripts/classify-release.mjs --from <old tree> --to <new tree> [--version X.Y.Z --previous X.Y.Z]
 *
 * Prints JSON:
 *   validation  none | sandbox | full — the deployment validation this release
 *               needs, from the files it changes (not from its version number):
 *               deploy templates, example workflows and code that behaves
 *               differently behind Front Door need both documented postures;
 *               anything else in the image needs one deployment; prose, tests
 *               and the client plugins (not part of a deployment) need none. A
 *               change to the version field alone is not a change.
 *   breaking    changes a deployer must act on before upgrading: a removed
 *               infra/main.bicep parameter or output, a parameter that lost its
 *               default, a secrets variable the example parameter files stopped
 *               reading or newly require, a removed example workflow input.
 *   defaults    infra/main.bicep parameters whose default changed (not
 *               breaking, but they change deployments that rely on them).
 *   bump        the semver step between --previous and --version, if given,
 *               and `ok` false when breaking changes come without a major bump.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'

// First match wins. Paths are relative, '/'-separated.
const RULES = [
  [/^infra\//, 'full'],
  [/^examples\/.*\.ya?ml$/, 'full'],
  [/\.md$/, 'none'],
  [/^(docs|tests|plugin|copilot-plugin|\.github)\//, 'none'],
  [/^(LICENSE|NOTICE|\.gitignore|\.gitattributes|\.editorconfig|\.prettier.*|eslint\.config\.\w+)$/, 'none'],
]
// Anything else (app, server, shared, drizzle, Dockerfile, dependencies,
// scripts, tools) runs in the deployed image: one deployment.
const DEFAULT_TIER = 'sandbox'
// Code that behaves differently behind Front Door (Host and origin handling,
// the Front Door ID check) needs the Front Door posture, whatever its path.
const FRONT_DOOR_SENSITIVE = /FRONT_DOOR|frontDoor|x-azure-fdid|APP_PUBLIC_ORIGIN|appPublicOrigin|x-forwarded-host/i
const ORDER = { none: 0, sandbox: 1, full: 2 }

function files(root) {
  const out = new Map()
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.set(relative(root, p).split(sep).join('/'), createHash('sha256').update(readFileSync(p)).digest('hex'))
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

export function tierOf(path) {
  for (const [re, tier] of RULES) if (re.test(path)) return tier
  return DEFAULT_TIER
}

const read = (root, f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')

// package.json / package-lock.json differing only in their own version fields.
function versionOnly(from, to, f) {
  if (f !== 'package.json' && f !== 'package-lock.json') return false
  try {
    const strip = (t) => {
      const j = JSON.parse(t)
      delete j.version
      if (j.packages?.['']) delete j.packages[''].version
      return JSON.stringify(j)
    }
    return strip(read(from, f)) === strip(read(to, f))
  } catch {
    return false
  }
}

function tierOfChange(from, to, f) {
  if (versionOnly(from, to, f)) return 'none'
  const t = tierOf(f)
  if (t === 'sandbox' && /\.(ts|js|mjs|vue)$/.test(f) && (FRONT_DOOR_SENSITIVE.test(read(from, f)) || FRONT_DOOR_SENSITIVE.test(read(to, f)))) {
    return 'full'
  }
  return t
}

function bicepContract(text) {
  const params = new Map() // name -> default text, or null when required
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s*\/\/.*$/, '')
    const m = line.match(/^param\s+(\w+)\s+(.+?)\s*$/)
    if (!m) continue
    const eq = m[2].indexOf('=')
    const type = (eq < 0 ? m[2] : m[2].slice(0, eq)).trim()
    const dflt = eq < 0 ? null : m[2].slice(eq + 1).trim()
    params.set(m[1], dflt ?? (type.endsWith('?') ? 'null' : null))
  }
  const outputs = new Set([...text.matchAll(/^output\s+(\w+)/gm)].map((m) => m[1]))
  return { params, outputs }
}

// Variables the example parameter files read: name -> true when required
// (no fallback argument).
function envReads(root) {
  const dir = join(root, 'infra/parameters')
  const out = new Map()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((n) => /^example-.*\.bicepparam$/.test(n))) {
    for (const m of read(dir, f).matchAll(/readEnvironmentVariable\('([A-Z0-9_]+)'\s*(,)?/g)) {
      out.set(m[1], (out.get(m[1]) ?? false) || !m[2])
    }
  }
  return out
}

// Inputs of every trigger in the example workflows, as "<file> <trigger>.<input>".
function workflowInputs(root) {
  const dir = join(root, 'examples/github-actions')
  const out = new Set()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    let trigger = null
    let inInputs = false
    for (const line of read(dir, f).split('\n')) {
      const t = line.match(/^ {2}(\w+):\s*$/)
      if (t) { trigger = t[1]; inInputs = false; continue }
      if (/^\S/.test(line)) { trigger = null; inInputs = false; continue }
      if (trigger && /^ {4}inputs:\s*$/.test(line)) { inInputs = true; continue }
      if (inInputs && /^ {4}\S/.test(line)) inInputs = false
      const i = inInputs && line.match(/^ {6}([\w-]+):/)
      if (i) out.add(`${f} ${trigger}.${i[1]}`)
    }
  }
  return out
}

export function breakingChanges(from, to) {
  const out = []
  const a = bicepContract(read(from, 'infra/main.bicep'))
  const b = bicepContract(read(to, 'infra/main.bicep'))
  for (const p of a.params.keys()) if (!b.params.has(p)) out.push(`infra/main.bicep parameter "${p}" removed`)
  for (const [p, d] of b.params) {
    if (d === null && (!a.params.has(p) || a.params.get(p) !== null)) out.push(`infra/main.bicep parameter "${p}" is now required`)
  }
  for (const o of a.outputs) if (!b.outputs.has(o)) out.push(`infra/main.bicep output "${o}" removed`)
  const ea = envReads(from)
  const eb = envReads(to)
  for (const v of ea.keys()) if (!eb.has(v)) out.push(`secrets variable ${v} is no longer read by the example parameter files`)
  for (const [v, required] of eb) {
    if (required && !ea.get(v)) out.push(`secrets variable ${v} is now required by the example parameter files`)
  }
  const wa = workflowInputs(from)
  const wb = workflowInputs(to)
  for (const i of wa) if (!wb.has(i)) out.push(`example workflow input ${i} removed`)
  return out
}

export function changedDefaults(from, to) {
  const a = bicepContract(read(from, 'infra/main.bicep')).params
  const b = bicepContract(read(to, 'infra/main.bicep')).params
  return [...b].filter(([p, d]) => a.has(p) && a.get(p) !== null && d !== null && a.get(p) !== d)
    .map(([p, d]) => `infra/main.bicep parameter "${p}" default ${a.get(p)} -> ${d}`)
}

export function bumpOf(previous, version) {
  const p = previous.split('.').map(Number)
  const v = version.split('.').map(Number)
  if (v.length !== 3 || p.length !== 3 || [...v, ...p].some((n) => !Number.isInteger(n))) return 'invalid'
  if (v[0] > p[0]) return v[1] === 0 && v[2] === 0 ? 'major' : 'invalid'
  if (v[0] < p[0]) return 'invalid'
  if (v[1] > p[1]) return v[2] === 0 ? 'minor' : 'invalid'
  if (v[1] < p[1]) return 'invalid'
  return v[2] > p[2] ? 'patch' : 'invalid'
}

export function classify(from, to, { version, previous } = {}) {
  const a = files(from)
  const b = files(to)
  const changed = [...new Set([...a.keys(), ...b.keys()])].filter((f) => a.get(f) !== b.get(f)).sort()
  let validation = 'none'
  const reasons = []
  for (const f of changed) {
    const t = tierOfChange(from, to, f)
    if (ORDER[t] > ORDER[validation]) validation = t
    if (t !== 'none') reasons.push(`${f} → ${t}`)
  }
  const breaking = breakingChanges(from, to)
  const result = { changed: changed.length, validation, reasons, breaking, defaults: changedDefaults(from, to) }
  if (version && previous) {
    const bump = previous === '0.0.0' ? 'first' : bumpOf(previous, version)
    result.bump = bump
    result.ok = bump !== 'invalid' && (breaking.length === 0 || bump === 'major' || bump === 'first')
  }
  return result
}

function main() {
  const arg = (n) => {
    const i = process.argv.indexOf(n)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const from = arg('--from')
  const to = arg('--to')
  if (!from || !to) {
    console.error('usage: classify-release.mjs --from <old tree> --to <new tree> [--version X.Y.Z --previous X.Y.Z]')
    process.exit(64)
  }
  console.log(JSON.stringify(classify(from, to, { version: arg('--version'), previous: arg('--previous') }), null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) main()
