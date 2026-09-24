// claudeScanNote.ts — the one line the History popup shows when the Claude Code
// rows are switched ON and none came back (t-5nmtva).
//
// WHY IT EXISTS. A work laptop reported "History finds no Claude Code sessions"
// and the report could not be acted on: nobody could say which directory had
// been read, whether it even existed, or what name was looked for in it. The
// three facts that answer all of that — the root, how many project folders were
// in it, the key — are already known on the host side (claudeHistory.ts's
// ClaudeScanFacts), so the only thing missing was saying them.
//
// A LEAF because ChatsList.svelte is on its 800-line cap and this is a decision,
// not drawing: WHEN a line is warranted and WHAT it reads are testable with no
// DOM, the same split historyKinds.ts already made beside it.
//
// IT IS NOT AN ERROR. "No sessions here" is the ordinary answer for a workspace
// Claude Code has never run in, so the line is a dim footer, never a banner —
// it just names what was looked at, in case the answer is wrong.

/** What the host says it scanned; absent on a row payload from an older host
 *  build. MIRRORS `ClaudeScanFacts` in src/acpExtTypes.ts rather than importing
 *  it: a webview .ts that reaches into src/ breaks the type gate (TS6059), the
 *  same wall labyrinthHealth.ts's `RunStatRow` hit. claudeScanNote.test.ts reads
 *  both files and fails when the two drift — which is what the review asked for,
 *  since the shapes cannot be made one declaration here. */
export interface ClaudeScanFacts {
  root: string;
  seen: number;
  keys: string[];
}

/** Keys named in full. Beyond this the line would be longer than the popup. */
const MAX_KEYS = 2;

/**
 * The footer line, or `undefined` when there is nothing to explain — the rows
 * arrived, or the user has the Claude kind switched off, or the host is an
 * older build that sends no facts.
 */
export function claudeScanNote(
  scan: ClaudeScanFacts | undefined,
  showClaude: boolean,
  rows: readonly { kind?: string }[],
): string | undefined {
  if (!showClaude || !scan || !scan.root) return undefined;
  if (rows.some((r) => r?.kind === 'claude')) return undefined;
  const keys = scan.keys ?? [];
  // No open folder to look for is a different fact from a root that held
  // nothing, and a reader who cannot tell them apart is back where we started.
  const looked = keys.length === 0
    ? 'no open folder to match'
    : `looked for ${keys.slice(0, MAX_KEYS).join(', ')}${keys.length > MAX_KEYS ? ` +${keys.length - MAX_KEYS} more` : ''}`;
  return `No Claude Code chats. Scanned ${scan.root} — ${scan.seen} project folder${scan.seen === 1 ? '' : 's'}, ${looked}.`;
}
