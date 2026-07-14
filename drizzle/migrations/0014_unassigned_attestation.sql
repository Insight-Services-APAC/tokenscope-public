-- Untagged-first enrolment: a session can be attested WITHOUT a project
-- ("unassigned"), so a CLI emits untagged, surfaces in the untagged-spend
-- worklist, and is tagged later via the assign UI. Relax the project columns on
-- session_attestation and allow a project-less setup_token.

ALTER TABLE session_attestation ALTER COLUMN project_code_hash DROP NOT NULL;
ALTER TABLE session_attestation ALTER COLUMN cost_owning_unit_id DROP NOT NULL;
ALTER TABLE setup_token ALTER COLUMN project_id DROP NOT NULL;
