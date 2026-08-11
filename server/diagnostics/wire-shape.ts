/*
 * Provider wire-shape summariser — the PURE core of the "Provider wire shape"
 * diagnostic. No I/O, no DB, no clock: one JSON value in, one shape report out.
 *
 * WHY THIS EXISTS. TokenScope asks both providers to break usage down BY MODEL
 * and then discards the model at ingest, so that spend renders under a label the
 * codebase itself defines as naming a COLLECTION FAILURE. Before that can be
 * fixed we have to know what the providers actually send — and the only evidence
 * we had was our own Zod schemas, which are assumptions, not observations. This
 * module turns a response (or a stored payload) into a report about its SHAPE:
 * which key paths exist, what types they carry, how often they are present, how
 * often they are null. Presence-count is the number that answers the question.
 *
 * TWO INPUTS, ONE IMPLEMENTATION. The live probe feeds it a fresh provider
 * response; the stored probe feeds it payloads already sitting in the database.
 * Being a pure function over `unknown` is precisely what lets those two callers
 * share one summariser instead of forking it.
 *
 * PRIVACY CONTRACT (enforced here, not merely documented):
 *   1. A raw body is never returned. Only paths, types and counts leave this
 *      module, plus the distinct-value lists rules 2-5 permit.
 *   2. Values are collected ONLY for strings, and never for a string that IS a
 *      number — a number on a provider payload can be a person's cost, and
 *      Anthropic sends money as a decimal string (see isNumericShaped below,
 *      which also recognises money's usual disguises: `$12.50`, `USD 12.50`,
 *      `1,234.56`, `(12.50)`, `1e3`).
 *   3. The key-name denylist (SENSITIVE_KEY_SUBSTRINGS) OVERRIDES the
 *      low-cardinality rule and is applied to EVERY segment of the path, not
 *      just the leaf. It covers identity, money AND capability key names: a money
 *      column is per-actor spend whatever notation it arrives in, and a capability
 *      value (a signed link) IS the access it names. A denylisted path emits type
 *      + presence counts only — no values, and no distinct-COUNT either (a count
 *      is neither a type nor a presence count, and the rule is "type + presence
 *      counts only").
 *   4. Values that LOOK sensitive (email-shaped, URL-shaped, numeric, long and
 *      opaque) are withheld even under a benign key name. Defence in depth for
 *      the case a provider puts an address under a key nobody denylisted.
 *   5. A value the REPORT surfaces deliberately elsewhere, with its own stated
 *      justification (DELIBERATELY_SURFACED_KEYS), is not ALSO collected here.
 *      One considered exception is not a licence for a generic rule to emit it.
 * Rules 2-5 are applied at COLLECTION time, so a suppressed value is never even
 * accumulated in memory, let alone serialised.
 *
 * KEYS ARE DATA TOO — and this guard is PARTIAL, deliberately. Object keys are
 * provider-controlled, so a payload shaped `{"users": {"alice@example.com": {…}}}`
 * would report the address AS A PATH even though rule 3 withholds everything
 * beneath it. Every dynamic key segment is therefore run through the same
 * VALUE-shape test (rule 4) and replaced with REDACTED_KEY_SEGMENT when it
 * matches. What this catches: address-shaped, URL-shaped, numeric and long-opaque
 * keys. What it does NOT catch: a short opaque handle used as a map key (`octocat`)
 * is indistinguishable by shape from a dimension label, and no key-NAME denylist
 * can help — applying it to segments would erase `actor`, `email`, `model_breakdown`
 * and every other schema key this report exists to name. Closing that needs a
 * declared-vs-dynamic distinction the summariser does not have; until then, read
 * a path list as untrusted provider text, not as certified-non-identifying.
 */

/** The JSON types a value can have. `null` is a type here, and is also counted separately. */
export type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object'

/*
 * Key names that identify a PERSON or the thing a person is identified by.
 * Case-insensitive SUBSTRING matches against every path segment.
 */
