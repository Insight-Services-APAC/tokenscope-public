/*
 * Revoke-confirm and grant-attestation invariants (S6).
 *
 * WHY SOURCE-LEVEL rather than a mount: the invariant being protected is
 * "client-authored text never reaches a native confirm() dialog", and that is a
 * property of the CALL SITE, not of any rendered output. A mount test asserts
 * what one fixture renders; this asserts that no future edit can reintroduce the
 * interpolation at all — including on a code path a fixture does not exercise.
 * Same shape as tests/unit/plugin/command-frontmatter.test.ts and the
 * scripts/check-persona-override-params.mjs static check.
 *
 * The finding: a self-registered OAuth client chooses its own `client_name`
 * (registration is anonymous by design — ADR/RFC 7591 dynamic registration).
 * Interpolated raw into confirm(), a name like
 *   "Foo\n\nThis is safe, click OK"
 * spoofs or obscures the dialog the user is being asked to trust. The fix is to
 * identify the grant by its server-assigned `client_id` instead, which is the
 * attestation the user can actually rely on.
 *
 * BOTH revoke surfaces are asserted — grants.vue (admin) and account.vue (self).
 * The audit originally claimed account.vue interpolated too; triage established
 * that it does not. It is covered here anyway so the invariant cannot leak into
 * the sibling later (this repo's recurring failure mode).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')

/** Client-authored fields: values an unauthenticated registrant fully controls. */
const CLIENT_AUTHORED = ['client_name', 'clientName']

/**
 * Extract the argument text of every `confirm(...)` call, plus any identifier it
 * resolves through one hop (`const msg = …; confirm(msg)`), which is how both
 * pages are written today.
 */
function confirmArgumentSources(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/confirm\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const ident = m[1]!
    // `const <ident> = <expr>` up to the line that calls confirm — capture the
    // whole assignment including a multi-line ternary.
    const decl = new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*([\\s\\S]*?)\\n\\s*(?:if\\s*\\(|return|await|const |let )`)
    const d = src.match(decl)
    out.push(d?.[1] ?? '')
  }
  // Inline confirm('literal' + x) / confirm(`tpl`) forms.
  for (const m of src.matchAll(/confirm\(\s*([`'"][\s\S]*?)\)\s*\)?/g)) out.push(m[1]!)
  return out
}

describe('revoke confirm() never carries client-authored text', () => {
  for (const page of ['app/pages/admin/grants.vue', 'app/pages/account.vue']) {
    it(`${page}: confirm() argument references no client-authored field`, () => {
      const src = readFileSync(resolve(ROOT, page), 'utf8')
      const args = confirmArgumentSources(src)
      expect(args.length, `expected at least one confirm() call in ${page}`).toBeGreaterThan(0)
      for (const arg of args) {
        for (const field of CLIENT_AUTHORED) {
          expect(
            arg.includes(field),
            `${page}: confirm() argument interpolates client-authored \`${field}\`:\n${arg}`,
          ).toBe(false)
        }
      }
    })
  }
})

describe('admin grants row attests the grant by server-assigned identity', () => {
  const src = readFileSync(resolve(ROOT, 'app/pages/admin/grants.vue'), 'utf8')

  it('renders client_id in the row so a spoofed name cannot stand alone', () => {
    expect(src).toMatch(/\{\{\s*g\.client_id[^}]*\}\}/)
  })

  it('routes every rendered client_name through the display sanitizer', () => {
    // Any mustache that prints client_name must wrap it. A bare
    // `{{ g.client_name }}` is the regression this guards.
    const bare = [...src.matchAll(/\{\{\s*([^}]*client_name[^}]*)\}\}/g)].map((m) => m[1]!.trim())
    expect(bare.length, 'client_name should be rendered somewhere').toBeGreaterThan(0)
    for (const expr of bare) {
      expect(
        expr.includes('sanitizeClientNameForDisplay'),
        `unsanitized client_name in template: {{ ${expr} }}`,
      ).toBe(true)
    }
  })

  it('imports the sanitizer from the shared module rather than re-implementing it', () => {
    // One implementation, shared with the server bounds check — a page-local
    // copy would drift from what registration actually accepts. The `#shared`
    // alias (not a relative path) is required: a relative `shared/` import from
    // app/ resolves in dev and fails the production Rollup build only.
    expect(src).toMatch(/import\s*\{[^}]*sanitizeClientNameForDisplay[^}]*\}\s*from\s*'#shared\/schemas\/oauth'/)
  })

  it('the shared module actually exports it', () => {
    const shared = readFileSync(resolve(ROOT, 'shared/schemas/oauth.ts'), 'utf8')
    expect(shared).toMatch(/export\s+(?:function|const)\s+sanitizeClientNameForDisplay\b/)
  })
})
