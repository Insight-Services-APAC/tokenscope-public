/*
 * Connect-flow shared types. The set of CLI clients TokenScope can be connected
 * to. Single source so the homepage buttons, the connect dialog, and the
 * per-client guide can't drift on which clients exist.
 */
export type ConnectClient = 'claude-code' | 'copilot-cli'