export const IDENTITY_KEY_SUBSTRINGS = [
  'email',
  'login',
  'name',
  'user',
  'actor',
  'repo',
  'url',
  'id',
  'key',
  'token',
  'secret',
  // A second pass over the providers' own vocabulary: each of these names an
  // actor or an actor-scoped container on some payload we may yet receive, and
  // without them ONE observed value is "low cardinality" and gets emitted.
  'account',
  'handle',
  'principal',
  'owner',
  'subject',
  'assignee',
  'member',
  'workspace',
  'organization',
] as const

/*
 * Key names that carry MONEY. A per-actor cost is exactly as disclosing as a
 * per-actor name, and the value-shape rule alone cannot be the whole defence:
 * it has to recognise every notation a provider might choose. Denying the KEY
 * costs the report nothing (no money column is a dimension worth listing) and
 * does not depend on guessing the notation right.
 */
export const MONEY_KEY_SUBSTRINGS = [
  'amount',
  'cost',
  'price',
  'total',
  'spend',
  'charge',
  'credit',
  'balance',
] as const

/*
 * Key names whose VALUE IS A CAPABILITY — holding the string is enough to reach
 * the data it points at, so emitting one hands a reader of this diagnostic the
 * payload itself. The concrete case is `download_links` on GitHub's Copilot
 * users-1-day metrics report: every element is a SIGNED URL to the per-user NDJSON.
 *
 * TWO DEFENCES, and this is the one that does not depend on notation. The value
 * rule below already withholds a `scheme://` string (URL_SHAPED — its own comment
 * names signed download links) and anything OPAQUE_MIN_LENGTH or longer, so a
 * full-length signed URL is caught twice over today. That is not a reason to leave
 * the key off this list: a value rule only recognises the notations someone thought
 * of, and a shortened link, a scheme-relative one, or a bare signature token would
 * walk straight through it. The key rule holds whatever the value looks like. Same
 * reasoning as MONEY_KEY_SUBSTRINGS above; `url` is already covered by the identity
 * list, which is why it is not repeated here.
 */
export const CAPABILITY_KEY_SUBSTRINGS = [
  'link',
  'href',
  'signature',
] as const

/*
 * The denylist proper. A segment containing any of these emits type + presence
 * counts only.
 *
 * Deliberately blunt, and it over-matches: `token_type` is suppressed because it
 * contains "token", `actor.type` because its parent segment is "actor",
 * `cost_type` because it contains "cost". That is the intended trade — a
 * diagnostic that occasionally withholds a boring enum is strictly better than
 * one that occasionally emits an address, a person's spend, or a signed link.
 */
export const SENSITIVE_KEY_SUBSTRINGS = [
  ...IDENTITY_KEY_SUBSTRINGS,
  ...MONEY_KEY_SUBSTRINGS,
  ...CAPABILITY_KEY_SUBSTRINGS,
] as const

/*
 * Keys whose value the surrounding REPORT surfaces deliberately, once, with its
 * own stated justification — so the generic collector must not ALSO list them.
 *
 * `data_refreshed_at` is the Anthropic reports' ORG-LEVEL export watermark
 * (provider-wire-probe.ts's FreshnessInfo). It identifies no person and it is the
 * only honest signal for whether a figure is settled or still moving, which is
 * why the report carries it on purpose. Surfacing one envelope timestamp by
 * decision is a different act from letting a generic low-cardinality rule emit
 * it, and the two must not be conflated.
 */
export const DELIBERATELY_SURFACED_KEYS = ['data_refreshed_at'] as const

/** Substituted for an object KEY that is itself identity-shaped. See the header. */
export const REDACTED_KEY_SEGMENT = '<redacted-key>'

/** Above this many distinct strings at one path, the values are withheld and only the type remains. */
export const MAX_DISTINCT_VALUES = 50

/** Why a string path's distinct values are absent from the report. */
export type ValuesWithheldReason =
  /** A path segment matched SENSITIVE_KEY_SUBSTRINGS. Takes precedence over everything else. */
  | 'denylisted-key'
  /** More than MAX_DISTINCT_VALUES distinct strings — not a low-cardinality dimension. */
  | 'high-cardinality'
  /** At least one observed value was email-shaped, URL-shaped, numeric or long-and-opaque. */
  | 'value-shape'
  /** The report surfaces this key's value deliberately elsewhere (DELIBERATELY_SURFACED_KEYS). */
  | 'surfaced-elsewhere'

