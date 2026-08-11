/*
 * useReportState — the SOLE owner of the reporting-area URL query.
 *
 * build-design §1/§3: `scope | month | from | to | lane | src | region | ou | cc`
 * are shallow-routed URL state. No other component reads or writes `route.query`
 * for these keys (me pages excepted for `lane`, which `usePersonalLens` owns
 * there — this composable is not mounted with lane ownership on me pages) — they
 * go through this composable's writable computeds (v-model friendly). The pure
 * `parseReportQuery` / `buildReportQuery` are split out so the validation +
 * serialisation are unit-testable without a router/DOM.
 */
import {
  computed,
  getCurrentInstance,
  inject,
  provide,
  type InjectionKey,
  type WritableComputedRef,
} from 'vue'
import { SPEND_LENSES, type SpendLens } from '#shared/usage/lens'
import {
  REPORT_SCOPES,
  LEGACY_REPORT_SCOPES,
  isLegacyReportScope,
  type ReportScope,
} from '#shared/reports/types'

/*
 * `ReportScope` is RE-EXPORTED, not re-declared. It used to be a second literal
 * union spelled out here, and the merge that turned four scopes into three had to
 * be made twice — once in the shared contract the endpoints switch on, once here.
 * Two spellings of the same union is how the URL comes to admit a scope no endpoint
 * serves (or refuse one every endpoint does).
 */
export type { ReportScope }

/**
 * The primary reporting LENS (build-design §A/§B re-lens): `usage` (§A attributed
 * usage) or `chargeback` (§B cost-of-record). Applies to across / regional /
 * cost-centre (NOT finance — finance is already pure §B). Defaults to `usage`.
 *
 * An ALIAS of the shared `SpendLens`, not a second declaration of the same
 * union: ADR 0012 put the same lens on the personal surfaces, and two spellings
 * of `'usage' | 'chargeback'` is how they would come to disagree.
 */
export type ReportLane = SpendLens

const SCOPES: readonly ReportScope[] = REPORT_SCOPES
const LANES: readonly ReportLane[] = SPEND_LENSES
const MONTH_RE = /^\d{4}-\d{2}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/*
 * The drill SCOPE token (developer pages build D16/D30): which of the CALLER's
 * own grants frames a reports→drill view — `cc:{ccId}` / `region:{regionId}` /
 * `across` / `finance`. The id part is opaque (UUIDs, region codes); only the
 * prefix vocabulary is validated here. The token NEVER authorises (D33): the
 * server maps it onto the caller's own grants and a `src` naming a scope the
 * caller does not hold is a 403, not a fallback — this parse is UX hygiene
 * only, exactly like the `scope` validation above.
 */
const SRC_TOKEN_RE = /^(?:across|finance|cc:[\w.:-]+|region:[\w.:-]+)$/

/** True iff `v` is a well-formed drill scope token (shape only — never a grant check). */
export function isScopeSrcToken(v: string): boolean {
  return SRC_TOKEN_RE.test(v)
}

/**
 * Every key this composable can own. ORDER is display order in the URL builder.
 */
export const REPORT_STATE_KEYS = [
  'scope',
  'month',
  'from',
  'to',
  'lane',
  'src',
  'region',
  'ou',
  'cc',
] as const
export type ReportStateKey = (typeof REPORT_STATE_KEYS)[number]

/**
 * The subset a DEVELOPER page owns: the window vocabulary plus the drill frame.
 *
 * WHY THIS EXISTS (the W2/W3 seam). `/usage`, `/projects` and `/projects/[code]`
 * mount `DateRangeControl` for its presets, and the control self-wires to this
 * composable (zero props, by design). `patch()` used to write its whole owned
 * key set on every call, so ONE preset click stamped `?scope=region` onto a
 * developer-page URL — a REPORTS scope key on a page that has no scope tab, no
 * endpoint that reads it, and no way for the reader to clear it. Shared or
 * bookmarked, that URL then carried a claim the page never made.
 *
 * `scope`/`lane`/`region`/`ou`/`cc` are the reporting SHELL's vocabulary. A page
 * that is not the shell declares what it owns and the rest is left alone —
 * including any foreign key already in the URL, which `patch()` preserves.
 */
