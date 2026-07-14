/*
 * Projects + repo→project map + project_assignment.
 * Sync provenance triple per data-model.md §Sync-vs-manual provenance.
 */
import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  numeric,
  integer,
  customType,
} from 'drizzle-orm/pg-core'
import { region, orgUnit, teammate } from './identity'

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

export const project = pgTable('project', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  code: text('code').notNull().unique(),
  codeHash: text('code_hash').notNull().unique(),
  displayName: text('display_name').notNull(),
  clientFacingName: text('client_facing_name'),
  type: text('type').notNull(),
  regionId: uuid('region_id')
    .notNull()
    .references(() => region.id),
  costOwningUnitId: uuid('cost_owning_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  finSystem: text('fin_system'),
  finSystemId: text('fin_system_id'),
  // WBS code from the finance system (mig 0047): the structured
  // Work-Breakdown-Structure identifier, kept for reporting / My-projects
  // correlation. Optional; TEXT to preserve structure (e.g. '1.2.3').
  wbsCode: text('wbs_code'),
  isAuthorised: boolean('is_authorised').notNull().default(true),
  isOnboarded: boolean('is_onboarded').notNull().default(false),
  allocationMode: text('allocation_mode').notNull().default('shared_pool'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Nullable, FUTURE-datable project end. NULL = open-ended. Replaces the
  // binary past-only `retired_at` (mig 0027). States (active/ending-soon/ended)
  // derive from end_date vs now; "retire" = end_date = now. See
  // docs/design/project-lifecycle.md.
  endDate: timestamp('end_date', { withTimezone: true }),
  metadata: jsonb('metadata'),
  source: text('source').notNull().default('manual'),
  isPinned: boolean('is_pinned').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
})

// project_lifecycle_policy (mig 0028) — platform-settable, region-overridable
// cadence for the project end_date model: `grace_hours` (D2 spill buffer) and
// `warn_days` (D3 ending-soon window). Scope precedence region → platform; a
// single seeded platform row is the editable baseline. NOT env vars (can't be
// set in-app), NOT a generic key/value store (typed columns + DB CHECKs). No
// `effective` range — current-state + the audit_event change log is the right
// shape for config (no point-in-time billing replay). See D9 in
// docs/design/project-lifecycle.md.
//
// CONSTRAINTS LIVE IN THE MIGRATION (0028), NOT this model: the grace>=0 /
// warn>=1 CHECKs, the scope-shape CHECK, and the two partial-unique indexes
// (the platform singleton + per-region uniqueness) are hand-written SQL that
// Drizzle can't render (a partial unique index on a constant). Migrations here
// are hand-authored and applied by drizzle/migrate.ts — do NOT run
// `drizzle-kit generate` against this model and ship its output, or those
// integrity guarantees are silently dropped.
export const projectLifecyclePolicy = pgTable('project_lifecycle_policy', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  scopeType: text('scope_type').notNull(), // 'platform' | 'region'
  scopeId: uuid('scope_id').references(() => region.id), // NULL for platform
  graceHours: integer('grace_hours').notNull(), // CHECK >= 0 (migration)
  warnDays: integer('warn_days').notNull(), // CHECK >= 1 (migration)
  updatedBy: uuid('updated_by').references(() => teammate.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const repoProjectMap = pgTable('repo_project_map', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  repoProvider: text('repo_provider').notNull(),
  repoFullName: text('repo_full_name').notNull(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => project.id),
  weight: numeric('weight', { precision: 5, scale: 4 }).notNull().default('1.0'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  source: text('source').notNull().default('manual'),
  isPinned: boolean('is_pinned').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
})

export const projectAssignment = pgTable('project_assignment', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: uuid('project_id')
    .notNull()
    .references(() => project.id),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  effective: tstzrange('effective').notNull(),
  // 'manager' (PM: may manage this project's budget top-ups, J2) | 'member'.
  // CHECK lives in mig 0048.
  role: text('role').notNull().default('member'),
  source: text('source').notNull().default('manual'),
  isPinned: boolean('is_pinned').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
})
