// Fork — branch this chat into a new tab carrying the whole conversation, without spending the
// thread you're in. Clones the engine session (`unstable_forkSession`, acpFork.ts) and opens the
// clone as its own independent chat; this file is the decisions around that call, routed out of
// DashboardPanel.ts like sessionDelete.ts.
// t-v5qv6u: a fork WRITES NOTHING into the chat it was forked from — no user row, no turn
// signal, no prompt. `/btw` used to echo itself there and post `turnDone`, so the original chat
// showed '/btw' as a user message just before its agent's next reply.
// Three refusals, each a `system` line and nothing else (an `error` would end a running turn
// there): no engine session yet; a Claude Code passthrough cell (its transcript lives in the
// CLI's own store, not the engine's); a fork call that throws.
// No vscode import: every branch runs against a fake host, per sessionDelete.ts's convention.

/** The panel's webview post, narrowed to what this leaf sends. */
type Post = (msg: Record<string, unknown>) => void;

/** The composer's Fork button posts `{ type: 'forkChat', sessionId }` — the POSTING cell's
 *  chat, so a grid forks the chat the button sits under. */
export const FORK_CHAT_MESSAGE_TYPES: ReadonlySet<string> = new Set(['forkChat']);

export interface ForkHost {
  post: Post;
  /** The engine session id backing a chat, or null/undefined when its client
   *  has not established one yet. */
  engineIdOf(sessionId: string): string | null | undefined;
  /** What to call the source chat in the fork's opening line — its title, else
   *  a stable fallback like `chat 3`. */
  labelOf(sessionId: string): string;
  /** True when the chat is a Claude Code passthrough cell (refusal 2). */
  isPassthroughCell(sessionId: string): boolean;
  /** Create the new chat + tab against a forked engine session. Resolves with
   *  the NEW local session id. */
  fork(source: { sessionId: string; label: string }): Promise<string>;
  /** Send the first prompt into a chat, through the panel's ordinary send path
   *  (so it echoes, names the tab and settles the ring like any other turn). */
  send(sessionId: string, text: string): void;
}

/** What the shell says in a chat once its engine session is up — one function so the three ways to
 *  get a session can't drift into different greetings. States what's NOT obvious from the replayed
 *  transcript: the engine does not copy the parent's permission preset (fork defaults to `default`)
 *  but does copy the todo list. */
export function startSystemLine(acpSessionId: string, loadSessionId?: string, forkedFrom?: string): string {
  if (forkedFrom) {
    return `Forked from ${forkedFrom}. Session ${acpSessionId}. The whole conversation above came with it; the plan carried over, and permissions reset to ask-first.`;
  }
  if (loadSessionId) return `Recalled session ${acpSessionId}. Continue the conversation below.`;
  return `Connected. Session ${acpSessionId}. Type a message and press Enter.`;
}

/** The chat label a fork names its parent by. */
export function sessionLabel(title: string | undefined, number: number): string {
  const trimmed = (title ?? '').trim();
  return trimmed.length > 0 ? trimmed : `chat ${number}`;
}

/**
 * Fork `sessionId` into a new chat. `firstPrompt`, when present, becomes the FORK's first
 * prompt (a typed `/btw <text>`). A success posts nothing to the source chat; a refusal posts
 * one `system` line there, which the agent never sees.
 */
export async function forkChat(sessionId: string, host: ForkHost, firstPrompt = ''): Promise<void> {
  const refuse = (text: string) => host.post({ type: 'system', text, sessionId });

  if (host.isPassthroughCell(sessionId)) {
    refuse('Fork cannot copy a Claude Code chat yet — its history lives in the Claude CLI, not in the engine. Use it in an Origami chat.');
    return;
  }

  const engineId = host.engineIdOf(sessionId);
  if (!engineId) {
    refuse('Fork needs an engine session to copy. This chat has not started one yet — send a message first, then fork it.');
    return;
  }

  try {
    const forkedInto = await host.fork({ sessionId: engineId, label: host.labelOf(sessionId) });
    // The prompt goes in AFTER the fork's tab exists, so it lands in the new chat, not the source.
    if (firstPrompt) host.send(forkedInto, firstPrompt);
  } catch (e) {
    refuse(`Fork failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
