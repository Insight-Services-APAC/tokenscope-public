// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/tokenscope-project.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * tokenscope-project — the CLIENT-NEUTRAL per-repo project resolver + hasher.
 *
 * This module is the single SOURCE-OF-TRUTH for the four functions both clients
 * (Claude Code and Copilot CLI) must agree on so a committed `.tokenscope`
 * derives the SAME `project.code_hash` regardless of which client reads it:
 *
 *   - findTokenscopeFile(startDir) — walk up from cwd to the nearest `.tokenscope`.
 *   - parseTokenscope(filePath)    — parse the tiny YAML schema.
 *   - computeCodeHash(code)        — sha256(code) hex == the server's code_hash.
 *   - resolveRepoProjectCode({arg, cwd}) — arg or committed `.tokenscope` → code.
 *
 * It is DELIBERATELY self-contained (Node built-ins only, NO project imports) so
 * it can be vendored verbatim into copilot-plugin/scripts/ by
 * scripts/sync-copilot-plugin.mjs and gated by scripts/check-copilot-plugin-sync.mjs.
 * Drift between the two client copies = split attribution (the identical repo
 * derives different hashes on Claude vs Copilot). The Claude-coupled helpers
 * (writeRepoTag/mergeClaudeSettings/buildRepoResourceAttrs/writeTokenscopeFile)
 * stay in tag-repo.mjs — they pull on ~/.claude settings and must NOT ship here.
 *
 * YAML parser scope: we only need a flat `key: value` + a nested `project:` block
 * with three string fields. Avoiding the `yaml` npm dep keeps the plugin footprint
 * small (both plugins ship into user space).
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Walk up from `startDir` looking for a committed `.tokenscope`. Returns the
 * absolute path of the nearest one, or null if none is found up to the fs root.
 */
export function findTokenscopeFile(startDir) {
  let dir = resolve(startDir)
  const root = resolve('/')
  while (true) {
    const candidate = join(dir, '.tokenscope')
    if (existsSync(candidate)) return candidate
    if (dir === root) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Parse a `.tokenscope` file. Returns
 *   { project: { code?, id?, name? }, optional: { client?, practice?, engagement_type?, pm? } }.
 *
 * `project.*` fields are read ONLY from lines indented under a `project:` block;
 * `optional.*` fields are read from TOP-LEVEL keys. A bare one-liner therefore
 * yields `{ project: {}, optional: {} }` (no project.code) — callers must handle
 * the no-code case (resolveRepoProjectCode throws a clear error).
 */
export function parseTokenscope(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const out = { project: {}, optional: {} }
  let inProject = false

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '')
    if (line.trim() === '') continue
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(line)) {
      const key = line.split(':')[0]
      inProject = key === 'project'
      continue
    }
    const m = /^(\s*)([A-Za-z][A-Za-z0-9_-]*):\s*"?([^"]*?)"?\s*$/.exec(line)
    if (!m) continue
    const [, indent, key, value] = m
    if (indent.length > 0 && inProject) {
      if (key === 'code' || key === 'id' || key === 'name') {
        out.project[key] = value
      }
    } else if (indent.length === 0) {
      inProject = false
      if (
        key === 'client' ||
        key === 'practice' ||
        key === 'engagement_type' ||
        key === 'pm'
      ) {
        out.optional[key] = value
      }
    }
  }

  return out
}

/** sha256(code) plain hex — matches the server's project.code_hash exactly
 * (server: createHash('sha256').update(code).digest('hex')). The SINGLE shared
 * derivation is the only way Claude + Copilot agree on a repo's hash server-side. */
export function computeCodeHash(code) {
  return createHash('sha256').update(code).digest('hex')
}

/**
 * Resolve the repo's project CODE from an explicit arg or the committed
 * `.tokenscope` (walked up from cwd). Returns { code, source, tokenscopePath }.
 * Throws if no code can be resolved. No server call — the code is taken at face
 * value (the project is a membership-gated claim, validated server-side later).
 */
export function resolveRepoProjectCode({ arg, cwd }) {
  if (arg && arg.trim()) {
    return { code: arg.trim(), source: 'arg', tokenscopePath: null }
  }
  const tsPath = findTokenscopeFile(cwd)
  if (tsPath) {
    const fileData = parseTokenscope(tsPath)
    if (fileData?.project?.code) {
      return { code: fileData.project.code, source: 'tokenscope', tokenscopePath: tsPath }
    }
    throw new Error(`.tokenscope at ${tsPath} has no project.code — add one (the canonical project code).`)
  }
  throw new Error(
    'Could not resolve a project code — bind the repo via the project MCP prompt, or add a committed .tokenscope with project.code at the repo root.',
  )
}
