/*
 * TYPE-LEVEL guard: `server_tool_use.web_search_requests` is DECLARED on the
 * Anthropic usage-report row, not merely tolerated by `.passthrough()`.
 *
 * WHY A TYPE TEST AND NOT A RUNTIME ONE. This is the same defect class
 * enterprise-model-dimension.test-d.ts exists for, one field later.
 * `.passthrough()` has been carrying `server_tool_use` into
 * `actual_spend.raw_payload` all along — the 2026-08-02 wire capture observed it
 * on 85/85 live and 257/257 stored usage rows and listed BOTH the parent and the
 * leaf under `undeclaredByOurSchema`. A runtime assertion cannot tell a declared
 * field from a passed-through one, so it cannot protect the declaration; a type
 * assertion can. Tightening `UsageRow`, or anyone reading `EnterpriseUsageRow`
 * and concluding the dimension is not there, would silently empty
 * `provider_usage_fact.web_search_requests` (mig 0122).
 *
 * WHICH CHECKER ENFORCES THIS: `npm run typecheck:types`
 * (tsconfig.type-tests.json), NOT `npm run typecheck` — the latter runs vue-tsc
 * against the Nuxt tsconfig, whose `include` does not cover tests/.
 *
 * MUTATION (verified): delete the `server_tool_use: z.object({...})` block from
 * `UsageRow` — `.passthrough()`'s index signature types the property `unknown`,
 * which is not assignable to the annotations below, and this file stops
 * compiling with "Type 'unknown' is not assignable to type ...".
 *
 * THE NULLISH SHAPE IS PART OF THE CONTRACT. The annotations below admit `null`
 * on purpose, at both levels. `.default()` substitutes only for an ABSENT key,
 * so an explicit `null` from the provider would throw, and that throw escapes
 * the per-day loop in runEnterpriseAnalyticsPoll — the deterministic silent
 * outage documented on CostRow.requests. Narrowing either annotation to exclude
 * `null` is a signal that the schema was narrowed with it.
 *
 * Deliberately `.test-d.ts`: it asserts on types and is never executed, so it
 * must not be collected by vitest as a suite with no tests in it.
 */
import type { EnterpriseUsageRow } from '../../../server/anthropic/enterprise-client'

declare const usage: EnterpriseUsageRow

// The parent object: absent, explicitly null, or an object.
const serverToolUse: { web_search_requests?: number | null } | null | undefined = usage.server_tool_use

// The leaf the capture observed on every row.
const webSearchRequests: number | null | undefined = usage.server_tool_use?.web_search_requests

void serverToolUse
void webSearchRequests