export const WINDOW_STATE_KEYS: readonly ReportStateKey[] = ['month', 'from', 'to', 'src']

const OWNED_KEYS: InjectionKey<readonly ReportStateKey[]> = Symbol('tokenscope.reportStateKeys')

/**
 * Declare which report-state keys the current page owns, for this component
 * subtree. Call it in the page's setup BEFORE mounting anything that wires
 * itself to the state (DateRangeControl), so the control's own `useReportState()`
 * resolves the same ownership the page declared.
 *
 * Absent ⇒ every key (today's reporting-shell behaviour, unchanged).
 */
export function provideReportStateKeys(keys: readonly ReportStateKey[]): void {
  provide(OWNED_KEYS, keys)
}

export interface ReportState {
  scope: ReportScope
  /** `YYYY-MM`, or null for "current" (the page resolves the default). */
  month: string | null
  /**
   * Custom date-range bounds (`YYYY-MM-DD`, inclusive `to`). Both are set together
   * by the DateRangeControl; present ⇒ the endpoints window on `[from, to]` instead
   * of `month`. Absent from the parsed state (and the URL) when not set — a partial
   * range is a server-side 400.
   */
  from?: string | null
  to?: string | null
  /**
   * The active lens — `chargeback` when explicitly set, else absent (usage default).
   * Modelled like `from`/`to` (undefined when the default) so a usage-mode URL stays
   * clean and the parse/serialise round-trip is byte-stable.
   */
  lane?: ReportLane
  /**
   * The reports→drill scope token (`cc:{id}` / `region:{id}` / `across` /
   * `finance`) — which of the caller's own grants frames the drill view
   * (developer pages build D16). Carried so a drill target can echo its entry
   * scope and its breadcrumb can reconstruct the entry report URL (D30).
   * Modelled like `from`/`to` (absent when unset) so a URL without a drill
   * frame stays clean. Selects a frame; NEVER authorises (D33).
   */
  src?: string | null
  region: string | null
  ou: string | null
  cc: string | null
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const x = v[0]
    return typeof x === 'string' ? x : undefined
  }
  return typeof v === 'string' ? v : undefined
}

function isScope(v: string | undefined): v is ReportScope {
  return v != null && (SCOPES as readonly string[]).includes(v)
}

function isLane(v: string | undefined): v is ReportLane {
  return v != null && (LANES as readonly string[]).includes(v)
}

/**
 * Parse a raw query bag into a validated ReportState. Invalid `scope`/`month`
 * fall back to `defaults` (then to `region` / null). Client gating is UX only —
 * every endpoint re-enforces (build-design §1).
 *
 * RETIRED SCOPES ARE MAPPED, not rejected. `?scope=across` and `?scope=regional`
 * both resolve to `?scope=region`; `across` additionally selects the `all` region,
 * because that scope only ever meant the whole-company width. Falling back to the
 * default instead would silently land a bookmarked whole-company URL on one region's
 * figures under the same headline — the failure mode that makes a stale link worse
 * than a broken one. The mapping table is shared with the CSV export
 * (`LEGACY_REPORT_SCOPES`), so a link and its export button agree.
 *
 * An explicit `?region=` alongside `?scope=across` does NOT survive: that
 * combination never existed (the Across scope had no region param), so a `region`
 * riding along is a stale key from another scope, not an intent.
 */
