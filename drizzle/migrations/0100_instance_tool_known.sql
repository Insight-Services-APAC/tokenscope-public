-- instance_attestation.tool must be a tool we actually know how to serve.
--
-- 0099 made the column non-blank, which was the invariant the cross-tool
-- re-provisioning guard needed: it compares stored vs requested tool to decide
-- whether rotating an instance's emit credential would revoke another CLI's,
-- and a blank value makes that undecidable.
--
-- Non-blank is weaker than what the application actually assumes. /setup/redeem
-- reads this column and used to cast it straight into a closed union:
--
--   const tool = (att.tool ?? 'claude-code') as 'claude-code' | 'copilot-cli'
--
-- so a row holding 'vim' survived the trigger, satisfied the cast, missed the
-- 'copilot-cli' branch in buildOtelBundle, and was handed a CLAUDE bundle --
-- endpoints and an env block shaped for a client that is not running. The
-- device then looked enrolled and never emitted, which is the silent-drop
-- failure this codebase keeps paying for. A cast cannot catch it; TypeScript
-- erases at runtime and the value comes from outside the type system.
--
-- That read is now a real narrowing (requireEmitTool in
-- server/auth/emit-provision.ts, which throws 409 on an unknown value), so the
-- application layer fails closed on its own. This trigger is the OTHER half:
-- every application writer already validates, and this closes the paths that do
-- not go through one -- a raw-SQL backfill, a psql session, a future writer
-- added without the check. Neither layer is redundant: the trigger cannot help
-- rows written before it, and the narrowing cannot help a reader that is not
-- the redeem handler.
--
-- On NULL. This trigger does not test for it, and the reason is NOT that NULL
-- rows exist: `tool` has been NOT NULL since the table was created (0001_schema
-- line 155, as `session_attestation`, carried through the rename), so the
-- database already refuses one and there are no rows predating the column. An
-- earlier draft of this comment claimed such rows existed and were read as
-- claude-code; that was wrong about the schema, and a false premise in the
-- justification for a constraint is worth correcting even where the resulting
-- DDL is the same. requireEmitTool()'s `stored ?? 'claude-code'` is likewise
-- unreachable defence rather than a supported state. Only a NON-NULL unknown is
-- a reachable corruption, and that is what this checks.
--
-- BEFORE INSERT OR UPDATE OF tool is preserved deliberately, exactly as 0099
-- reasoned: a pre-existing row holding an unknown tool is not revalidated by
-- unrelated lifecycle maintenance, so the UPDATE that ends or purges it -- the
-- way a human resolves one -- still works.

CREATE OR REPLACE FUNCTION instance_attestation_tool_nonblank()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF btrim(NEW.tool) = '' THEN
    RAISE EXCEPTION
      'instance_attestation.tool must be non-blank (instance_id=%)', NEW.instance_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tool NOT IN ('claude-code', 'copilot-cli') THEN
    RAISE EXCEPTION
      'instance_attestation.tool must be one of claude-code, copilot-cli (got %, instance_id=%)',
      NEW.tool, NEW.instance_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION instance_attestation_tool_nonblank() IS
  'tool must be non-blank AND a known client (claude-code, copilot-cli). Non-blank keeps the cross-tool re-provisioning guard in server/auth/emit-provision.ts decidable; the closed set is the write-side half of the fail-closed pair whose read-side half is requireEmitTool() in server/auth/emit-provision.ts, since an unknown tool once silently received a Claude bundle and never emitted. Add a value here in the same change that teaches buildOtelBundle to serve it.';
