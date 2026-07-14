/*
 * useChartTheme — the single source of brand colour + shared ECharts chrome for
 * the reporting chart kit (app/components/reporting/charts/**).
 *
 * WHY read CSS vars at runtime instead of importing hexes: the brand palette
 * lives in brand-tokens.css bound to Tailwind @theme (app/assets/css/main.css).
 * Reading `getComputedStyle(documentElement)` means a rebrand — or a future dark
 * theme that redefines the same custom properties — flows into every chart with
 * zero code change. NEVER hardcode a hex in a chart; always resolve the var.
 *
 * The resolvers touch a reactive `rev` tick so any `computed()` option that calls
 * them re-runs when the theme mutates (a MutationObserver on <html> bumps `rev`
 * when class / style / data-theme changes). On the client `document` is always
 * present, so resolution is synchronous with no first-paint flash; the small
 * fallback hexes only ever fire on the server (where the charts are ClientOnly
 * and never actually render) or if a token is genuinely missing.
 *
 * DATAVIZ note: the provider split (Claude = hunger #d40e8c, Copilot = vision
 * #5990f0) is validated — do not repaint those two. Rankings are MAGNITUDE, so
 * ranked bars use a single hue (magnitudeColor), never a categorical cycle.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** SSR-only last-resort values. The live client path always reads the CSS var;
 *  these exist so a server render / missing token degrades to something on-brand
 *  rather than an empty string. */
const FALLBACK: Record<string, string> = {
  '--brand-hunger': '#d40e8c',
  '--brand-vision': '#5990f0',
  '--brand-harmony': '#582873',
  '--brand-zeal': '#4ec7ea',
  '--brand-heart': '#b01c87',
  '--carbon': '#3e332d',
  '--carbon-2': '#5a4d45',
  '--carbon-3': '#8a7e76',
  '--calm': '#e0e0e0',
  '--calm-2': '#ececec',
  '--paper': '#fafaf8',
  '--white': '#ffffff',
  '--rag-red': '#dc2626',
  '--rag-amber': '#d97706',
  '--rag-green': '#16a34a',
  '--font-sans': "'Manrope', Arial, system-ui, sans-serif",
  '--shadow-card': '0 4px 24px rgba(88, 40, 115, 0.08)',
}

export type RagState = 'ok' | 'warn' | 'over'

export interface ProviderColors {
  'claude-code': string
  'copilot-cli': string
  other: string
}

export function useChartTheme() {
  // Reactive tick — resolvers read it so option computeds recompute on theme change.
  const rev = ref(0)

  function readVar(name: string): string {
    // Establish a reactive dependency: when called inside a computed, that
    // computed re-runs on `rev` bump (theme toggle / rebrand).
    void rev.value
    if (typeof document !== 'undefined') {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      if (v) return v
    }
    return FALLBACK[name] ?? ''
  }

  /** Provider hues — DATAVIZ-validated split. Claude=hunger, Copilot=vision. */
  function providerColors(): ProviderColors {
    return {
      'claude-code': readVar('--brand-hunger'),
      'copilot-cli': readVar('--brand-vision'),
      other: readVar('--carbon-3'),
    }
  }

  /** Resolve a colour for an arbitrary series/slice key. Tool codes map to the
   *  validated provider split; a display name (e.g. "GitHub Copilot", "Claude")
   *  is fuzzy-matched the same way clientMeta() marks them; anything else falls
   *  to the neutral "other" hue. */
  function colorForKey(key: string): string {
    const p = providerColors()
    const k = (key || '').toLowerCase()
    if (k === 'claude-code' || k.includes('claude')) return p['claude-code']
    if (k === 'copilot-cli' || k.includes('copilot')) return p['copilot-cli']
    return p.other
  }

  /** Single magnitude hue for ranked bars (rankings are magnitude, not identity). */
  function magnitudeColor(): string {
    return readVar('--brand-vision')
  }

  function ragColor(state: RagState): string {
    if (state === 'over') return readVar('--rag-red')
    if (state === 'warn') return readVar('--rag-amber')
    return readVar('--rag-green')
  }

  /** Shared ECharts chrome: recessive axes/grid, brand text, a tasteful white
   *  HTML tooltip. Charts spread this then add their series + tooltip trigger. */
  function baseOption(opts: { tooltipTrigger?: 'axis' | 'item' } = {}): ECOption {
    const carbon = readVar('--carbon')
    const calm = readVar('--calm')
    const calm2 = readVar('--calm-2')
    const white = readVar('--white') || '#ffffff'
    const font = readVar('--font-sans')
    const shadow = readVar('--shadow-card')
    const trigger = opts.tooltipTrigger ?? 'item'

    return {
      textStyle: { color: carbon, fontFamily: font },
      animationDuration: 400,
      aria: { enabled: true },
      grid: { top: 16, right: 16, bottom: 24, left: 16, containLabel: true },
      tooltip: {
        trigger,
        backgroundColor: white,
        borderColor: calm,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: carbon, fontFamily: font, fontSize: 12 },
        extraCssText: `box-shadow: ${shadow || '0 4px 24px rgba(88,40,115,0.10)'}; border-radius: 8px;`,
        ...(trigger === 'axis'
          ? { axisPointer: { type: 'line' as const, lineStyle: { color: calm2, width: 1 } } }
          : {}),
      },
    }
  }

  // Recompute on theme mutation so a dark/rebrand toggle repaints every chart.
  let observer: MutationObserver | null = null
  onMounted(() => {
    // First client tick — harmless if vars were already present.
    rev.value++
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      observer = new MutationObserver(() => {
        rev.value++
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme'],
      })
    }
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return {
    rev,
    readVar,
    providerColors,
    colorForKey,
    magnitudeColor,
    ragColor,
    baseOption,
  }
}