export function parseReportQuery(
  q: Record<string, unknown>,
  defaults: Partial<ReportState> = {},
): ReportState {
  const rawScope = first(q.scope)
  const legacy = rawScope != null && isLegacyReportScope(rawScope) ? LEGACY_REPORT_SCOPES[rawScope] : null
  const scope: ReportScope = legacy
    ? legacy.scope
    : isScope(rawScope)
      ? rawScope
      : (defaults.scope ?? 'region')

  const rawMonth = first(q.month)
  const month = rawMonth && MONTH_RE.test(rawMonth) ? rawMonth : (defaults.month ?? null)

  const rawFrom = first(q.from)
  const from = rawFrom && DATE_RE.test(rawFrom) ? rawFrom : (defaults.from ?? undefined)
  const rawTo = first(q.to)
  const to = rawTo && DATE_RE.test(rawTo) ? rawTo : (defaults.to ?? undefined)

  const rawLane = first(q.lane)
  const lane: ReportLane | undefined = isLane(rawLane) ? rawLane : defaults.lane

  const rawSrc = first(q.src)
  const src = rawSrc && isScopeSrcToken(rawSrc) ? rawSrc : (defaults.src ?? undefined)

  // `from`/`to`/`lane`/`src` are emitted as `undefined` when unset (or the default)
  // so an unused range / usage-mode lens / frameless URL does not add keys to the
  // parsed state (keeps the clean month-only round-trip byte-stable).
  return {
    scope,
    month,
    from,
    to,
    lane,
    src,
    // A legacy mapping's `region` OVERRIDES (`across` ⇒ `all`); its `null` means "no
    // override", so `regional` keeps whatever region the URL already carried.
    region: legacy?.region ?? first(q.region) ?? defaults.region ?? null,
    ou: first(q.ou) ?? defaults.ou ?? null,
    cc: first(q.cc) ?? defaults.cc ?? null,
  }
}

/**
 * True iff this raw query bag still names a retired scope — i.e. the URL in the
 * address bar is not yet the canonical one `parseReportQuery` resolved it to.
 *
 * The shell reads this (through `useReportState().isLegacyScope`) to rewrite the URL
 * ONCE on mount. Without that, the mapping is invisible: the page renders Region
 * correctly while the address bar still reads `?scope=across`, so the link the user
 * copies and re-shares is the stale one, and the retired value never retires.
 */
export function hasLegacyScope(q: Record<string, unknown>): boolean {
  const raw = first(q.scope)
  return raw != null && isLegacyReportScope(raw)
}

/** Serialise a ReportState back to a query bag. Null/undefined keys are dropped. */
export function buildReportQuery(state: ReportState): Record<string, string> {
  const out: Record<string, string> = { scope: state.scope }
  if (state.month) out.month = state.month
  if (state.from) out.from = state.from
  if (state.to) out.to = state.to
  // Only 'chargeback' is persisted; 'usage' is the default and stays out of the URL.
  if (state.lane === 'chargeback') out.lane = 'chargeback'
  if (state.src) out.src = state.src
  if (state.region) out.region = state.region
  if (state.ou) out.ou = state.ou
  if (state.cc) out.cc = state.cc
  return out
}

export interface UseReportState {
  state: import('vue').ComputedRef<ReportState>
  scope: WritableComputedRef<ReportScope>
  month: WritableComputedRef<string | null>
  /** Custom-range lower bound (`YYYY-MM-DD`), or null. Bound by the DateRangeControl. */
  from: WritableComputedRef<string | null>
  /** Custom-range upper bound (`YYYY-MM-DD`, inclusive), or null. */
  to: WritableComputedRef<string | null>
  /** The active lens (`usage` | `chargeback`); reads `usage` when unset. */
  lane: WritableComputedRef<ReportLane>
  /** The drill scope token (D16), or null when the URL carries no drill frame. */
  src: WritableComputedRef<string | null>
  region: WritableComputedRef<string | null>
  ou: WritableComputedRef<string | null>
  cc: WritableComputedRef<string | null>
  /**
   * True while the URL still names a RETIRED scope (`across` / `regional`). The
   * parsed state above is already the mapped one; this says the address bar has not
   * caught up, so the shell can rewrite it once.
   *
   * It lives here, not in the page, because this composable is the SOLE owner of the
   * reporting query — a page calling `useRoute()` to answer a question about
   * `?scope=` is a second reader of the state this module exists to own.
   */
  isLegacyScope: import('vue').ComputedRef<boolean>
  /** Merge a partial update into the URL (shallow, replace-in-place). */
  patch: (p: Partial<ReportState>) => void
}

