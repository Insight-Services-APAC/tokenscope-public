/*
 * useReportState — the SOLE owner of the reporting-area URL query.
 *
 * build-design §1/§3: `scope | month | region | ou | cc` are shallow-routed URL
 * state. No other component reads or writes `route.query` for these keys — they
 * go through this composable's writable computeds (v-model friendly). The pure
 * `parseReportQuery` / `buildReportQuery` are split out so the validation +
 * serialisation are unit-testable without a router/DOM.
 */
import { computed, type WritableComputedRef } from 'vue'

export type ReportScope = 'across' | 'regional' | 'cost-centre' | 'finance'

/**
 * The primary reporting LENS (build-design §A/§B re-lens): `usage` (§A attributed
 * usage) or `chargeback` (§B cost-of-record). Applies to across / regional /
 * cost-centre (NOT finance — finance is already pure §B). Defaults to `usage`.
 */
export type ReportLane = 'usage' | 'chargeback'

const SCOPES: readonly ReportScope[] = ['across', 'regional', 'cost-centre', 'finance']
const LANES: readonly ReportLane[] = ['usage', 'chargeback']
const MONTH_RE = /^\d{4}-\d{2}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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
 * fall back to `defaults` (then to `across` / null). Client gating is UX only —
 * every endpoint re-enforces (build-design §1).
 */
export function parseReportQuery(
  q: Record<string, unknown>,
  defaults: Partial<ReportState> = {},
): ReportState {
  const rawScope = first(q.scope)
  const scope: ReportScope = isScope(rawScope) ? rawScope : (defaults.scope ?? 'across')

  const rawMonth = first(q.month)
  const month = rawMonth && MONTH_RE.test(rawMonth) ? rawMonth : (defaults.month ?? null)

  const rawFrom = first(q.from)
  const from = rawFrom && DATE_RE.test(rawFrom) ? rawFrom : (defaults.from ?? undefined)
  const rawTo = first(q.to)
  const to = rawTo && DATE_RE.test(rawTo) ? rawTo : (defaults.to ?? undefined)

  const rawLane = first(q.lane)
  const lane: ReportLane | undefined = isLane(rawLane) ? rawLane : defaults.lane

  // `from`/`to`/`lane` are emitted as `undefined` when unset (or the default) so an
  // unused range / usage-mode lens does not add keys to the parsed state (keeps the
  // clean month-only round-trip byte-stable).
  return {
    scope,
    month,
    from,
    to,
    lane,
    region: first(q.region) ?? defaults.region ?? null,
    ou: first(q.ou) ?? defaults.ou ?? null,
    cc: first(q.cc) ?? defaults.cc ?? null,
  }
}

/** Serialise a ReportState back to a query bag. Null/undefined keys are dropped. */
export function buildReportQuery(state: ReportState): Record<string, string> {
  const out: Record<string, string> = { scope: state.scope }
  if (state.month) out.month = state.month
  if (state.from) out.from = state.from
  if (state.to) out.to = state.to
  // Only 'chargeback' is persisted; 'usage' is the default and stays out of the URL.
  if (state.lane === 'chargeback') out.lane = 'chargeback'
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
  region: WritableComputedRef<string | null>
  ou: WritableComputedRef<string | null>
  cc: WritableComputedRef<string | null>
  /** Merge a partial update into the URL (shallow, replace-in-place). */
  patch: (p: Partial<ReportState>) => void
}

export function useReportState(defaults: Partial<ReportState> = {}): UseReportState {
  const route = useRoute()
  const router = useRouter()

  const state = computed(() => parseReportQuery(route.query as Record<string, unknown>, defaults))

  function patch(p: Partial<ReportState>) {
    const next: ReportState = { ...state.value, ...p }
    // Owned keys explicitly set (undefined → Vue Router drops them), merged over
    // any foreign query keys so unrelated state is preserved.
    const owned = {
      scope: next.scope,
      month: next.month ?? undefined,
      from: next.from ?? undefined,
      to: next.to ?? undefined,
      // 'usage' is the default → dropped from the URL (undefined); only 'chargeback' persists.
      lane: next.lane === 'chargeback' ? 'chargeback' : undefined,
      region: next.region ?? undefined,
      ou: next.ou ?? undefined,
      cc: next.cc ?? undefined,
    }
    router.replace({ query: { ...route.query, ...owned } })
  }

  function writable<K extends keyof ReportState>(key: K): WritableComputedRef<ReportState[K]> {
    return computed({
      get: () => state.value[key],
      set: (v: ReportState[K]) => patch({ [key]: v } as Partial<ReportState>),
    })
  }

  // `from`/`to` coalesce their absent (`undefined`) state to `null` so the v-model
  // type stays `string | null` (the DateRangeControl clears a bound by setting null).
  function writableDate(key: 'from' | 'to'): WritableComputedRef<string | null> {
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
    from: writableDate('from'),
    to: writableDate('to'),
    lane,
    region: writable('region'),
    ou: writable('ou'),
    cc: writable('cc'),
    patch,
  }
}
