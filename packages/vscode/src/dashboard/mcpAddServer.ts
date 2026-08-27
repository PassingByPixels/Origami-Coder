// Turning ONE `mcpAdd` message into the server object `mcp_add` wants —
// extracted out of mcpPane.ts when the add form grew the fields a real server
// needs and took that file over its cap. Nothing here touches `vscode`, the
// engine or a config file: it is the whole decision "what exactly do we ask
// the engine to write", checkable without a host.
//
// The ENGINE validates the full ConfigMCPV1.Info schema (Schema.decodeUnknown
// in packages/engine/src/acp/mcp.ts), so this is not a second validator. Its
// job is narrower and different: refuse the two states the engine would happily
// accept but the user never meant — a command that cannot spawn, and an empty
// optional block written into their config file as though it were a setting.

/**
 * A local server's command arrives as ONE string and is split into argv.
 *
 * QUOTE-AWARE, unlike the plain whitespace split this started as: an
 * interpreter on Windows lives at `C:\Program Files\nodejs\node.exe`, and
 * splitting that on spaces produced `["C:\Program", "Files\nodejs\node.exe"]`
 * — a server that could never spawn, reported as an `ENOENT` on a path the
 * user never typed. Double quotes group one argument; they may also open and
 * close mid-argument (`--root="C:/My Files"`), the way the same string would
 * behave in a shell.
 *
 * There is NO escape character, on purpose: in the values this field takes a
 * backslash is a path separator far more often than an escape, so `\` is
 * always literal and a quote cannot itself be quoted. An UNTERMINATED quote
 * keeps the rest of the line as one argument rather than dropping it — a
 * half-typed path should read as a wrong path, not vanish.
 */
export function commandFrom(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  const args: string[] = [];
  let current = '';
  let started = false; // an argument was opened, even if it is still empty ("")
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** A `KEY: value` map off the wire, kept only if it really is one. Anything
 *  else is dropped rather than forwarded: the engine would refuse the whole
 *  add on a schema error, and the pane already parsed and refused the text the
 *  user typed (webview/dashboard/components/mcpAddForm.ts). */
export function recordFrom(input: unknown): Record<string, string> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key && typeof value === 'string') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Optional keys are OMITTED when empty, never sent as `""` or `{}`: they are
 *  written verbatim into the user's config file, and an empty `environment`
 *  block there reads as a setting someone made rather than one never used. */
function withOptional(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) base[key] = value;
  return base;
}

/** The server object, or the ONE sentence to show instead of sending it. */
export function serverFrom(m: Record<string, unknown>): Record<string, unknown> | string {
  if (m['serverType'] === 'remote') {
    const url = typeof m['url'] === 'string' ? m['url'].trim() : '';
    if (!url) return 'A URL is required for a remote server.';
    return withOptional({ type: 'remote', url }, { headers: recordFrom(m['headers']) });
  }
  const command = commandFrom(m['command']);
  // An empty FIRST element means the executable is missing: `""` (or a stray
  // quote pair) gets past the pane's "not blank" check and would otherwise be
  // written as a server whose command spawns nothing.
  if (command.length === 0 || !command[0]) return 'A command is required for a local server.';
  const cwd = typeof m['cwd'] === 'string' ? m['cwd'].trim() : '';
  return withOptional(
    { type: 'local', command },
    { cwd: cwd || undefined, environment: recordFrom(m['environment']) },
  );
}
