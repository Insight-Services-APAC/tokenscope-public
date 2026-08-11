<script setup lang="ts">
/*
 * PlacementRuleOffer — "Always place `department = X` into <U>?" (spec C5).
 *
 * WHAT MAKES IT DURABLE RATHER THAN A ONE-OFF CLEAN-UP. Placing forty people by
 * hand fixes forty people. A standing rule fixes the next joiner too, which is
 * the difference between clearing the worklist once and clearing it every month.
 *
 * NEVER SILENT. The rule is only ever created by a click here. A bulk placement
 * that quietly wrote a standing rule would mean an admin tidying one cluster had
 * also changed where every future match lands, without being told.
 *
 * ── WHY IT OFFERS A CHOICE OF ATTRIBUTE ───────────────────────────────────────
 * A batch that all share a department usually also shares a company name — and a
 * rule on companyName ("Insight Australia") would route the ENTIRE legal entity
 * into one Business Unit. Picking for the admin is how that happens by accident, so
 * every attribute the batch actually agrees on is listed, with the value it would
 * match, and the admin picks.
 *
 * The DEFAULT is the last attribute in the shared precedence catalog, which is
 * ordered broad-geo-first (companyName → … → department). A unit rule wants the
 * NARROWEST signal available — the opposite end of the same order — so the
 * default is the most org-specific one the batch shares rather than a hard-coded
 * "department", which would be this tenant's shape.
 *
 * ── AND WHY WANTING THE NARROWEST IS NOT ENOUGH ───────────────────────────────
 * The engine resolves BROAD-first: `mapAttributesToRegion` walks the catalog in
 * order and the FIRST attribute with a matching rule decides, whatever else also
 * matches. So preferring the narrowest end while the runtime prefers the broad end
 * is precisely the arrangement in which an existing companyName rule beats the
 * department rule just offered — the offer says "the next person with that value
 * lands in X", the next person lands wherever the company rule says, and nothing
 * on screen explained why.
 *
 * So the proposed rule is resolved against the rules that already exist: for each
 * candidate, any HIGHER-precedence attribute with a rule the batch actually
 * matches, pointing somewhere ELSE, SHADOWS it. A shadowed candidate is not
 * offered as the default, and choosing one anyway warns with the rule that will
 * win and the count of this batch it already decides. The offer never claims an
 * outcome the engine will not produce.
 *
 * It reads the region's existing rules from the page (`existing-rules`) rather
 * than fetching its own copy, so the warning and the rule table on the same screen
 * cannot disagree. That list is region-scoped by design — an org-wide REGION rule
 * on a higher-precedence attribute is not visible to a region admin and cannot be
 * detected here, so the warning is a floor, never a guarantee, and the copy does
 * not pretend otherwise.
 *
 * ── WHY IT IS COMPUTED FROM THE ROWS ──────────────────────────────────────────
 * The worklist already carries each teammate's captured department and company
 * (C3). The candidate values are those columns, normalised with the SAME
 * normaliser the rule matcher uses (shared/placement/region-attributes.ts), so
 * the value offered here is the value that will actually match. A batch where any
 * placed teammate has no captured value for an attribute does NOT offer it: a
 * rule inferred from people we have no directory reading for is a guess.
 */
import { computed, ref, watch } from 'vue'
import { consola } from 'consola'
import UiButton from '../ui/Button.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import {
  REGION_ATTRIBUTE_KEYS,
  attributePrecedence,
  regionAttributeLabel,
  normalizeMatchValue,
} from '#shared/placement/region-attributes'

/** The subset of a worklist row this offer reads. */
export interface RuleOfferRow {
  id: string
  department: string | null
  company_name: string | null
}

/** The subset of an existing region rule the shadow check needs. */
export interface RuleOfferExistingRule {
  attribute: string
  match_mode: string
  /** Normalised — the value the matcher compares against. */
  match_value: string
  match_value_raw: string
  org_unit_id: string | null
  org_unit_display_name: string | null
}

/** A higher-precedence rule that would decide these people first. */
export interface RuleShadow {
  attribute: string
  label: string
  /** The existing rule's value, as it is stored for display. */
  value: string
  targetName: string
  /** How many of the placed batch that rule already matches. */
  people: number
}

export interface RuleCandidate {
  attribute: string
  label: string
  /** The value as the directory spells it — what the rule stores for display. */
  value: string
  /** Non-null ⇒ this rule would be beaten by one that already exists. */
  shadow: RuleShadow | null
}

