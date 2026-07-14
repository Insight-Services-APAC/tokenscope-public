-- 0060: instance_attestation.deployment_env — cross-environment reuse guard.
--
-- PROBLEM. When a client re-provisions a device against a DIFFERENT deployment
-- (e.g. Sandbox → Dev, later Dev → Production) it may still carry the
-- tokenscope.instance_id minted by the OLD environment's DB. That id does not
-- exist (or is not owned by the bearer) in the NEW environment's DB, so
-- locateOrCreateInstance used to SILENTLY fall through and mint a brand-new
-- instance — no signal that a duplicate device record was just created in the
-- wrong place. Worse, if the SAME Postgres were ever shared across logical
-- environments, a stale id could collide.
--
-- FIX. Record which deployment ENVIRONMENT an instance belongs to. On MINT the
-- provision path stamps this deployment's NUXT_DEPLOY_ENV-classified label here
-- ('dev' / 'sandbox' / 'production' / 'local'); on REUSE it compares the stored
-- label against the current one and REJECTS a cross-environment reuse loudly
-- (409-style) instead of minting a silent duplicate.
--
-- Why the deploy-env LABEL, not the request/public-origin HOST: the label is the
-- canonical "which deployment am I" signal (shared/env/deploy-env.ts /
-- currentServerDeployEnv, the same classifier dev-login / admin-settings / obo
-- use; container-app.bicep:223 documents that the host is NOT this signal). The
-- label is STABLE across a custom-domain cutover (Dev moved off the sandbox Front
-- Door host once already), where an origin host would change and falsely reject
-- same-environment instances.
--
-- Nullable + back-compat: existing rows predate this column and carry NULL. NULL
-- is treated as "same environment" on reuse (legacy rows are never broken), and
-- the server back-fills it to the current label on the next reuse. No backfill is
-- performed here — a migration cannot know which deployment a historical row
-- belonged to.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS), matching the rest of the migration set.

ALTER TABLE instance_attestation
  ADD COLUMN IF NOT EXISTS deployment_env text;

COMMENT ON COLUMN instance_attestation.deployment_env IS
  'NUXT_DEPLOY_ENV-classified label (dev/sandbox/production/local) of the deployment that minted/owns this instance. Cross-environment reuse guard: a supplied instance_id whose stored label differs from the current deployment is rejected, not silently re-minted. NULL = legacy row (pre-0060), treated as same-environment.';
