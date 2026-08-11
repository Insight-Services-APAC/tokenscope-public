/*
 * real-home.mjs — the account's real home directory.
 *
 * Its own module because it is shared by BOTH plugins and by code that must not
 * pull in plugin-runtime.mjs. mcp-origin.mjs is vendored into copilot-plugin/,
 * which does not vendor plugin-runtime.mjs, so importing it from there breaks
 * the Copilot bundle outright. Copying the function instead would leave two
 * implementations of a security primitive to drift apart, which is the worse
 * failure: this is the function that decides whether a moved $HOME can choose
 * where a durable credential is written and which file names the host a live
 * handoff code is posted to.
 */
import { homedir, userInfo } from 'node:os'

/**
 * The account's REAL home, HOME-leak-proof. `os.homedir()` trusts the `HOME`
 * env var first, so a container/`cw` event that leaks `HOME=/tmp/ts-home-*`
 * into a spawned process makes it resolve a phantom home — the exact recurring
 * silent-drop bug (the forwarder resolved its DCE stash under the leaked home,
 * found nothing, and 502'd every export). `os.userInfo().homedir` reads the
 * passwd entry (getpwuid), which the `HOME` env cannot move, so every plugin
 * component agrees on one real `~/.tokenscope` regardless of env leaks. Falls
 * back to `homedir()` only if the passwd lookup itself throws (extremely rare).
 *
 * Exported because the same leak is a TRUST problem, not just a reliability
 * one, anywhere a path decides who receives a secret. Discovery of the redeem
 * host reads user configuration under `~`, and the durable emit credential is
 * written under `~`; a moved `HOME` therefore picks both the file that names
 * the destination and the directory the credential lands in. Reading a file
 * only to learn what Claude Code itself will read is the opposite case and
 * still belongs on `homedir()` -- see stateDir() in plugin-runtime.mjs.
 */
export function realHome() {
  try {
    const h = userInfo().homedir
    if (h) return h
  } catch {
    /* fall through to the last-resort branch below */
  }
  // Last resort (passwd unavailable — e.g. a minimal container with no
  // /etc/passwd entry for the uid). This branch DOES follow HOME, so it can
  // reinstate the leak — but only in the rare no-passwd case AND only when no
  // TOKENSCOPE_STATE_DIR pin is set (the override is consulted before realHome).
  // Make the degradation LOUD (stderr, best-effort) so a silent drop in that
  // corner is at least attributable instead of invisible.
  try {
    process.stderr.write(
      '[tokenscope] WARN: os.userInfo() unavailable; state dir falls back to HOME (leak-susceptible). Set TOKENSCOPE_STATE_DIR to pin it.\n',
    )
  } catch {
    /* best effort */
  }
  return homedir()
}