const props = withDefaults(
  defineProps<{
    /** The ids that were actually PLACED (noops and refusals excluded). */
    teammateIds: string[]
    rows: RuleOfferRow[]
    orgUnitId: string
    orgUnitName: string
    /** This region's existing unit rules, from the page's own list. */
    existingRules?: RuleOfferExistingRule[]
  }>(),
  { existingRules: () => [] },
)
const emit = defineEmits<{ dismiss: []; created: [summary: { attribute: string; value: string }] }>()

/**
 * Which directory attributes does EVERY placed teammate share one value for?
 *
 * Only the attributes the worklist actually captures (department, companyName)
 * can be answered here; the rest of the catalog is not on these rows, and
 * offering a rule on an attribute we cannot see the values of would be a guess.
 */
/** The attributes the worklist actually captures a value for, per placed row. */
const ATTRIBUTE_READERS: Array<{ attribute: string; read: (r: RuleOfferRow) => string | null }> = [
  { attribute: 'companyName', read: (r) => r.company_name },
  { attribute: 'department', read: (r) => r.department },
]

const placedRows = computed(() => props.rows.filter((r) => props.teammateIds.includes(r.id)))

/**
 * Which EXISTING rule (if any) already decides a given attribute value, using the
 * matcher's own rules: exact on the normalised value, prefix longest-first.
 */
function existingRuleFor(attribute: string, rawValue: string | null): RuleOfferExistingRule | null {
  const norm = normalizeMatchValue(rawValue)
  if (!norm) return null
  const mine = props.existingRules.filter((r) => r.attribute === attribute)
  const exact = mine.find((r) => r.match_mode !== 'prefix' && r.match_value === norm)
  if (exact) return exact
  return (
    mine
      .filter((r) => r.match_mode === 'prefix' && norm.startsWith(r.match_value))
      .sort((a, b) => b.match_value.length - a.match_value.length)[0] ?? null
  )
}

/**
 * The highest-precedence EXISTING rule that beats a rule on `attribute` for this
 * batch — i.e. one on an attribute the catalog resolves FIRST, matching people in
 * the batch, and pointing at a different Business Unit. Pointing at the SAME unit is
 * not a shadow: the outcome the offer promises still happens.
 */
function shadowFor(attribute: string): RuleShadow | null {
  const mine = attributePrecedence(attribute)
  for (const { attribute: higher, read } of ATTRIBUTE_READERS) {
    if (attributePrecedence(higher) >= mine) continue
    let rule: RuleOfferExistingRule | null = null
    let people = 0
    for (const row of placedRows.value) {
      const hit = existingRuleFor(higher, read(row))
      if (!hit || hit.org_unit_id === props.orgUnitId) continue
      rule = rule ?? hit
      if (hit.match_value === rule.match_value) people += 1
    }
    if (rule) {
      return {
        attribute: higher,
        label: regionAttributeLabel(higher),
        value: rule.match_value_raw,
        targetName: rule.org_unit_display_name ?? 'another Business Unit',
        people,
      }
    }
  }
  return null
}

/**
 * Which directory attributes does EVERY placed teammate share one value for?
 */
const candidates = computed<RuleCandidate[]>(() => {
  const placed = placedRows.value
  if (placed.length === 0) return []
  const out: RuleCandidate[] = []
  for (const { attribute, read } of ATTRIBUTE_READERS) {
    const values = placed.map(read)
    // Every row must HAVE a value, and they must all normalise to the same one.
    if (values.some((v) => !normalizeMatchValue(v))) continue
    const norms = new Set(values.map((v) => normalizeMatchValue(v)))
    if (norms.size !== 1) continue
    out.push({
      attribute,
      label: regionAttributeLabel(attribute),
      value: String(values[0]).trim(),
      shadow: shadowFor(attribute),
    })
  }
  // Narrowest first: the shared catalog is ordered broad-geo-first, so reverse
  // its precedence for a UNIT rule rather than inventing a second ordering.
  return out.sort((a, b) => REGION_ATTRIBUTE_KEYS.indexOf(b.attribute as never) - REGION_ATTRIBUTE_KEYS.indexOf(a.attribute as never))
})