export interface PathStat {
  /** Dot-notated path; array traversal is marked `[]`, e.g. `data[].model_breakdown[].model`. */
  path: string
  /** JSON types observed at this path, sorted. Includes 'null' when nulls occurred. */
  types: JsonType[]
  /**
   * Times this path was observed inside its container. A REDACTED_KEY_SEGMENT
   * path AGGREGATES every identity-shaped key in its container, so `present` can
   * exceed `total` there: the numerator counts keys, the denominator counts
   * containers. Nowhere else can it.
   */
  present: number
  /** Times the CONTAINER of this path was observed — the denominator of present. */
  total: number
  /**
   * How many child contexts this path itself contributed: array ELEMENTS summed
   * across every array seen here, or one per object visit. It is the denominator
   * the children of this path are measured against, and — the reason it is
   * reported rather than derived — it is the ONLY way to tell an array observed
   * EMPTY (0) from one never observed at all, which is what stops an empty
   * `model_breakdown[]` reading as "every field under it disappeared".
   */
  childContexts: number
  /** Of `present`, how many were JSON null. */
  nulls: number
  /** Distinct string values, sorted. Only when the privacy rules permit. */
  distinctValues?: string[]
  /** Set only when strings were observed at this path but their values are withheld. */
  valuesWithheld?: ValuesWithheldReason
}

export interface ShapeSummary {
  /** The path counted as "one item", e.g. `data[]`. */
  itemsPath: string
  /** How many items were observed at itemsPath. Zero means nothing can be concluded. */
  itemCount: number
  /** Every observed path, sorted by path. */
  paths: PathStat[]
}

/** One declared path in a checked-in baseline. */
export interface BaselinePath {
  path: string
  types: JsonType[]
  /**
   * Expected presence as a rate in [0,1], or null for "our schema makes no claim"
   * (an optional field). null disables presence-drift checking for that path —
   * asserting a rate we have no evidence for would manufacture false drift.
   */
  presentRate: number | null
  /**
   * True when our Zod schema supplies a `.default(...)` for this field. Presence
   * of such a path in the STORED probe is 100% by construction and is therefore
   * NOT evidence about the wire — the report flags these rather than letting a
   * defaulted field read as "the provider always sends it".
   */
  defaulted?: boolean
}

export interface WireShapeBaseline {
  endpoint: string
  /**
   * 'schema-derived' — written from our own Zod schemas; it records what we
   *   ASSUME. Paths the observed data has and the baseline does not are fields
   *   we receive and never declared.
   * 'live-capture' — produced by a previous run of this probe against real data.
   *   Paths the data has and the baseline does not are changes SINCE that capture.
   */
  provenance: 'schema-derived' | 'live-capture'
  /** ISO timestamp for a live-capture baseline; null for a schema-derived one. */
  capturedAt: string | null
  note: string
  paths: BaselinePath[]
}

/** A path whose observed types include at least one the baseline does not allow. */
export interface TypeChange {
  path: string
  baseline: JsonType[]
  live: JsonType[]
  /** The observed types absent from the baseline — the reason this is flagged. */
  unexpected: JsonType[]
}

export interface PresenceMove {
  path: string
  baselineRate: number
  liveRate: number
  present: number
  total: number
}

