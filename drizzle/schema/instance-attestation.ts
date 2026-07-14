import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core'
import { region, orgUnit, teammate } from './identity'

export const instanceAttestation = pgTable('instance_attestation', {
  // The DEVICE / enrolment (INSTANCE) id minted at /tokenscope:enrol — the
  // unspoofable teammate binding. NOT a Claude conversation (that's Claude's
  // own session.id, captured per-record on attribution_record.claudeSessionId).
  instanceId: uuid('instance_id').primaryKey(),
  principalOid: text('principal_oid').notNull(),
  principalEmail: text('principal_email'),
  teammateId: uuid('teammate_id')
    .notNull()
    .references(() => teammate.id),
  // Nullable: an 'unassigned' attestation (untagged-first enrolment) has no
  // project until tagged via the assign UI (migration 0014).
  projectCodeHash: text('project_code_hash'),
  rawProjectCode: text('raw_project_code'),
  tool: text('tool').notNull(),
  // Vestigial — the legacy 12h session token was removed (ADR-0005 superseded it
  // with the durable OAuth emit credential). Kept nullable (not dropped) for
  // deploy-safety: the currently-deployed app may still read it during the deploy
  // window, and existing rows retain their historical hash. Never written/read after.
  sessionTokenHash: text('session_token_hash').unique(),
  tsStart: timestamp('ts_start', { withTimezone: true }).notNull().defaultNow(),
  tsExpectedEnd: timestamp('ts_expected_end', { withTimezone: true }),
  tsActualEnd: timestamp('ts_actual_end', { withTimezone: true }),
  tsPurged: timestamp('ts_purged', { withTimezone: true }),
  // Heartbeat (mig 0030): last successful /bearer mint for this instance — proof
  // it held a valid emit credential at that time. Stamped on each mint. Drives
  // heartbeat-coverage (spend whose instance has [ts_start, last_bearer_at] not
  // spanning its ts_event is "unverified"/quarantined until reconciliation).
  lastBearerAt: timestamp('last_bearer_at', { withTimezone: true }),
  regionId: uuid('region_id')
    .notNull()
    .references(() => region.id),
  orgUnitId: uuid('org_unit_id')
    .notNull()
    .references(() => orgUnit.id),
  costOwningUnitId: uuid('cost_owning_unit_id')
    .references(() => orgUnit.id), // nullable for 'unassigned' attestations (migration 0014)
  attestationState: text('attestation_state').notNull().default('attested'),
  // Identity provenance (mig 0057; emit-on-install feature). 'confirmed' = the
  // authenticated provision flow (provision_emit) or a later confirmed merge;
  // 'provisional' = an emit-on-install enroll where the human hasn't signed in
  // yet. Propagated onto attribution_record at join time. Existing rows default
  // 'confirmed' (they predate the provisional path). CHECK in ('provisional',
  // 'confirmed') lives in 0057.
  identityState: text('identity_state').notNull().default('confirmed'),
  // The email the enroll request CLAIMED (provisional rows). NULL for the
  // authenticated provision flow — principal_email already carries the verified
  // identity there.
  claimedEmail: text('claimed_email'),
  // Cross-environment reuse guard (mig 0060). NUXT_DEPLOY_ENV-classified label
  // (dev/sandbox/production/local) of the deployment that minted/owns this
  // instance. Stamped on mint; on a re-provision that supplies this instance_id,
  // a stored label differing from the current deployment's is REJECTED (409)
  // rather than silently re-minting a duplicate against the wrong environment.
  // The label (not the origin host) is used because it is stable across a custom
  // -domain cutover. NULL = legacy row (pre-0060) — treated as same-environment.
  deploymentEnv: text('deployment_env'),
  notes: jsonb('notes'),
})