const chosen = ref<string>('')
watch(
  candidates,
  (list) => {
    if (list.some((c) => c.attribute === chosen.value)) return
    // Narrowest UNSHADOWED first. Defaulting to a rule the engine would not honour
    // is how the offer promises an outcome that never happens; when every candidate
    // is shadowed there is no such default, and the warning below carries it.
    chosen.value = (list.find((c) => !c.shadow) ?? list[0])?.attribute ?? ''
  },
  { immediate: true },
)
const chosenCandidate = computed(() => candidates.value.find((c) => c.attribute === chosen.value) ?? null)
const chosenShadow = computed(() => chosenCandidate.value?.shadow ?? null)

const saving = ref(false)
const error = ref<string | null>(null)

async function createRule() {
  const c = chosenCandidate.value
  if (!c) return
  saving.value = true
  error.value = null
  try {
    await $fetch('/api/v1/admin/directory-region-rules', {
      method: 'POST',
      body: {
        attribute: c.attribute,
        match_mode: 'exact',
        match_value: c.value,
        org_unit_id: props.orgUnitId,
      },
    })
    emit('created', { attribute: c.attribute, value: c.value })
  } catch (e) {
    consola.warn('placement rule create failed', e)
    error.value = apiErrorDetail(e, 'Could not save the rule.')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    v-if="candidates.length"
    class="mb-5 p-4 rounded-lg bg-brand-harmony-sheer border border-brand-harmony/30"
    data-testid="placement-rule-offer"
  >
    <div class="text-sm font-bold text-carbon">Stop this cluster coming back?</div>
    <p class="text-sm text-carbon-2 mt-1 leading-relaxed">
      Every one of the {{ teammateIds.length }}
      {{ teammateIds.length === 1 ? 'teammate' : 'teammates' }} you just placed shares a
      directory value. A standing rule places the <strong>next</strong> person with that
      value into <strong>{{ orgUnitName }}</strong> automatically — nobody has to notice
      them on the unplaced worklist first, unless a broader rule already decides them.
    </p>

    <div class="mt-3 flex flex-col gap-1.5">
      <label
        v-for="c in candidates"
        :key="c.attribute"
        class="flex items-start gap-2 text-sm text-carbon-2 cursor-pointer"
        :data-testid="`rule-offer-option-${c.attribute}`"
      >
        <input v-model="chosen" type="radio" :value="c.attribute" class="mt-1" :name="`rule-offer-${orgUnitId}`">
        <span>
          When <strong>{{ c.label }}</strong> is “<strong>{{ c.value }}</strong>”, place them in
          {{ orgUnitName }}.
          <span v-if="c.shadow" class="text-rag-amber">— already decided by a broader rule</span>
        </span>
      </label>
    </div>

    <p v-if="candidates.length > 1" class="text-[11px] text-carbon-3 mt-2 leading-relaxed">
      They share more than one value. Pick the one that really describes this Business Unit —
      a rule on a company name routes everyone at that company here, not just this team.
    </p>

    <!-- The engine resolves BROAD-first, so a rule on a higher-precedence
         attribute wins whatever else also matches. Saying "the next person lands
         in X" over the top of one that already says otherwise is the claim this
         panel must not make. -->
    <div
      v-if="chosenShadow"
      class="mt-3 p-3 rounded-md bg-rag-amber/10 border border-rag-amber/40"
      data-testid="rule-offer-shadow"
    >
      <div class="text-sm font-bold text-carbon">This rule would not decide them.</div>
      <p class="text-sm text-carbon-2 mt-1 leading-relaxed">
        A rule on <strong>{{ chosenShadow.label }}</strong> “<strong>{{ chosenShadow.value }}</strong>”
        already exists and sends people to <strong>{{ chosenShadow.targetName }}</strong>. Placement
        checks the broader attribute first, so it wins for
        {{ chosenShadow.people }} of the {{ teammateIds.length }} you just placed — creating this
        rule changes nothing for them. Re-point that rule instead, or pick an attribute it does
        not cover.
      </p>
    </div>

    <p v-if="error" class="text-xs text-rag-red mt-2" data-testid="rule-offer-error" role="alert">{{ error }}</p>

    <div class="flex gap-2 mt-3">
      <UiButton kind="primary" size="sm" :disabled="saving || !chosen" data-testid="rule-offer-create" @click="createRule">
        {{ saving ? 'Saving…' : 'Create the rule' }}
      </UiButton>
      <UiButton kind="ghost" size="sm" data-testid="rule-offer-dismiss" @click="emit('dismiss')">
        Not now
      </UiButton>
    </div>
    <p class="text-[11px] text-carbon-3 mt-2">
      Declining changes nothing — the {{ teammateIds.length }} you placed stay placed.
    </p>
  </div>
</template>