export type DriftReport =
  /** No baseline is checked in for this surface. */
  | { status: 'no-baseline' }
  /** Zero items observed. Every comparison would be an artefact of the empty sample. */
  | { status: 'no-data'; note: string }
  | {
      status: 'match' | 'drift' | 'inconclusive'
      baseline: { provenance: WireShapeBaseline['provenance']; capturedAt: string | null; note: string }
      /** Observed but not in the baseline. Against a schema-derived baseline these are UNDECLARED fields. */
      added: string[]
      /**
       * In the baseline, absent from the data, their container WAS observed, AND
       * the baseline asserts a presence rate for them — a real disappearance.
       */
      removed: string[]
      /**
       * In the baseline, absent from the data, their container WAS observed, but
       * the baseline makes NO presence claim (`presentRate: null` — our schema
       * says optional). Absence is exactly what an optional field is allowed to
       * do, so this is reported for completeness and deliberately does NOT move
       * `status`: routine drift trains an operator to ignore the signal, which
       * costs more than the signal is worth.
       */
      absentOptional: string[]
      /**
       * In the baseline, absent from the data, and their container never yielded
       * a child context — it was absent, or it was an array observed EMPTY.
       * Nothing can be concluded either way.
       */
      notObserved: string[]
      typeChanged: TypeChange[]
      presenceMoved: PresenceMove[]
    }

/** Presence must move by at least this (absolute, as a rate) before it is called drift. */
export const PRESENCE_DRIFT_THRESHOLD = 0.2

/** The JSON type of a value. */
export function jsonType(v: unknown): JsonType {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  switch (typeof v) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'object'
  }
}

/**
 * Split a path into its key segments, dropping the `[]` array markers:
 * `data[].model_breakdown[].model` -> ['data', 'model_breakdown', 'model'].
 */
export function pathSegments(path: string): string[] {
  return path
    .split('.')
    .map((s) => s.replace(/\[\]$/, ''))
    .filter((s) => s.length > 0)
}

/**
 * True when ANY segment of the path matches the denylist. Checking every segment
 * (not just the leaf) is the conservative reading: `actor.type` sits under an
 * identity object, so it is treated as identity-adjacent.
 */
export function isSensitivePath(path: string): boolean {
  const segments = pathSegments(path).map((s) => s.toLowerCase())
  return segments.some((seg) => SENSITIVE_KEY_SUBSTRINGS.some((bad) => seg.includes(bad)))
}

/** True when the LEAF key of a path is one the report surfaces deliberately elsewhere. */
export function isDeliberatelySurfacedPath(path: string): boolean {
  const segments = pathSegments(path)
  const leaf = segments[segments.length - 1]?.toLowerCase()
  return leaf !== undefined && DELIBERATELY_SURFACED_KEYS.some((k) => k === leaf)
}

// Something@something.tld — the shape of an address, wherever it is keyed.
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// scheme://... — signed download links and callbacks carry credentials in the query.
const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\//i
// Long enough to be an opaque handle rather than a dimension label.
const OPAQUE_MIN_LENGTH = 64

/*
 * A number wearing a string's clothes — INCLUDING money's usual disguises.
 *
 * Rule 2 says values are collected for strings only, because a NUMBER on a
 * provider payload can be a person's cost. That reasoning is about the value,
 * not the JSON type — and Anthropic sends money AS A STRING: user_cost_report's
 * `amount` and `list_amount` are fractional-cents decimal strings
 * (enterprise-client.ts's centsStringToUsd exists solely to parse them).
 *
 * Bare decimal notation is not the only way a figure arrives, so matching only
 * that would leave `1e3`, `$12.50`, `USD 12.50`, `1,234.56` and the accounting
 * negative `(12.50)` walking straight through under a key nobody denylisted.
 * The strip-then-test shape below covers each. It is the SECOND of two defences
 * — MONEY_KEY_SUBSTRINGS is the first — because a value rule can only recognise
 * the notations someone thought of, and a key rule does not have to.
 *
 * What must NOT match, or the report loses the answers it exists to produce:
 * `0-200k`, `200k+`, `claude-opus-4`, `gpt-5-mini`, `2026-07-30`.
 */
const ACCOUNTING_NEGATIVE = /^\((.*)\)$/
const CURRENCY_SYMBOL_LEADING = /^[$€£¥₹¤¢]\s*/
const CURRENCY_SYMBOL_TRAILING = /\s*[$€£¥₹¤¢]$/
/*
 * An ISO-4217 code is three UPPERCASE letters. Uppercase-only on purpose: a
 * lowercase three-letter prefix is far more likely to be a model family (`gpt-4`
 * would otherwise strip to `-4` and read as money) than a currency.
 */
