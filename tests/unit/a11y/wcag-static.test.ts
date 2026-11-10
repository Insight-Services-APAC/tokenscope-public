/*
 * WCAG 2.2 AA checks that can be made from source, without a browser (#487).
 *
 * There is no axe run in this repo: the Playwright suite does not run in CI and
 * axe-core is not a dependency. These checks pin the properties #487 fixed so
 * they cannot drift back, each by reading the files that own them:
 *
 *  1. Contrast (1.4.3): the text tokens in brand-tokens.css, computed with the
 *     WCAG formula against the surfaces they are drawn on. A token change that
 *     drops a pair below 4.5:1 fails here.
 *  2. The fill hues too light for text (vision, zeal) are never used as text;
 *     their `-ink` tokens are.
 *  3. Focus (2.4.7): no `focus:outline-none` / `focus-visible:outline-none`,
 *     and a bare `outline-none` only on a container that is not in the tab
 *     order (tabindex="-1"); main.css keeps a 2px :focus-visible outline.
 *  4. Dialogs: every `role="dialog"` in a template is wired to useModalA11y
 *     (Escape, focus trap, focus return).
 *  5. Bypass blocks (2.4.1): both layouts start with a skip link to the id of
 *     their <main>.
 *  6. Table headers (1.3.1, #549): every <th> carries a scope, so a screen
 *     reader can tie a cell to its column, and none is empty.
 *  7. Form fields (1.3.1 / 4.1.2, #550): every native <input>, <select> and
 *     <textarea> has a name: a wrapping <label>, a <label for> its id, an
 *     aria-label, or an aria-labelledby whose static target exists. A
 *     placeholder is not a name. Limits of a source scan: fields inside our own
 *     components (UiInput and the like) are not seen, and v-if branches are not
 *     evaluated, so a <label for> in one branch counts for a field with that id
 *     in another. The fields #550 did not cover are listed one by one in
 *     UNNAMED_FIELDS_LEFT; the list may only shrink.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { stripComments } from '../../helpers/strip-comments'

const ROOT = resolve(__dirname, '../../..')
const APP = join(ROOT, 'app')

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, ext, out)
    else if (ext.test(name)) out.push(p)
  }
  return out
}

const vueFiles = walk(APP, /\.vue$/)
const rel = (p: string) => relative(ROOT, p)

/** The <template> part of a .vue file, with comments removed by the shared scanner (a regex
 *  strip is what CodeQL's js/incomplete-multi-character-sanitization flags; see the helper). */
function template(src: string): string {
  const start = src.indexOf('<template')
  const end = src.lastIndexOf('</template>')
  return start === -1 ? '' : stripComments(src.slice(start, end === -1 ? undefined : end))
}

// ── 1. Contrast ────────────────────────────────────────────────────────────
const tokensCss = readFileSync(join(APP, 'assets/css/brand-tokens.css'), 'utf8')
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(tokensCss)
  if (!m) throw new Error(`token --${name} is not a hex in brand-tokens.css`)
  return m[1]!.toLowerCase()
}
function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
/** `fg` at `alpha` over `bg` — what `bg-<token>/10` paints on a white card. */
function tint(fg: string, bg: string, alpha: number): string {
  const f = rgb(fg)
  const b = rgb(bg)
  return `#${f.map((v, i) => Math.round((v * alpha + b[i]! * (1 - alpha)) * 255).toString(16).padStart(2, '0')).join('')}`
}

