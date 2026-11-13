// @vitest-environment node
/*
 * #603: no em dash in a sentence on the personal pages and their components.
 *
 * A ratchet, not a style sweep. A lone "—" is the empty-cell mark ("no value")
 * and stays: it is a table convention, not prose. Comments are not rendered and
 * are ignored. Admin and reports are out of scope here.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const PAGES = [
  'app/pages/index.vue',
  'app/pages/usage/index.vue',
  'app/pages/projects/index.vue',
  'app/pages/account.vue',
  // #634: the pages project managers, report viewers and developers read daily.
  'app/pages/projects/[code].vue',
  'app/pages/projects/new.vue',
  'app/pages/projects/request.vue',
  'app/pages/usage/playbook.vue',
  'app/pages/inbox.vue',
  'app/pages/help.vue',
  'app/pages/allocations/index.vue',
  'app/pages/allocations/[id].vue',
]
// #610: the shared `ui` and `charts` components render on the personal pages too
// (the fetch error banner, the chart table), so they are walked whole.
// #634: and the inbox and budget editor components.
const COMPONENT_DIRS = ['home', 'me', 'account', 'activity', 'projects', 'ui', 'charts', 'inbox', 'allocator']
// #634: the coverage marker shows on the project page and the reports.
const COMPONENTS: string[] = ['app/components/reporting/CoverageMarker.vue']

function personalFiles(): string[] {
  const inDirs = COMPONENT_DIRS.flatMap((d) =>
    readdirSync(join('app/components', d))
      .filter((f) => f.endsWith('.vue'))
      .map((f) => join('app/components', d, f)),
  )
  return [...PAGES, ...COMPONENTS, ...inDirs]
}

/** Removes every `open`...`close` span, one at a time, so nothing is re-exposed by a removal. */
function stripBetween(text: string, open: string, close: string): string {
  let out = text
  for (let at = out.indexOf(open); at !== -1; at = out.indexOf(open)) {
    const end = out.indexOf(close, at + open.length)
    out = end === -1 ? out.slice(0, at) : out.slice(0, at) + out.slice(end + close.length)
  }
  return out
}

const isLoneMark = (t: string) => t === '—' || !t.replaceAll("'—'", '').includes('—')

/** Every rendered string in a single-file component that uses an em dash in a sentence. */
export function renderedEmDashes(source: string): string[] {
  const out: string[] = []
  const { descriptor } = parse(source)
  const template = stripBetween(`<root>${descriptor.template?.content ?? ''}</root>`, '<!--', '-->')
  // A text run and the tags either side of it. A lone mark is the empty-cell
  // sign only when it is an element's whole content (`<td>—</td>`); between two
  // elements (`</span> — <span>`) it is a dash in a sentence (#617).
  // A tag's quoted attribute values may hold `>` (`v-if="n > 0"`), so the tag
  // pattern steps over quoted strings rather than stopping at the first `>`.
  const TAG = String.raw`<(?:[^<>"']|"[^"]*"|'[^']*')*>`
  for (const m of template.matchAll(new RegExp(String.raw`(?<=(${TAG}))([^<>]*—[^<>]*)(?=(<\/?))`, 'g'))) {
    const t = m[2]!.trim()
    const wholeElement = !m[1]!.startsWith('</') && m[3] === '</'
    const inSentence = !isLoneMark(t) || (t === '—' && !wholeElement)
    if (inSentence) out.push(t)
  }
  for (const m of template.matchAll(/[:\w@-]+="([^"]*—[^"]*)"/g)) {
    if (m[1] !== '—' && !m[1]!.includes("'—'")) out.push(m[1]!)
  }
  out.push(...scriptEmDashes(descriptor.scriptSetup?.content ?? descriptor.script?.content ?? ''))
  return out
}

/**
 * Every string or template literal in TypeScript source that uses an em dash in
 * a sentence. Read with the TypeScript parser, so comments are skipped and a
 * template literal spread over several lines is still one string (#610).
 */
export function scriptEmDashes(source: string): string[] {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    // A whole literal that is only the mark ('—') is the empty-cell sign. A piece
    // of a template with substitutions never is: in `${a} — ${b}` the middle
    // piece is " — ", a dash inside a sentence.
    if (ts.isStringLiteralLike(node)) {
      if (node.text.includes('—') && node.text !== '—') out.push(node.text)
    } else if (ts.isTemplateLiteralToken(node) && node.text.includes('—')) {
      out.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true))
  return out
}

describe('no em dash in a sentence on the personal pages and the pages around them (#603, #634)', () => {
  for (const file of personalFiles()) {
    it(file, () => {
      expect(renderedEmDashes(readFileSync(file, 'utf8'))).toEqual([])
    })
  }

  // #610: user-facing strings built outside a .vue file. The scope labels show on
  // My account's Connections rows and the consent page; the insight headlines on My usage.
  // #634: inbox subjects written on the server, which no template test sees.
  for (const file of [
    'shared/oauth-scopes.ts',
    'server/usage/insights.ts',
    'server/notifications/project-lifecycle.ts',
    'server/workers/went-silent.ts',
    'server/workers/attribution-gap.ts',
    'server/workers/budget-alert.ts',
    'server/workers/velocity-watch.ts',
    'server/workers/reconciliation.ts',
  ]) {
    it(file, () => {
      expect(scriptEmDashes(readFileSync(file, 'utf8'))).toEqual([])
    })
  }

  it('finds a new em dash in a TypeScript string, not in its comments', () => {
    expect(scriptEmDashes("const a = 'one — two'")).toHaveLength(1)
    expect(scriptEmDashes('const a = `one — ${b}`')).toHaveLength(1)
    expect(scriptEmDashes('const a = `${b}\n  over the days — two`')).toHaveLength(1)
    expect(scriptEmDashes('const a = `${b} — ${c}`')).toHaveLength(1)
    expect(scriptEmDashes("const a = x ?? '—'")).toEqual([])
    expect(scriptEmDashes('// one — two\n/* one — two */\nconst a = 1')).toEqual([])
  })

  it('finds a new em dash in template text, an attribute and a script string', () => {
    const sfc = (body: string, script = '') => `<script setup>${script}</script>\n<template>${body}</template>`
    expect(renderedEmDashes(sfc('<p>one — two</p>'))).toHaveLength(1)
    expect(renderedEmDashes(sfc('<p><b>$1</b> — <b>$2</b> is over</p>'))).toHaveLength(1)
    expect(renderedEmDashes(sfc('<p v-if="count > 0">one — two</p>'))).toHaveLength(1)
    expect(renderedEmDashes(sfc('<td v-if="n > 0">—</td>'))).toEqual([])
    expect(renderedEmDashes(sfc('<p title="one — two" />'))).toHaveLength(1)
    expect(renderedEmDashes(sfc('<p />', "const a = 'one — two'"))).toHaveLength(1)
  })

  it('allows the empty-cell mark and comments', () => {
    const sfc = (body: string, script = '') => `<script setup>${script}</script>\n<template>${body}</template>`
    expect(renderedEmDashes(sfc('<td>—</td>'))).toEqual([])
    expect(renderedEmDashes(sfc("<td>{{ x ?? '—' }}</td>"))).toEqual([])
    expect(renderedEmDashes(sfc('<!-- one — two --><p />', "// one — two\nconst a = '—'"))).toEqual([])
  })
})
