/*
 * .tokenscope reader — compatibility re-export.
 *
 * The walk-up + tiny-YAML parser (findTokenscopeFile / parseTokenscope) was
 * EXTRACTED into the client-neutral, syncable module tokenscope-project.mjs so
 * the Copilot forwarder can reuse the SAME derivation (P0-2). Importing them from
 * there — rather than duplicating — guarantees Claude + Copilot hash an identical
 * `.tokenscope` to the same project.code_hash (drift = split attribution).
 *
 * This file remains as the long-standing import surface for the Claude-side
 * callers (tag-repo.mjs, the SessionStart hook, the reader unit tests). New code
 * should import directly from tokenscope-project.mjs.
 *
 * Schema reference: docs/build/mvp-lite-epic.md §`.tokenscope` file shape.
 * Returns { project: { code, id, name }, optional: { client, practice,
 * engagement_type, pm } }.
 */
export { findTokenscopeFile, parseTokenscope } from './tokenscope-project.mjs'
