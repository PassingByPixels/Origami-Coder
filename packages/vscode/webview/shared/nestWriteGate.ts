// nestWriteGate.ts — t-t7lfho: the ONE place a webview stops a write into a
// chat this desk gave to another desk. getVsCodeApi() (vscodeApi.ts) passes
// every post through `blocks`, so the composer, the transcript's Retry and
// Rewind, a tool card's shell stop and a tab rename are all held by the same
// record. The record is the host's `away` list in origami/nestIndex
// (src/dashboard/nestAway.ts); each push replaces it. The engine's read-only
// guard (engine/src/acp/nests.ts) stays as the backstop.
//
// NEST_WRITE_TYPES = the pane's messages that start a turn or reach a guarded
// engine write for the SAME session (prompt, interject, shell_stop, and the
// setSessionConfigOption ids in ROW_WRITING_CONFIG, engine/src/acp/service.ts).
// Not here, on purpose: cancel and permission (they stop or answer; they write
// no row), dismissSubagent (workspaceState only), secondOpinion (a read-only
// review), stopSubagent (a child session). slashCommand carries its chat's id since t-xsufto (an engine command
// prompts that chat), so it is gated like send, although the composer is not drawn on an away chat.

export const NEST_WRITE_TYPES: ReadonlySet<string> = new Set([
  'send', 'sendWithImages', 'interject', 'compactContext', 'planAction',
  'revertToMessage', 'undoRevert', 'renameSession',
  'setSubagentModel', 'setApproveMode', 'setVisionProfile', 'setCompactionThreshold',
  'stopBackgroundShell', 'slashCommand',
]);

let away: ReadonlySet<string> = new Set();
let listening = false;

/** Read the host's `away` list from every origami/nestIndex. Idempotent. */
export function listenForAway(target: Pick<Window, 'addEventListener'> = window): void {
  if (listening) return;
  listening = true;
  target.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type?: unknown; away?: unknown } | null;
    if (!msg || msg.type !== 'origami/nestIndex') return;
    const list = Array.isArray(msg.away) ? msg.away : [];
    away = new Set(list.map((w) => (w && typeof w === 'object' ? (w as Record<string, unknown>)['id'] : '')).filter((id): id is string => typeof id === 'string' && !!id));
  });
}

/** The same record, for a caller that changes its own view before it posts
 *  (ChatPane's send and rewind): it stops first, so no row is added for a
 *  post that `blocks` then drops. */
export function isAway(sessionId: string): boolean {
  return away.has(sessionId);
}

/** True = drop this post: it writes into a chat that is now on another desk. */
export function blocks(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return typeof m['type'] === 'string' && NEST_WRITE_TYPES.has(m['type']) && typeof m['sessionId'] === 'string' && isAway(m['sessionId']);
}
