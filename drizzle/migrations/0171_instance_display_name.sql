-- 0171: instance_attestation.display_name — a name the owner gives a device (#576).
--
-- A device was shown only as the tool and the first eight characters of its
-- id, so someone with a work laptop, a home desktop and a dev container could
-- not tell which one went silent or which to revoke. The owner can now name
-- each device on My account (PATCH /api/v1/me/instances/{id}).
--
-- DISPLAY ONLY. Nothing matches, joins, attributes or authorises on it: the
-- teammate binding stays instance_id + the emit credential. It never travels on
-- the telemetry wire, and it stays out of every report and export.
--
-- PERSONAL FIELD. The 12-month soft purge (server/workers/soft-purge.ts) clears
-- it with principal_email, claimed_email, raw_project_code and notes, and like
-- them only on an ENDED device: a device still in use keeps its name, and its
-- owner can clear it at any time (revoked devices included). The
-- rename audit event records THAT a name was set or cleared, never the name, so
-- the immutable audit log cannot outlive the purge.
--
-- The CHECK is the backstop for the route's own rule: trimmed, 1 to 40
-- characters, NULL when there is no name. RLS is unchanged: the existing
-- instance_attestation policies cover the new column like every other.

ALTER TABLE instance_attestation ADD COLUMN display_name TEXT;

ALTER TABLE instance_attestation
  ADD CONSTRAINT instance_attestation_display_name_shape
  CHECK (
    display_name IS NULL
    OR (char_length(display_name) BETWEEN 1 AND 40 AND display_name = btrim(display_name))
  );

COMMENT ON COLUMN instance_attestation.display_name IS
  'Owner-given device name, display only (never matched or attributed on). Personal: cleared by the 12-month soft purge once the device has ended; kept out of reports and exports. NULL = no name.';