const CURRENCY_CODE_LEADING = /^[A-Z]{3}\s*/
const CURRENCY_CODE_TRAILING = /\s*[A-Z]{3}$/
/** Optional sign, digits with optional thousands separators, optional fraction, optional exponent. */
const NUMERIC_CORE = /^[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** True when a string parses as a number once currency notation is stripped. */
export function isNumericShaped(raw: string): boolean {
  let s = raw.trim()
  const paren = ACCOUNTING_NEGATIVE.exec(s)
  if (paren) s = (paren[1] ?? '').trim()
  s = s.replace(CURRENCY_SYMBOL_LEADING, '').replace(CURRENCY_SYMBOL_TRAILING, '')
  s = s.replace(CURRENCY_CODE_LEADING, '').replace(CURRENCY_CODE_TRAILING, '').trim()
  return NUMERIC_CORE.test(s)
}

/** True when a string LOOKS sensitive regardless of the key it arrived under. */
export function isSensitiveValue(v: string): boolean {
  if (v.length >= OPAQUE_MIN_LENGTH) return true
  if (EMAIL_SHAPED.test(v)) return true
  if (URL_SHAPED.test(v)) return true
  if (isNumericShaped(v)) return true
  return false
}

/**
 * The container path whose visit-count is the denominator for `path`:
 *   `data[].model`   -> `data[]`   (the object the key sits on)
 *   `data[]`         -> `data`     (the array the element sits in)
 *   `has_more`       -> ``         (the root)
 */
export function containerPathOf(path: string): string {
  if (path.endsWith('[]')) return path.slice(0, -2)
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(0, dot)
}

interface Accumulator {
  types: Set<JsonType>
  present: number
  nulls: number
  values: Set<string>
  /** Set once a string was seen at this path — distinguishes "no strings" from "strings withheld". */
  sawString: boolean
  withheld?: ValuesWithheldReason
}

/**
 * Summarise the SHAPE of a JSON value.
 *
 * `itemsPath` names the path whose occurrences count as items (e.g. `data[]`).
 * It only selects which number is reported as `itemCount`; the whole value is
 * walked either way, so the envelope is described too.
 */
export function summariseShape(body: unknown, opts: { itemsPath: string }): ShapeSummary {
  const stats = new Map<string, Accumulator>()
  /** How many times a container was visited — the denominator for its children. */
  const containerVisits = new Map<string, number>()

  const statFor = (path: string): Accumulator => {
    let acc = stats.get(path)
    if (!acc) {
      acc = { types: new Set(), present: 0, nulls: 0, values: new Set(), sawString: false }
      stats.set(path, acc)
    }
    return acc
  }

  // Resolved once per path rather than per value: both rules are properties of
  // the path, and re-deriving them per element on a large payload is wasted work.
  const pathRule = new Map<string, 'denylisted-key' | 'surfaced-elsewhere' | null>()
  const ruleFor = (path: string): 'denylisted-key' | 'surfaced-elsewhere' | null => {
    let rule = pathRule.get(path)
    if (rule === undefined) {
      // Rule 3 outranks rule 5: a denylisted key is withheld even if something
      // else would also have withheld it.
      rule = isSensitivePath(path)
        ? 'denylisted-key'
        : isDeliberatelySurfacedPath(path)
          ? 'surfaced-elsewhere'
          : null
      pathRule.set(path, rule)
    }
    return rule
  }

  // Keys are provider-controlled text; see the header's KEYS ARE DATA TOO note
  // for what this catches and what it deliberately cannot.
  const keySegment = new Map<string, string>()
  const segmentFor = (key: string): string => {
    let seg = keySegment.get(key)
    if (seg === undefined) {
      seg = isSensitiveValue(key) ? REDACTED_KEY_SEGMENT : key
      keySegment.set(key, seg)
    }
    return seg
  }

  const collectValue = (acc: Accumulator, path: string, value: string): void => {
    // Rules 3 and 5: never accumulate, never count.
    const rule = ruleFor(path)
    if (rule) {
      acc.withheld = rule
      return
    }
    if (acc.withheld === 'value-shape') return
    // Rule 4: one sensitive-looking value poisons the whole path. Emitting the
    // rest would be emitting "the values that happened not to match a regex".
    if (isSensitiveValue(value)) {
      acc.withheld = 'value-shape'
      acc.values.clear()
      return
    }
    if (acc.withheld === 'high-cardinality') return
    acc.values.add(value)
    if (acc.values.size > MAX_DISTINCT_VALUES) {
      acc.withheld = 'high-cardinality'
      acc.values.clear()
    }
  }

  const walk = (path: string, value: unknown): void => {
    const acc = statFor(path)
    const t = jsonType(value)
    acc.types.add(t)
    acc.present += 1
    if (t === 'null') {
      acc.nulls += 1
      return
    }
    if (t === 'string') {
      acc.sawString = true
      collectValue(acc, path, value as string)
      return
    }
    if (t === 'array') {
      const arr = value as unknown[]
      // The denominator for `path[]` is the number of elements across every
      // array seen at `path`, so present/total for an element path is 1.0 by
      // construction. The informative denominators are on its CHILD paths.
      containerVisits.set(path, (containerVisits.get(path) ?? 0) + arr.length)
      for (const el of arr) walk(`${path}[]`, el)
      return
    }
    if (t === 'object') {
      containerVisits.set(path, (containerVisits.get(path) ?? 0) + 1)
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const seg = segmentFor(k)
        walk(path === '' ? seg : `${path}.${seg}`, v)
      }
    }
  }

  walk('', body)

  const paths: PathStat[] = []
  for (const [path, acc] of stats) {
    // The root itself is the container, not a field of anything — skip its row.
    if (path === '') continue
    const total = containerVisits.get(containerPathOf(path)) ?? acc.present
    const stat: PathStat = {
      path,
      types: [...acc.types].sort(),
      present: acc.present,
      total,
      childContexts: containerVisits.get(path) ?? 0,
      nulls: acc.nulls,
    }
    if (acc.sawString) {
      if (acc.withheld) stat.valuesWithheld = acc.withheld
      else stat.distinctValues = [...acc.values].sort()
    }
    paths.push(stat)
  }
  paths.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    itemsPath: opts.itemsPath,
    itemCount: stats.get(opts.itemsPath)?.present ?? 0,
    paths,
  }
}

