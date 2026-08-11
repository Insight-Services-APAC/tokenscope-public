/*
 * command-frontmatter — S1 fix 8: narrow command grants + safe $ARGUMENTS
 * interpolation.
 *
 * A slash command's `allowed-tools: Bash(node:*)` lets the MODEL run ANY
 * node invocation, not just the one the command documents — a hostile repo
 * that gets its own text into the model's context (a comment, a README, an
 * injected instruction) could steer it to run something else entirely under
 * the SAME grant. Every command must narrow its grant to the ONE script it
 * actually runs.
 *
 * Within a command's fenced bash block, `$ARGUMENTS` must be interpolated
 * SAFELY for what the target script expects:
 *   - a script that takes MULTIPLE space-separated flags (backfill.mjs, whose
 *     own parseArgs already rejects an unrecognised flag) needs $ARGUMENTS
 *     BARE/unquoted so the shell splits it into separate argv tokens —
 *     quoting it (statusline.md's shape) would pass the whole thing as ONE
 *     token and break multi-flag use. This is a DOCUMENTED, deliberate
 *     exception, not an oversight.
 *   - a script that takes at most ONE value (statusline-toggle.mjs: on/off)
 *     must double-quote it so a value is never re-split/globbed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Vitest runs with cwd at the repo root (see version-sync.test.ts / claude-redeem.test.ts).
const COMMANDS_DIR = join(process.cwd(), 'plugin/commands')

function parseFrontmatter(content: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

/** Every ```bash ... ``` fenced block's raw content, concatenated. */
function fencedBashBlocks(content: string): string[] {
  return [...content.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
}

const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'))

describe('command-frontmatter — allowed-tools is never the blanket Bash(node:*) grant', () => {
  it.each(commandFiles)('%s does not grant bare Bash(node:*)', (file) => {
    const content = readFileSync(join(COMMANDS_DIR, file), 'utf8')
    const fm = parseFrontmatter(content)
    expect(fm['allowed-tools'], `${file} has no allowed-tools frontmatter`).toBeDefined()
    // A bare Bash(node:*) entry (optionally comma-separated with others) —
    // reject it as a whole entry, not merely as a substring (a narrowed grant
    // like Bash(node "${CLAUDE_PLUGIN_ROOT}/...":*) legitimately CONTAINS the
    // substring "Bash(node" and must not be flagged).
    const entries = (fm['allowed-tools'] ?? '').split(',').map((s) => s.trim())
    expect(entries, `${file}'s allowed-tools grants bare Bash(node:*)`).not.toContain('Bash(node:*)')
  })

  it('every command narrows to a SPECIFIC script path, not just "not the blanket grant"', () => {
    for (const file of commandFiles) {
      const content = readFileSync(join(COMMANDS_DIR, file), 'utf8')
      const fm = parseFrontmatter(content)
      const bashEntries = (fm['allowed-tools'] ?? '').split(',').map((s) => s.trim()).filter((e) => e.startsWith('Bash('))
      for (const entry of bashEntries) {
        expect(entry, `${file}'s Bash grant "${entry}" does not name a specific script`).toMatch(
          /Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w.-]+\.mjs":\*\)/,
        )
      }
    }
  })
})

describe('command-frontmatter — $ARGUMENTS is never interpolated unsafely for its target script', () => {
  // The ONE documented exception: backfill.mjs takes MULTIPLE space-separated
  // flags and its own parseArgs rejects an unrecognised one — bare/unquoted
  // $ARGUMENTS is REQUIRED there (quoting would break multi-flag use).
  const ALLOWS_BARE_ARGUMENTS = new Set(['backfill.md'])

  it.each(commandFiles)('%s: $ARGUMENTS in a fenced bash block is either double-quoted, or the documented bare exception', (file) => {
    const content = readFileSync(join(COMMANDS_DIR, file), 'utf8')
    for (const block of fencedBashBlocks(content)) {
      if (!block.includes('$ARGUMENTS')) continue
      const bareUsage = /(?<!")\$ARGUMENTS(?!")/.test(block) && !block.includes('"$ARGUMENTS"')
      if (bareUsage) {
        expect(ALLOWS_BARE_ARGUMENTS.has(file), `${file} interpolates $ARGUMENTS unquoted but is not the documented backfill.md exception`).toBe(true)
      }
    }
  })

  it('backfill.md really is bare (multi-flag) — a regression pin so "fixing" it to quoted silently breaks multi-flag use', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'backfill.md'), 'utf8')
    const [block] = fencedBashBlocks(content)
    expect(block).toContain(' $ARGUMENTS')
    expect(block).not.toContain('"$ARGUMENTS"')
  })

  it('statusline.md is double-quoted (a single on/off value, never split/globbed)', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'statusline.md'), 'utf8')
    const [block] = fencedBashBlocks(content)
    expect(block).toContain('"$ARGUMENTS"')
  })
})

describe('command-frontmatter — setup.md step 4 is a FIXED command, not the old "authoritative tool response" prose', () => {
  it('the documented redeem invocation passes only --handoff-code — never --redeem-url or --api-base', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'setup.md'), 'utf8')
    const [block] = fencedBashBlocks(content)
    expect(block, 'setup.md has no fenced bash block for the redeem command').toBeDefined()
    expect(block).toContain('--handoff-code')
    expect(block).not.toContain('--redeem-url')
    expect(block).not.toContain('--api-base')
  })

  it('no longer defers to "the tool response is the authoritative command"', () => {
    const content = readFileSync(join(COMMANDS_DIR, 'setup.md'), 'utf8')
    expect(content).not.toMatch(/authoritative command/i)
  })
})