describe('1.4.3 text contrast, computed from brand-tokens.css', () => {
  const WHITE = token('white')
  const surfaces = { white: WHITE, paper: token('paper'), clarity: token('brand-clarity') }
  const textTokens = [
    'carbon', 'carbon-2', 'carbon-3', 'brand-harmony', 'brand-heart', 'brand-hustle',
    'rag-red', 'rag-amber', 'rag-green', 'brand-vision-ink', 'brand-zeal-ink',
  ]

  it('the formula is the WCAG one (black on white is 21:1)', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
  })

  for (const t of textTokens) {
    for (const [name, bg] of Object.entries(surfaces)) {
      it(`${t} on ${name} reaches 4.5:1`, () => {
        expect(contrast(token(t), bg)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('muted text (carbon-3) stays readable on the grey and lilac fills it sits on', () => {
    expect(contrast(token('carbon-3'), token('calm-2'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('carbon-3'), token('brand-harmony-lite'))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['rag-red', 'rag-amber', 'rag-green'])('%s as text on its own 10%% tint, and white on its fill', (t) => {
    expect(contrast(token(t), tint(token(t), WHITE, 0.1))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(WHITE, token(t))).toBeGreaterThanOrEqual(4.5)
  })

  it('ink tokens on their own lite chips', () => {
    expect(contrast(token('brand-vision-ink'), token('brand-vision-lite'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('brand-zeal-ink'), token('brand-zeal-lite'))).toBeGreaterThanOrEqual(4.5)
  })

  it('heart (the text colour on hunger fills) on hunger-lite, hunger-sheer and a 10% hunger tint', () => {
    expect(contrast(token('brand-heart'), token('brand-hunger-lite'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('brand-heart'), token('brand-hunger-sheer'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('brand-heart'), tint(token('brand-hunger'), WHITE, 0.1))).toBeGreaterThanOrEqual(4.5)
  })
})

// ── 2. Fill hues never carry text ──────────────────────────────────────────
describe('vision and zeal are fills; their -ink tokens carry text', () => {
  it('no text-brand-vision / text-brand-zeal (3.2:1 and 2.0:1 on white)', () => {
    const offenders: string[] = []
    for (const f of walk(APP, /\.(vue|ts)$/)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/(?<![\w-])text-brand-(vision|zeal)(?![\w-])/.test(line)) offenders.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

// ── 3. Focus ───────────────────────────────────────────────────────────────
describe('2.4.7 focus stays visible', () => {
  it('main.css draws a 2px :focus-visible outline for every element', () => {
    const css = readFileSync(join(APP, 'assets/css/main.css'), 'utf8')
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--brand-harmony\);/)
  })

  it('no class removes the focus outline', () => {
    const offenders: string[] = []
    for (const f of walk(APP, /\.(vue|ts)$/)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/(?<![\w-])focus(-visible)?:outline-(none|0|hidden)(?![\w-])/.test(line)) offenders.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('a bare outline-none sits only on a container outside the tab order', () => {
    const offenders: string[] = []
    for (const f of vueFiles) {
      for (const tag of template(readFileSync(f, 'utf8')).match(/<[a-zA-Z][^>]*>/g) ?? []) {
        if (/(?<![\w:-])outline-none(?![\w-])/.test(tag) && !/tabindex="-1"/.test(tag)) {
          offenders.push(`${rel(f)}: ${tag.slice(0, 80)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('UiButton carries its own focus-visible ring', () => {
    const src = readFileSync(join(APP, 'components/ui/Button.vue'), 'utf8')
    expect(src).toContain('focus-visible:outline-2')
    expect(src).toContain('focus-visible:outline-brand-harmony')
  })
})

// ── 4. Dialogs ─────────────────────────────────────────────────────────────
describe('every role="dialog" uses useModalA11y', () => {
  const dialogFiles = vueFiles
    .map((f) => {
      const src = readFileSync(f, 'utf8')
      return {
        file: rel(f),
        dialogs: (template(src).match(/role="dialog"/g) ?? []).length,
        wired: (src.match(/useModalA11y\(\{/g) ?? []).length,
      }
    })
    .filter((d) => d.dialogs > 0)

  it('finds the dialogs (the scan is live)', () => {
    expect(dialogFiles.length).toBeGreaterThan(15)
  })

  it.each(dialogFiles)('$file wires each dialog it renders', ({ dialogs, wired }) => {
    expect(wired).toBeGreaterThanOrEqual(dialogs)
  })
})

describe('4.1.3 admin result messages are announced (#544)', () => {
  const ADMIN_DIRS = [join(APP, 'pages/admin'), join(APP, 'components/admin')]
  const adminFiles = vueFiles.filter((f) => ADMIN_DIRS.some((d) => f.startsWith(d)))
  const users = adminFiles.filter((f) => /<AdminResultToast\b/.test(template(readFileSync(f, 'utf8'))))

  it('finds the pages that show results (the scan is live)', () => {
    expect(users.length).toBeGreaterThanOrEqual(12)
  })

  it('AdminResultToast keeps a role="status" and a role="alert" region', () => {
    const t = template(readFileSync(join(APP, 'components/admin/AdminResultToast.vue'), 'utf8'))
    expect(t).toContain('role="status"')
    expect(t).toContain('role="alert"')
  })

  it.each(adminFiles.map((f) => [rel(f), f]))('%s renders no hand-rolled toast', (_name, f) => {
    // A result message outside AdminResultToast is the unannounced kind this rule replaced.
    expect(template(readFileSync(f, 'utf8'))).not.toMatch(/v-if="toast"/)
  })
})

// ── 5. Skip links ──────────────────────────────────────────────────────────
describe('2.4.1 each layout starts with a skip link to its <main>', () => {
  it.each(['default', 'admin'])('%s layout', (name) => {
    const tpl = template(readFileSync(join(APP, `layouts/${name}.vue`), 'utf8'))
    const skip = /<a\s[^>]*href="#([\w-]+)"[^>]*>\s*Skip to content\s*<\/a>/.exec(tpl)
    expect(skip, 'no skip link').not.toBeNull()
    expect(tpl).toMatch(new RegExp(`<main[^>]*\\sid="${skip![1]}"`))
    // First focusable thing in the layout: before the header.
    expect(tpl.indexOf(skip![0])).toBeLessThan(tpl.indexOf('<NavAppHeader'))
  })
})

// ── 6. Table headers ───────────────────────────────────────────────────────
describe('1.3.1 every table header cell has a scope and a name', () => {
  const headers = vueFiles.flatMap((f) =>
    [...template(readFileSync(f, 'utf8')).matchAll(/<th(?=[\s/>])([^>]*)>([\s\S]*?)(?=<\/th>|<th[\s/>]|<\/tr>)/g)].map((m) => ({
      file: rel(f),
      attrs: m[1]!,
      selfClosing: m[1]!.endsWith('/'),
      body: m[2]!,
    })),
  )
  const show = (h: { file: string; attrs: string }) => `${h.file}: <th${h.attrs.replace(/\s+/g, ' ').slice(0, 80)}>`

  it('finds the header cells (the scan is live)', () => {
    expect(headers.length).toBeGreaterThan(100)
  })

  it('no <th> under app/ lacks scope (col, row, colgroup or rowgroup)', () => {
    const ok = (a: string) => /\sscope="(col|row|colgroup|rowgroup)"/.test(a) || /\s:scope="/.test(a)
    expect(headers.filter((h) => !ok(h.attrs)).map(show)).toEqual([])
  })

  it('no <th> is empty (an icon or button column gets sr-only text)', () => {
    expect(headers.filter((h) => h.selfClosing || !h.body.trim()).map(show)).toEqual([])
  })
})

// ── 7. Form fields ─────────────────────────────────────────────────────────
/**
 * Unnamed fields on pages #550 did not cover, one entry per field
 * ("file: first 80 characters of its tag"). Name one, delete its line; never add one.
 */
const UNNAMED_FIELDS_LEFT: string[] = [
  'app/components/admin/CouOwnersModal.vue: <input v-model="query" type="search" placeholder="Search the directory by name o',
  'app/components/admin/ProjectMembersModal.vue: <input v-model="query" type="search" placeholder="Search anyone in the directory',
  'app/components/admin/RegionLeadersModal.vue: <input v-model="query" type="search" placeholder="Search the directory by name o',
  'app/components/admin/RegionLeadersModal.vue: <select v-model="kind" class="px-2 py-2 text-sm border border-calm-2 rounded-md ',
  'app/components/projects/ManagePanel.vue: <input v-model="addTerm" type="text" placeholder="Add someone who already uses T',
  'app/components/projects/TeammatePicker.vue: <input v-model="query" type="search" :placeholder="props.placeholder" :disabled=',
  'app/pages/admin/activity-tags.vue: <input v-if="canEdit(asRow(row))" type="number" min="0" :value="asRow(row).sort_',
  'app/pages/admin/activity-tags.vue: <input v-model.number="newSort" type="number" min="0" placeholder="0" class="px-',
  'app/pages/admin/activity-tags.vue: <input v-model="editLabel" type="text" maxlength="64" class="px-2 py-1 text-sm b',
  'app/pages/admin/activity-tags.vue: <input v-model="newLabel" type="text" maxlength="64" placeholder="e.g. spike" cl',
  'app/pages/admin/activity-tags.vue: <select v-model="viewRegionId" :disabled="!regionsData" class="px-3 py-2 text-sm',
  'app/pages/admin/diagnostics.vue: <input v-model="abMonth" type="month" class="text-xs border border-calm rounded ',
  'app/pages/admin/grants.vue: <input v-model="search" type="text" placeholder="Search by name or email" class=',
  'app/pages/admin/grants.vue: <select v-model="viewRegionId" :disabled="!regionsData" class="mt-2 w-full px-3 ',
  'app/pages/admin/instances.vue: <select v-model="viewRegionId" :disabled="!regionsData" class="px-3 py-2 text-sm',
  'app/pages/admin/policies/provider-governance.vue: <input v-model="newPlanNotes" type="text" placeholder="Notes (optional)" class="',
  'app/pages/admin/policies/provider-governance.vue: <input v-model="psMonth" type="month" class="text-xs border border-calm-2 rounde',
  'app/pages/admin/project-managers.vue: <input v-model="note" type="text" maxlength="500" placeholder="Note (optional), ',
  'app/pages/admin/projects/index.vue: <select v-model="viewRegionId" :disabled="!regionsData" class="px-3 py-2 text-sm',
  'app/pages/admin/rate-cards.vue: <input v-model="line.cost" type="text" inputmode="decimal" placeholder="3.00" cl',
  'app/pages/admin/rate-cards.vue: <input v-model="line.model" type="text" placeholder="any model" class="px-2 py-1',
  'app/pages/admin/rate-cards.vue: <input v-model="line.qty" type="text" inputmode="numeric" placeholder="1000000" ',
  'app/pages/admin/rate-cards.vue: <input v-model="line.unit" type="text" placeholder="input" class="px-2 py-1.5 te',
  'app/pages/admin/reconciliation.vue: <input v-model="mapQuery" type="search" placeholder="Search teammates by name or',
  'app/pages/admin/reconciliation.vue: <select v-model="recDisposition" class="text-sm border border-calm rounded-md px',
  'app/pages/admin/reconciliation.vue: <select v-model="recProvider" class="text-sm border border-calm rounded-md px-3 ',
  'app/pages/admin/reconciliation.vue: <select v-model="recStatus" class="text-sm border border-calm rounded-md px-3 py',
  'app/pages/admin/reconciliation.vue: <select v-model="runStatus" class="text-sm border border-calm rounded-md px-3 py',
  'app/pages/admin/reconciliation.vue: <select v-model="runWorker" class="text-sm border border-calm rounded-md px-3 py',
  'app/pages/admin/reconciliation.vue: <select v-model="triggerWorker" class="text-sm border border-calm rounded-md px-',
  'app/pages/allocations/[id].vue: <input v-model="addSearch" type="text" placeholder="Search teammates by name or ',
  'app/pages/allocations/[id].vue: <input v-model="capInputs[d.teammate_id]" type="number" step="0.01" min="0" inpu',
]

/** Each native field in a template, and whether it has an accessible name. */
function scanFields(tpl: string): { tag: string; named: boolean }[] {
  const labelled = new Set([...tpl.matchAll(/<label\b[^>]*\s:?for="([^"]+)"/g)].map((m) => m[1]))
  const ids = new Set([...tpl.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const out: { tag: string; named: boolean }[] = []
  let inLabel = 0
  for (const m of tpl.matchAll(/<(\/?)(label|input|select|textarea)\b([^>]*)>/g)) {
    const [, close, name, attrs] = m as unknown as [string, string, string, string]
    if (name === 'label') {
      if (close) inLabel--
      else if (!attrs.endsWith('/')) inLabel++
      continue
    }
    if (close || /\stype="(hidden|submit|button|reset)"/.test(attrs)) continue
    const id = /\s:?id="([^"]+)"/.exec(attrs)?.[1]
    const labelledBy = /\saria-labelledby="([^"]+)"/.exec(attrs)?.[1]
    out.push({
      tag: `<${name}${attrs.replace(/\s+/g, ' ')}`.slice(0, 80),
      named:
        inLabel > 0 ||
        /\s:?aria-label="[^"]*[^"\s][^"]*"/.test(attrs) ||
        /\s:aria-labelledby="/.test(attrs) ||
        (!!labelledBy && labelledBy.split(/\s+/).every((ref) => ids.has(ref))) ||
        (!!id && labelled.has(id)),
    })
  }
  return out
}

describe('1.3.1 / 4.1.2 every form field has a name, not just a placeholder', () => {
  const scanned = vueFiles.map((f) => ({ file: rel(f), fields: scanFields(template(readFileSync(f, 'utf8'))) }))

  it('the scanner tells a named field from an unnamed one', () => {
    const named = (tpl: string) => scanFields(tpl).map((f) => f.named)
    expect(named('<input v-model="a" placeholder="Monthly cost">')).toEqual([false])
    expect(named('<label><span>Cost</span><input v-model="a"></label>')).toEqual([true])
    expect(named('<label for="c">Cost</label><input id="c">')).toEqual([true])
    expect(named('<label for="d">Cost</label><input id="c">')).toEqual([false])
    expect(named('<select :aria-label="`Role for ${n}`"></select>')).toEqual([true])
    expect(named('<input aria-label="">')).toEqual([false])
    expect(named('<input aria-label="" class="w-full">')).toEqual([false])
    expect(named('<input aria-label="  " class="w-full">')).toEqual([false])
    expect(named('<input class="w-full" aria-label="Cost" type="text">')).toEqual([true])
    expect(named('<h2 id="t">Cost</h2><input aria-labelledby="t">')).toEqual([true])
    expect(named('<input aria-labelledby="missing">')).toEqual([false])
    expect(named('<input type="hidden" name="x">')).toEqual([])
  })

  it('finds the fields (the scan is live)', () => {
    expect(scanned.flatMap((s) => s.fields).length).toBeGreaterThan(150)
  })

  it.each(['app/pages/account.vue', 'app/pages/admin/users.vue', 'app/components/admin/EntityTable.vue'])(
    '%s: every field is named (#550)',
    (file) => {
      const s = scanned.find((x) => x.file === file)
      expect(s, `${file} not scanned`).toBeDefined()
      expect(s!.fields.length).toBeGreaterThan(0)
      expect(s!.fields.filter((f) => !f.named).map((f) => f.tag)).toEqual([])
    },
  )

  it('every other unnamed field is one already listed, and every listed one still exists', () => {
    const unnamed = scanned.flatMap(({ file, fields }) => fields.filter((f) => !f.named).map((f) => `${file}: ${f.tag}`))
    const left = [...UNNAMED_FIELDS_LEFT]
    const notListed = unnamed.filter((u) => {
      const i = left.indexOf(u)
      if (i === -1) return true
      left.splice(i, 1)
      return false
    })
    expect(notListed, 'unnamed fields not in UNNAMED_FIELDS_LEFT: name them').toEqual([])
    expect(left, 'listed fields that are now named or gone: delete these lines').toEqual([])
  })
})
