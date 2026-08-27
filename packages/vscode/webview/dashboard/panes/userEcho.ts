// userEcho.ts — the rule that puts the USER'S OWN message on screen.
//
// It used to be the host's job alone: the webview posted `send` and waited for
// DashboardPanel.ts to post `echoUser` back before a single row appeared. That
// round trip is not free — the `send` case re-probes the model BEFORE it
// echoes (`if (!this.modelInfo.ok) await this.reprobeModel()`), and the probe
// is two sequential HTTP gets with a 4 s timeout each. On a chat whose
// provider never answers an LM Studio-shaped probe, the composer had already
// flipped to in-flight and the transcript showed a running turn with no
// question in it. The row is drawn HERE, at send; the host's echo is the
// confirmation of a row that already exists.
//
// Which makes `echoUser` two messages wearing one name:
//   - the confirmation of a send THIS pane made, and
//   - a user turn nobody here typed (history replay, a slash command the host
//     expanded, an Agent Manager task) — which must still draw its own row.
// `pendingEcho` is the only thing that separates them. It is matched ONCE and
// cleared, so a later replay of the same words is never swallowed.

/** The one field this rule reads on a chat session. */
export interface EchoTarget {
  /** Text of the row drawn at send, until the host confirms it. */
  pendingEcho?: string | null;
}

/**
 * The text the HOST will echo for this send. A mode command is echoed with its
 * `/mode` prefix (DashboardPanel.ts's `echoText`), so the local row has to
 * carry the same prefix or the two could never be matched.
 */
export function echoTextFor(text: string, mode: string): string {
  const body = text.trim();
  return mode ? `/${mode} ${body}`.trim() : body;
}

/**
 * True when this host echo confirms a row already on screen — and so must NOT
 * draw a second one. Consumes the pending match: one send, one row.
 */
export function consumeEcho(s: EchoTarget | null | undefined, text: string): boolean {
  if (!s || !s.pendingEcho || s.pendingEcho !== text) return false;
  s.pendingEcho = null;
  return true;
}
