// The MCP add form's two text-block fields, as pure functions.
//
// A real MCP server usually needs more than a command: the filesystem ones
// want a `cwd`, and almost every hosted one wants an API key in `environment`
// or a bearer token in `headers`. The engine's schema has taken all three
// since it shipped (ConfigMCPV1.Local.cwd / .environment, .Remote.headers) —
// the FORM was the part that could only say "command" or "url", so a server
// added here could not be given a credential and simply failed to connect.
//
// Both fields are one pair per line, because that is how the same values are
// written everywhere else the user has seen them (a .env file, a curl -H
// flag). A line that carries no separator is the one mistake worth catching
// before the write: the engine would take `{}` and write a server that starts
// without its key, and the failure would surface much later as an auth error
// from the server itself rather than as "line 2 is missing an =".
//
// PURE and webview-side on purpose. The pane needs the SAME answer it shows
// the user, and `webview/` cannot import from `src/` (tsconfig.webview.json
// pins rootDir to `webview/`), so parsing once here and posting the finished
// record beats a second copy of this logic on the host.

/** Either the parsed pairs, or the first line that could not be read. */
export type PairsResult =
  | { readonly ok: true; readonly pairs: Record<string, string> }
  | { readonly ok: false; readonly line: string };

/**
 * Read one `KEY<sep>VALUE` per line.
 *
 * Split at the FIRST separator only, so an `=` inside a token or a `:` inside
 * a header's URL value survives. Blank lines are skipped rather than refused —
 * a trailing newline is not a mistake. Key and value are both trimmed: a space
 * after the separator is a typo in every case seen, and a value that really
 * needs one can be quoted by the server's own config instead.
 *
 * A duplicate key takes the last value, the way a Record has to.
 */
export function parsePairs(text: string, separator: '=' | ':'): PairsResult {
  const pairs: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    // No separator at all, or nothing to the left of it: there is no key, so
    // there is nothing this line could mean.
    if (at <= 0) return { ok: false, line };
    const key = line.slice(0, at).trim();
    if (!key) return { ok: false, line };
    pairs[key] = line.slice(at + 1).trim();
  }
  return { ok: true, pairs };
}

/** The message a refused line gets. It quotes the line VERBATIM — a user
 *  scanning ten env vars for the broken one needs to see which, not a rule. */
export function pairsError(line: string, separator: '=' | ':', what: string): string {
  return `${what} needs one "name${separator}value" per line — "${line}" has no ${separator}.`;
}
