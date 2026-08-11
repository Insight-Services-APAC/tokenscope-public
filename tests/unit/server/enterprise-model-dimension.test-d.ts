/*
 * TYPE-LEVEL guard for task #32: the model dimension is DECLARED on both
 * Anthropic analytics report rows, not merely tolerated by `.passthrough()`.
 *
 * WHY A TYPE TEST AND NOT A RUNTIME ONE. `.passthrough()` already carried
 * `model` at runtime, which is precisely the problem: the billed lane's entire
 * model axis (provider_usage_fact.model, via actual_spend.raw_payload) rested on
 * a field no schema declared and no type showed. The wire capture recorded it
 * under `undeclaredByOurSchema` for two runs running. A runtime assertion cannot
 * tell a declared field from a passed-through one, so it cannot protect the
 * declaration — this can.
 *
 * WHICH CHECKER ENFORCES THIS: `npm run typecheck:types`
 * (tsconfig.type-tests.json), NOT `npm run typecheck` — the latter runs vue-tsc
 * against the Nuxt tsconfig, whose `include` does not cover tests/. See
 * scope-lane-firewall.test-d.ts for the full reasoning.
 *
 * MUTATION: delete `model: z.string().nullable().optional()` from CostRow —
 * `.passthrough()`'s index signature types the property `unknown`, which is not
 * assignable to `string | null | undefined`, and this file stops compiling.
 *
 * Deliberately `.test-d.ts`: it asserts on types and is never executed, so it
 * must not be collected by vitest as a suite with no tests in it.
 */
import type {
  EnterpriseCostRow,
  EnterpriseUsageRow,
} from '../../../server/anthropic/enterprise-client'

declare const cost: EnterpriseCostRow
declare const usage: EnterpriseUsageRow

// The COST report's model — the one task #32 named, and the one the billed
// model axis is built from.
const costModel: string | null | undefined = cost.model
// The USAGE report's, declared since the client was written. Asserted beside it
// so the two reports cannot drift apart unnoticed.
const usageModel: string | null | undefined = usage.model

void costModel
void usageModel
