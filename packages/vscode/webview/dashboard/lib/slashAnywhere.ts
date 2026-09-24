// slashAnywhere.ts — find a registered `/command` token anywhere in a message
// body, not just at the start. Pure leaf module (no Svelte, no vscode API) so
// the detection rule can be unit-tested without mounting the composer.
//
// Scope, deliberately narrow (t-oipmfz):
//   - The EXISTING leading-slash path (InputBar's `doSend`, `text.startsWith('/')`)
//     is untouched and unconditional — it forwards any `/word` to the host, which
//     decides validity. That behaviour is locked in by InputBar.test.ts's
//     'hands a typed /deep-plan to the host' case, where `deep-plan` is not in
//     the composer's own command list at all.
//   - This module covers the NEW case: a `/command` token appearing after the
//     start of the message. There the registry check is what keeps free text
//     ("meet me at 5/6 works") from being swallowed as a command, so a match
//     here requires `isRegistered(name)` to say yes.
//   - Only the FIRST registered token in the body is ever returned. A second
//     `/word` later in the text is left exactly where it was, as literal text
//     inside the returned argument string (owner decision 2026-09-21).

export interface SlashAnywhereMatch {
  /** Command name, lowercase, no leading slash. */
  command: string;
  /** The rest of the message with the command token removed, whitespace collapsed and trimmed. */
  args: string;
}

// `/name` at a token boundary: start of string, or preceded by whitespace.
// A `/` glued to the previous character (a URL's `example.com/delegate`, a
// fraction `5/6`) never starts a match, because there is no boundary there.
const TOKEN_RE = /(^|\s)\/([A-Za-z][\w-]*)/g;

/**
 * Scan `text` for the first `/command` token, at a token boundary, whose name
 * `isRegistered` accepts. Returns `null` when no such token exists — every
 * `/word` present is either mid-token (no boundary) or unregistered, so the
 * caller should treat the whole message as a plain prompt.
 */
export function findSlashAnywhere(
  text: string,
  isRegistered: (name: string) => boolean,
): SlashAnywhereMatch | null {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    const name = m[2].toLowerCase();
    if (!isRegistered(name)) continue;
    const tokenStart = m.index + m[1].length;
    const tokenEnd = tokenStart + 1 + m[2].length; // '/' + the name
    const before = text.slice(0, tokenStart);
    const after = text.slice(tokenEnd);
    const args = (before + after).replace(/\s+/g, ' ').trim();
    return { command: name, args };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The COMPLETION side (t-qi09w0 item 3)
// ---------------------------------------------------------------------------
//
// `findSlashAnywhere` above answers "which command does this finished message
// run?" — EXECUTION, still first-command-only. These two answer a different
// question: "is the caret inside a `/command` the user is typing RIGHT NOW?",
// which is what decides whether the autocomplete is on screen. The owner's
// rule: the popup opens wherever the token is, the execution rule is unchanged.
//
// Mirrors collabMentions.ts's mentionQuery/applyMention deliberately — the `/`
// palette and the `@` picker are the same object on screen, so they should not
// be two different sets of caret rules underneath.

export interface SlashCaretQuery {
  /** Index of the `/` that starts the token. */
  start: number;
  /** What has been typed after it, up to the caret. '' right after the `/`. */
  query: string;
}

/** A partially-typed command name: a letter first, then word characters or `-`.
 *  Empty is allowed — the bare `/` the user just pressed offers the whole list. */
const PARTIAL_NAME = /^(|[A-Za-z][\w-]*)$/;

/**
 * The `/command` token the caret sits in, or null when it is not in one.
 *
 * Null closes the popup, and a space is what usually produces it: once the name
 * is finished the user is writing arguments, not choosing a command. The token
 * boundary rule is `findSlashAnywhere`'s — a `/` glued to the previous
 * character ("5/6", "example.com/delegate") starts nothing.
 */
export function slashQueryAt(text: string, caret: number): SlashCaretQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const start = before.lastIndexOf('/');
  if (start === -1) return null;
  if (start > 0 && !/\s/.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  return PARTIAL_NAME.test(query) ? { start, query } : null;
}

/**
 * Replace the half-typed token at [start, end) with `insert`, returning the new
 * text and where the caret belongs — AFTER the insertion, not at the end of the
 * line, because a command named mid-sentence has prose behind it that the user
 * is still writing.
 */
export function replaceSlashToken(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  // The completion carries a trailing space so the next word cannot glue on; mid
  // sentence there is usually one there already, and two would be a defect the
  // reader sees in their own prose.
  const glue = insert.endsWith(' ') && /\s/.test(text[to] ?? '') ? insert.slice(0, -1) : insert;
  return { text: text.slice(0, from) + glue + text.slice(to), caret: from + glue.length };
}

export interface SlashPaletteState {
  /** Is the palette on screen? */
  open: boolean;
  /** What to filter the command list by. */
  filter: string;
  /** The span a completion replaces — see `replaceSlashToken`. */
  start: number;
  end: number;
}

/**
 * The composer's whole palette rule, in one place so InputBar holds none of it.
 *
 * TWO WAYS IN, and keeping them distinct is the point. A LEADING slash spans the
 * WHOLE LINE and filters on all of it — the original rule, bit for bit, so
 * "/deep-plan x" still behaves as it always did and a completion still replaces
 * the line. Anywhere else it is the token under the CARET and spans only itself,
 * so the prose around it survives the completion.
 */
export function slashPaletteAt(text: string, caret: number): SlashPaletteState {
  if (text.startsWith('/')) return { open: true, filter: text.slice(1), start: 0, end: text.length };
  const at = slashQueryAt(text, caret);
  if (!at) return { open: false, filter: '', start: 0, end: text.length };
  return { open: true, filter: at.query, start: at.start, end: caret };
}

// ---------------------------------------------------------------------------
// EXECUTION: what does a finished message dispatch to?
// ---------------------------------------------------------------------------
//
// Moved out of InputBar.svelte's `doSend` VERBATIM in behaviour (t-qi09w0): the
// composer was at 1221 of its 1230-line cap and the palette work above needed
// the room, and the owner's first-command-only rule deserved to be a function
// with tests rather than two nested branches inside a send handler.
//
// The two branches are NOT symmetrical, deliberately:
//   - A LEADING slash forwards ANY `/word`, unregistered included. The host
//     decides validity, which is what lets a command the composer has never
//     heard of ("/deep-plan") still work.
//   - A token named mid-body is registry-gated, or "meet me at 5/6" would be
//     swallowed as a command.

export type SlashDispatch =
  /** No command: send the text as an ordinary prompt. */
  | { kind: 'prompt' }
  /** `loop` / `compose` — built-in modes that go through the SEND path, so the
   *  composer shows in-flight and Stop works like a normal turn. */
  | { kind: 'send'; command: string; args: string }
  /** Everything else: the host's `slashCommand` handler. */
  | { kind: 'host'; command: string; args: string };

const SEND_PATH = new Set(['loop', 'compose']);

function route(command: string, args: string): SlashDispatch {
  return { kind: SEND_PATH.has(command) ? 'send' : 'host', command, args };
}

export function slashDispatch(text: string, isRegistered: (name: string) => boolean): SlashDispatch {
  if (text.startsWith('/')) {
    const parts = text.slice(1).split(/\s+/);
    return route(parts[0] || '', parts.slice(1).join(' '));
  }
  const anywhere = findSlashAnywhere(text, isRegistered);
  return anywhere ? route(anywhere.command, anywhere.args) : { kind: 'prompt' };
}