export function useReportState(defaults: Partial<ReportState> = {}): UseReportState {
  const route = useRoute()
  const router = useRouter()
  /*
   * Which keys this mount OWNS — declared by the page through
   * {@link provideReportStateKeys}, defaulting to all of them so the reporting
   * shell is byte-identical to its previous behaviour. Injected rather than
   * passed, because the component that patches most often (DateRangeControl)
   * self-wires with zero props and cannot be handed an option.
   */
  const ownedKeys =
    (getCurrentInstance() ? inject(OWNED_KEYS, null) : null) ?? REPORT_STATE_KEYS

  const state = computed(() => parseReportQuery(route.query as Record<string, unknown>, defaults))

  function patch(p: Partial<ReportState>) {
    const next: ReportState = { ...state.value, ...p }
    // Owned keys explicitly set (undefined → Vue Router drops them), merged over
    // any foreign query keys so unrelated state is preserved.
    const all: Record<ReportStateKey, string | undefined> = {
      scope: next.scope,
      month: next.month ?? undefined,
      from: next.from ?? undefined,
      to: next.to ?? undefined,
      // 'usage' is the default → dropped from the URL (undefined); only 'chargeback' persists.
      lane: next.lane === 'chargeback' ? 'chargeback' : undefined,
      src: next.src ?? undefined,
      region: next.region ?? undefined,
      ou: next.ou ?? undefined,
      cc: next.cc ?? undefined,
    }
    /*
     * Only the keys THIS page declared it owns are written. An unowned key is
     * not merely left at its current value — it is not written at all, so a
     * key the page never had is never minted (the developer-page `?scope=`
     * seam) and a foreign key already in the URL rides through untouched.
     */
    const owned: Record<string, string | undefined> = {}
    for (const key of ownedKeys) owned[key] = all[key]
    router.replace({ query: { ...route.query, ...owned } })
  }

  function writable<K extends keyof ReportState>(key: K): WritableComputedRef<ReportState[K]> {
    return computed({
      get: () => state.value[key],
      set: (v: ReportState[K]) => patch({ [key]: v } as Partial<ReportState>),
    })
  }

  // `from`/`to`/`src` coalesce their absent (`undefined`) state to `null` so the
  // v-model type stays `string | null` (the DateRangeControl clears a bound by
  // setting null; a drill page clears its frame the same way).
  function writableNullable(key: 'from' | 'to' | 'src'): WritableComputedRef<string | null> {
    return computed({
      get: () => state.value[key] ?? null,
      set: (v: string | null) => patch({ [key]: v } as Partial<ReportState>),
    })
  }

  // `lane` coalesces its absent (`undefined`) state to the `usage` default so the
  // v-model type stays a concrete ReportLane; writing 'usage' clears it from the URL.
  const lane: WritableComputedRef<ReportLane> = computed({
    get: () => state.value.lane ?? 'usage',
    set: (v: ReportLane) => patch({ lane: v }),
  })

  return {
    state,
    scope: writable('scope') as WritableComputedRef<ReportScope>,
    month: writable('month'),
    from: writableNullable('from'),
    to: writableNullable('to'),
    lane,
    src: writableNullable('src'),
    region: writable('region'),
    ou: writable('ou'),
    cc: writable('cc'),
    isLegacyScope: computed(() => hasLegacyScope(route.query as Record<string, unknown>)),
    patch,
  }
}
