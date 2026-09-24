// flags.ts — what a passthrough vector may never carry (FORBIDDEN_FLAGS), and what a clean-room
// reviewer vector adds (ISOLATION_FLAGS). Re-exported from protocol.ts so no caller changed an
// import.

/** Flags that would hand a passthrough child unsupervised tool access. Phase 1
 *  never emits them; the guard exists so a later edit cannot slip one in
 *  unnoticed (it is asserted over the built vector, not over a code review). */
export const FORBIDDEN_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
];


/** Throws if a built vector carries a permission-bypass flag. Called by
 *  buildArgs on every build AND by the driver before it spawns. */
export function assertNoBypass(args: readonly string[]): void {
  for (const a of args) {
    for (const bad of FORBIDDEN_FLAGS) {
      if (a === bad || a.includes(bad)) {
        throw new Error(`claudeCode: refusing to spawn with a permission-bypass flag (${a})`);
      }
    }
  }
}


/**
 * What makes a second-opinion spawn a clean room: a reviewer reads a digest, answers once, and is
 *  gone, so anything a chat needs becomes a way for a review to have side effects.
 * `--no-session-persistence` keeps a review out of the CLI's session store; `--strict-mcp-config` +
 *  `--mcp-config {}` gives the reviewer no MCP servers; `--settings disableAllHooks` stops it
 *  firing the user's own hooks.
 * `--setting-sources=user,project,local` stays — it is the proven production vector and how the
 *  child reaches the user's subscription, and the two parts of it that could act (MCP servers,
 *  hooks) are already neutralised above.
 */
export const ISOLATION_FLAGS: readonly string[] = [
  '--no-session-persistence',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--settings', '{"disableAllHooks":true}',
];
