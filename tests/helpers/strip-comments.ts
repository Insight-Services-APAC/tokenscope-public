/**
 * Comment stripping for the STATIC GATES — shared by every test that greps our
 * own source for a pattern it must not contain.
 *
 * WHY THIS IS A SCANNER AND NOT A REGEX. The gates need "a note ABOUT a deleted
 * thing is not the thing": they read `.ts` / `.vue` files off disk and search the
 * code, so a comment naming the retired defect must not count as the defect.
 *
 * The obvious implementation is `src.replace(/<!--[\s\S]*?-->/g, '')`, and it is
 * wrong twice over — I shipped both wrong versions before writing this
 * (CodeQL, PR #238):
 *
 *   1. `js/incomplete-multi-character-sanitization`. Removing a paired sequence
 *      in one pass can SPLICE the remainder into a fresh opener:
 *      `<!<!-- x -->-- y` becomes `<!-- y`. The vector is a SPLIT marker, not a
 *      nested one — `<!--a<!--b-->-->` strips cleanly. And looping to a fixpoint
 *      does NOT fix it: the spliced opener is unterminated, so the next pass
 *      matches nothing and the loop exits with the residue intact.
 *   2. `js/bad-tag-filter`. Adding `.replace(/<!--|-->/g, '')` to mop up the
 *      residue introduced a NEW alert: HTML also ends a comment with `--!>`, so
 *      a regex naming only `-->` is an incomplete tag filter.
 *
 * Both alerts are, in this repo, about a sanitizer protecting an HTML sink —
 * and there is no sink here: trusted input (our own checked-in files), no
 * rendering, no untrusted data. But chasing HTML comment edge cases with regexes
 * is unwinnable, because the grammar genuinely has them. A scanner sidesteps the
 * whole class: it consumes regions rather than substituting text, so nothing it
 * emits can be spliced into a marker, and its end-of-comment rule is stated once
 * and completely.
 *
 * Regions removed: block comments, HTML comments (accepting BOTH `-->` and
 * `--!>` as terminators, per the HTML spec's comment-end-bang state), and line
 * comments. An unterminated region runs to end of input — the correct reading,
 * and the safe one for a gate: unterminated means everything after it is
 * commented out, so nothing there should count as live code.
 */

/** `://` must not read as a line comment — the URL case these gates hit daily. */
function isSchemeSlashes(src: string, i: number): boolean {
  return i > 0 && src[i - 1] === ':'
}

/**
 * THE REPLACEMENT IS ALWAYS A SPACE, AND THAT IS THE WHOLE FIX.
 *
 * Deleting a region makes the characters either side ADJACENT, and adjacency is
 * what manufactures a marker: `<!<!-- x -->-- y` with an empty replacement emits
 * `<!` then `-- y` and yields `<!-- y`. A scanner does not escape this — I
 * watched this very function do it — because the defect is in the deletion, not
 * in how the region was found.
 *
 * A single space makes it impossible by construction: no two retained characters
 * ever touch, so no pair of fragments can form `<!--`, `/*` or `//`. That is also
 * why it must not be caller-configurable — an empty replacement was available
 * before, one of the two callers used it, and that caller was the one CodeQL
 * flagged.
 */
const REPLACEMENT = ' '

export function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length

  while (i < n) {
    // Block comment
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      out += REPLACEMENT
      i = end === -1 ? n : end + 2
      continue
    }
    // HTML comment — ends at `-->` OR `--!>`, whichever comes first.
    if (src.startsWith('<!--', i)) {
      const a = src.indexOf('-->', i + 4)
      const b = src.indexOf('--!>', i + 4)
      let end: number
      if (a === -1 && b === -1) end = -1
      else if (a === -1) end = b + 4
      else if (b === -1) end = a + 3
      else end = a < b ? a + 3 : b + 4
      out += REPLACEMENT
      i = end === -1 ? n : end
      continue
    }
    // Line comment
    if (src.startsWith('//', i) && !isSchemeSlashes(src, i)) {
      const end = src.indexOf('\n', i + 2)
      out += REPLACEMENT
      i = end === -1 ? n : end
      continue
    }
    out += src[i]
    i += 1
  }
  return out
}