/** An ordered query-parameter list; repeated keys (e.g. `group_by[]`) are preserved. */
export type ParamPairs = Array<[string, string]>

/**
 * Replace the VALUE of any identifying request parameter with a placeholder,
 * using the same key-name denylist the body rules use — `user=<login>` is the
 * one that matters on the GitHub call. Dates and group_by dimensions pass
 * through, because an operator cannot judge a shape report without knowing what
 * was asked for.
 *
 * ONE VOCABULARY, DELIBERATELY. Reusing the body denylist means it over-matches
 * here: `bucket_width` is redacted because "width" contains "id". That is a
 * cosmetic loss on a non-secret, and it is preferred to maintaining a second
 * list of key names that could drift out of step with the first. The request
 * note rendered beside these params says so, so a reader does not mistake an
 * over-match for a suppressed secret.
 */
export function redactRequestParams(params: ParamPairs): ParamPairs {
  return params.map(([k, v]): [string, string] => (isSensitivePath(k) ? [k, '<redacted>'] : [k, v]))
}

/**
 * Compare an observed shape against a checked-in baseline.
 *
 * `scopePrefix` restricts the comparison to a subtree. The stored probe passes
 * the item path (e.g. `data[]`) because a stored payload has no HTTP envelope —
 * without the restriction every envelope key in the baseline would be reported
 * as removed, which is an artefact of the input, not a provider change.
 */
