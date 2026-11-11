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

const PAGES = ['app/pages/index.vue', 'app/pages/usage/index.vue', 'app/pages/projects/index.vue', 'app/pages/account.vue']
const COMPONENT_DIRS = ['home', 'me', 'account', 'activity', 'projects']
const COMPONENTS = ['app/components/charts/TrendArea.vue', 'app/components/charts/StackedBars.vue', 'app/components/charts/MonthSpark.vue']

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
  const template = stripBetween(`>${descriptor.template?.content ?? ''}<`, '<!--', '-->')
  for (const m of template.matchAll(/>([^<>]*—[^<>]*)</g)) {
    const t = m[1]!.trim()
    if (!isLoneMark(t)) out.push(t)
  }
  for (const m of template.matchAll(/[:\w@-]+="([^"]*—[^"]*)"/g)) {
    if (m[1] !== '—' && !m[1]!.includes("'—'")) out.push(m[1]!)
  }
  const script = stripBetween(descriptor.scriptSetup?.content ?? descriptor.script?.content ?? '', '/*', '*/')
  for (const line of script.split('\n')) {
    if (/^\s*\/\//.test(line)) continue
    const code = line.replace(/\s\/\/\s.*$/, '')
    for (const m of code.matchAll(/'([^']*—[^']*)'|`([^`]*—[^`]*)`/g)) {
      const t = m[1] ?? m[2]!
      if (t !== '—') out.push(t)
    }
  }
  return out
}

describe('no em dash in a sentence on the personal pages (#603)', () => {
  for (const file of personalFiles()) {
    it(file, () => {
      expect(renderedEmDashes(readFileSync(file, 'utf8'))).toEqual([])
    })
  }

  it('finds a new em dash in template text, an attribute and a script string', () => {
    const sfc = (body: string, script = '') => `<script setup>${script}</script>\n<template>${body}</template>`
    expect(renderedEmDashes(sfc('<p>one — two</p>'))).toHaveLength(1)
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
