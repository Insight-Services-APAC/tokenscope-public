// @vitest-environment node
/*
 * session-gc — OAuth-lifecycle sweep (AUTH-5, robustness review 2026-06-09).
 *
 * Every MCP client install dynamically registers a NEW oauth_client row on the
 * unauthenticated RFC 7591 endpoint, and nothing ever deleted clients, expired/
 * consumed auth codes, emit handoffs, or expired/revoked tokens — abandoned
 * registrations monotonically fill the MAX_OAUTH_CLIENTS cap until registration
 * 429s forever. The GC worker now sweeps all four, with retention graces.
 *
 * S6 adds a SECOND, much shorter (1h) sweep for clients that NEVER had a
 * token or auth code at all — reclaiming abandoned/flood registrations fast
 * instead of waiting the full 30-day CREDENTIAL_GC_GRACE_DAYS. It runs BEFORE
 * the other deletes so its "never transacted" reading is accurate; the 30-day
 * sweep further down is what still catches clients that DID transact but are
 * now fully cold. See ABANDONED_QUICK_CLIENT / MID_FLOW_CLIENT below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runSessionGc } from '../../../server/workers/session-gc'

let t: TestDb

// MUST track wall-clock: the fixtures below are inserted with SQL NOW()
// (real time), so a calendar-pinned constant here goes stale the moment the
// wall-clock drifts past it — the sweep cutoffs (computed from THIS value)
// then sit before the fixtures' created_at and nothing deletes. That time
// bomb shipped pinned to 2026-06-09 and detonated on 2026-06-10. The
// intervals in the fixtures (minutes–days) dwarf test-runtime skew, so a
// live `new Date()` is deterministic for every assertion.
const NOW = new Date()
const TEAM = '33333333-3333-3333-3333-333333333333'
const INST = '66666666-6666-6666-6666-666666666666'

// oauth_client ids
const STALE_CLIENT = 'c0c0c0c0-0000-0000-0000-000000000001' // old, no tokens/codes → swept (abandoned sweep)
const LIVE_CLIENT = 'c0c0c0c0-0000-0000-0000-000000000002' // old, but holds a LIVE token → kept
const FRESH_CLIENT = 'c0c0c0c0-0000-0000-0000-000000000003' // registered yesterday → kept
const INTERNAL_CLIENT = 'c0c0c0c0-0000-0000-0000-000000000004' // internal emit client → never swept
const DEAD_TOKEN_CLIENT = 'c0c0c0c0-0000-0000-0000-000000000005' // old; its dead token sweeps first, then the client goes too (30-day sweep)
const ABANDONED_QUICK_CLIENT = 'c0c0c0c0-0000-0000-0000-000000000006' // 2h old, never had a token/code → swept (S6, well before the 30-day grace)
const MID_FLOW_CLIENT = 'c0c0c0c0-0000-0000-0000-000000000007' // 2h old, but has a LIVE auth code → kept (S6 "must not delete mid-flow")

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('${TEAM}', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id, attestation_state)
    VALUES
      ('${INST}', 'oid', 'dev@i.com', '${TEAM}', NULL, NULL,
       'claude-code', 'hashS', NOW() - INTERVAL '1 day', NOW(),
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       NULL, 'unassigned');

    INSERT INTO oauth_client (client_id, client_secret_hash, client_name, redirect_uris, internal, created_at)
    VALUES
      ('${STALE_CLIENT}', 'h1', 'Abandoned MCP', '{"http://127.0.0.1/cb"}', false, '2026-04-01 00:00:00+00'),
      ('${LIVE_CLIENT}', 'h2', 'Live MCP', '{"http://127.0.0.1/cb"}', false, '2026-04-01 00:00:00+00'),
      ('${FRESH_CLIENT}', 'h3', 'Fresh MCP', '{"http://127.0.0.1/cb"}', false, '2026-06-08 00:00:00+00'),
      ('${INTERNAL_CLIENT}', 'h4', 'tokenscope-emit', '{"http://127.0.0.1/cb"}', true, '2026-01-01 00:00:00+00'),
      ('${DEAD_TOKEN_CLIENT}', 'h5', 'Dead-token MCP', '{"http://127.0.0.1/cb"}', false, '2026-04-01 00:00:00+00'),
      ('${ABANDONED_QUICK_CLIENT}', 'h6', 'Abandoned Quick', '{"http://127.0.0.1/cb"}', false, NOW() - INTERVAL '2 hours'),
      ('${MID_FLOW_CLIENT}', 'h7', 'Mid Flow', '{"http://127.0.0.1/cb"}', false, NOW() - INTERVAL '2 hours');

    INSERT INTO oauth_token
      (access_token_hash, refresh_token_hash, client_id, teammate_id, scope,
       access_issued_at, access_expires_at, refresh_issued_at, refresh_expires_at, revoked_at)
    VALUES
      -- LIVE token (refresh valid, not revoked) → kept; keeps LIVE_CLIENT too.
      ('at-live', 'rt-live', '${LIVE_CLIENT}', '${TEAM}', 'tokenscope.read',
       NOW(), NOW() + INTERVAL '30 days', NOW(), NOW() + INTERVAL '90 days', NULL),
      -- Revoked LONG ago (past the 30d grace) → swept.
      ('at-revoked-old', 'rt-revoked-old', '${DEAD_TOKEN_CLIENT}', '${TEAM}', 'tokenscope.read',
       '2026-03-01 00:00:00+00', '2026-04-01 00:00:00+00', '2026-03-01 00:00:00+00',
       '2026-06-01 00:00:00+00', '2026-03-02 00:00:00+00'),
      -- Refresh expired long ago, never revoked → swept.
      ('at-expired-old', 'rt-expired-old', '${LIVE_CLIENT}', '${TEAM}', 'tokenscope.emit',
       '2026-01-01 00:00:00+00', '2026-02-01 00:00:00+00', '2026-01-01 00:00:00+00',
       '2026-04-01 00:00:00+00', NULL),
      -- Revoked RECENTLY (inside the grace) → kept for the audit window.
      ('at-revoked-new', 'rt-revoked-new', '${LIVE_CLIENT}', '${TEAM}', 'tokenscope.read',
       NOW() - INTERVAL '2 days', NOW() + INTERVAL '28 days', NOW() - INTERVAL '2 days',
       NOW() + INTERVAL '88 days', NOW() - INTERVAL '1 day');

    INSERT INTO oauth_auth_code
      (code_hash, client_id, teammate_id, redirect_uri, code_challenge, code_challenge_method,
       scope, created_at, expires_at, consumed_at)
    VALUES
      -- Consumed two days ago (past the 24h artifact grace) → swept.
      ('code-consumed-old', '${LIVE_CLIENT}', '${TEAM}', 'http://127.0.0.1/cb', 'ch', 'S256',
       'tokenscope.read', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
      -- Expired unconsumed two days ago → swept.
      ('code-expired-old', '${LIVE_CLIENT}', '${TEAM}', 'http://127.0.0.1/cb', 'ch', 'S256',
       'tokenscope.read', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NULL),
      -- Consumed minutes ago (inside the grace; replay must still see invalid_grant) → kept.
      ('code-consumed-new', '${FRESH_CLIENT}', '${TEAM}', 'http://127.0.0.1/cb', 'ch', 'S256',
       'tokenscope.read', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes'),
      -- Live (unconsumed, unexpired) → kept.
      ('code-live', '${FRESH_CLIENT}', '${TEAM}', 'http://127.0.0.1/cb', 'ch', 'S256',
       'tokenscope.read', NOW(), NOW() + INTERVAL '5 minutes', NULL),
      -- Live auth code on a client past the 1h abandonment grace (S6): proves
      -- the short sweep does not delete a client mid-flow.
      ('code-mid-flow', '${MID_FLOW_CLIENT}', '${TEAM}', 'http://127.0.0.1/cb', 'ch', 'S256',
       'tokenscope.read', NOW(), NOW() + INTERVAL '5 minutes', NULL);

    INSERT INTO emit_handoff (code_hash, teammate_id, instance_id, created_at, expires_at, consumed_at)
    VALUES
      ('handoff-consumed-old', '${TEAM}', '${INST}', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
      ('handoff-live', '${TEAM}', '${INST}', NOW(), NOW() + INTERVAL '5 minutes', NULL);
  `)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runSessionGc — OAuth-lifecycle sweep (AUTH-5)', () => {
  it('sweeps stale clients, old codes/handoffs, and dead tokens — keeps everything live or in-grace', async () => {
    const result = await runSessionGc(t.db, NOW)
    expect(result.authCodesDeleted).toBe(2)
    expect(result.emitHandoffsDeleted).toBe(1)
    expect(result.oauthTokensDeleted).toBe(2)
    // Never transacted at all, past the 1h abandonment grace (S6):
    // STALE_CLIENT + ABANDONED_QUICK_CLIENT.
    expect(result.abandonedClientsDeleted).toBe(2)
    // DID transact (DEAD_TOKEN_CLIENT) — its dead token sweeps earlier in the
    // same run, then the 30-day sweep catches the now-cold client.
    expect(result.oauthClientsDeleted).toBe(1)

    const clients = await t.client<{ client_id: string }[]>`
      SELECT client_id::text AS client_id FROM oauth_client ORDER BY client_id`
    const remaining = clients.map((c) => c.client_id)
    expect(remaining).not.toContain(STALE_CLIENT)
    expect(remaining).not.toContain(DEAD_TOKEN_CLIENT)
    expect(remaining).not.toContain(ABANDONED_QUICK_CLIENT)
    expect(remaining).toContain(LIVE_CLIENT)
    expect(remaining).toContain(FRESH_CLIENT)
    expect(remaining).toContain(INTERNAL_CLIENT)
    // A live auth code protects a client from the abandonment sweep even
    // though it's past the 1h grace — the sweep must not delete mid-flow.
    expect(remaining).toContain(MID_FLOW_CLIENT)

    const tokens = await t.client<{ access_token_hash: string }[]>`
      SELECT access_token_hash FROM oauth_token ORDER BY access_token_hash`
    expect(tokens.map((x) => x.access_token_hash)).toEqual(['at-live', 'at-revoked-new'])

    const codes = await t.client<{ code_hash: string }[]>`
      SELECT code_hash FROM oauth_auth_code ORDER BY code_hash`
    expect(codes.map((c) => c.code_hash)).toEqual(['code-consumed-new', 'code-live', 'code-mid-flow'])

    const handoffs = await t.client<{ code_hash: string }[]>`
      SELECT code_hash FROM emit_handoff ORDER BY code_hash`
    expect(handoffs.map((h) => h.code_hash)).toEqual(['handoff-live'])
  })

  it('second run is a clean no-op (idempotent)', async () => {
    const second = await runSessionGc(t.db, NOW)
    expect(second.oauthClientsDeleted).toBe(0)
    expect(second.abandonedClientsDeleted).toBe(0)
    expect(second.authCodesDeleted).toBe(0)
    expect(second.emitHandoffsDeleted).toBe(0)
    expect(second.oauthTokensDeleted).toBe(0)
  })
})