export function compareToBaseline(
  baseline: WireShapeBaseline | null,
  live: ShapeSummary,
  opts: { scopePrefix?: string } = {},
): DriftReport {
  if (!baseline) return { status: 'no-baseline' }

  const inScope = (path: string): boolean =>
    !opts.scopePrefix || path === opts.scopePrefix || path.startsWith(`${opts.scopePrefix}.`)

  // Every observed path, used for container lookups — a container can sit
  // OUTSIDE the compared scope (e.g. `data` for scope `data[]`), so this map is
  // deliberately unfiltered.
  const observed = new Map(live.paths.map((p) => [p.path, p]))

  /*
   * 'no-data' is reserved for an item array that was OBSERVED and was EMPTY.
   *
   * Zero items is also what you get when `data` turns into an object, gets
   * renamed, or stops arriving — the loudest envelope drift there is. Returning
   * early on itemCount alone labelled all of that "no rows observed", the most
   * reassuring phrase available for the least reassuring fact. So the envelope
   * is compared FIRST, and only a genuinely empty array short-circuits.
   */
  const itemsContainer = containerPathOf(live.itemsPath)
  const containerStat = itemsContainer === '' ? undefined : observed.get(itemsContainer)
  if (
    live.itemCount === 0 &&
    containerStat !== undefined &&
    containerStat.types.includes('array') &&
    containerStat.childContexts === 0
  ) {
    return {
      status: 'no-data',
      note:
        `\`${itemsContainer}\` was observed and was an EMPTY array, so no path under it can be ` +
        'compared — an absent field and an empty sample are indistinguishable here. This is not ' +
        'evidence of drift.',
    }
  }

  const liveByPath = new Map(live.paths.filter((p) => inScope(p.path)).map((p) => [p.path, p]))
  const baselinePaths = baseline.paths.filter((p) => inScope(p.path))
  const baselineByPath = new Map(baselinePaths.map((p) => [p.path, p]))

  const added: string[] = []
  for (const p of liveByPath.keys()) if (!baselineByPath.has(p)) added.push(p)

  const removed: string[] = []
  const absentOptional: string[] = []
  const notObserved: string[] = []
  for (const b of baselinePaths) {
    if (liveByPath.has(b.path)) continue
    /*
     * Its container must have YIELDED A CHILD CONTEXT before absence means
     * anything. childContexts, not present: `model_breakdown: []` is a present
     * container that contains nothing, and counting it as observed made every
     * one of its declared children read as removed on every run.
     */
    const container = containerPathOf(b.path)
    const containerObserved = container === '' || (observed.get(container)?.childContexts ?? 0) > 0
    if (!containerObserved) notObserved.push(b.path)
    // A baseline path with presentRate null is one our schema marks OPTIONAL. It
    // is allowed to be absent, so calling that a removal manufactures drift on
    // every run and teaches the operator to stop reading the badge.
    else if (b.presentRate === null) absentOptional.push(b.path)
    else removed.push(b.path)
  }

  const typeChanged: TypeChange[] = []
  const presenceMoved: PresenceMove[] = []
  for (const b of baselinePaths) {
    const l = liveByPath.get(b.path)
    if (!l) continue
    // Only a type the baseline does NOT allow is drift. A baseline type that
    // simply did not occur in this sample is sampling, not change.
    const unexpected = l.types.filter((t) => !b.types.includes(t))
    if (unexpected.length > 0) {
      typeChanged.push({ path: b.path, baseline: [...b.types], live: [...l.types], unexpected })
    }
    if (b.presentRate !== null && l.total > 0) {
      const liveRate = l.present / l.total
      if (Math.abs(liveRate - b.presentRate) >= PRESENCE_DRIFT_THRESHOLD) {
        presenceMoved.push({
          path: b.path,
          baselineRate: b.presentRate,
          liveRate,
          present: l.present,
          total: l.total,
        })
      }
    }
  }

  const drifted =
    added.length > 0 || removed.length > 0 || typeChanged.length > 0 || presenceMoved.length > 0
  const status = drifted ? 'drift' : notObserved.length > 0 ? 'inconclusive' : 'match'

  return {
    status,
    baseline: { provenance: baseline.provenance, capturedAt: baseline.capturedAt, note: baseline.note },
    added: added.sort(),
    removed: removed.sort(),
    absentOptional: absentOptional.sort(),
    notObserved: notObserved.sort(),
    typeChanged,
    presenceMoved,
  }
}
