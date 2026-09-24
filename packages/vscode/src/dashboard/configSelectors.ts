// The composer's Effort / Session-Mode / Approve controls, as messages, per session — each control
// holds only what the host last pushed.
//
// Must push to EVERY relevant session, not just the host-active one: a popped-out solo tab never
// posts activeSessionChanged (it pins itself, deliberately), so it could never be pushed to, and a
// view that attaches after the host already pushed is only caught up by replaySessionsTo for other
// state — not these controls.
//
// Pure — no vscode — so the fan-out is exercised on a plain Map of stand-ins.

/** One entry of a `select` config option, as the webview consumes it. */
export interface SelectorOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

/** The three `configOptions` readers this needs off an AcpClient. */
export interface SelectorClient {
  getModeOption(): { current: string; options: SelectorOption[] } | null;
  getEffortOption(): { current: string; options: SelectorOption[] } | null;
  getPermissionOption(): string | null;
}

/**
 * The selector messages for ONE session, each tagged with that session's id.
 * `effortOptions` is always sent (empty when the model declares no variants) so the control can
 *  hide; `modeOptions` is withheld when empty, since a select with no matching value renders as
 *  nothing chosen; `approveUpdate` is withheld when the engine reported no preset.
 */
export function configSelectorMessages(sessionId: string, client: SelectorClient | undefined): object[] {
  if (!client) return [];
  const messages: object[] = [];
  const mode = client.getModeOption();
  if (mode && mode.options.length > 0) {
    messages.push({ type: 'modeOptions', current: mode.current, options: mode.options, sessionId });
  }
  const effort = client.getEffortOption();
  messages.push({ type: 'effortOptions', current: effort?.current ?? '', options: effort?.options ?? [], sessionId });
  const permission = client.getPermissionOption();
  if (permission) messages.push({ type: 'approveUpdate', mode: permission, sessionId });
  return messages;
}

/**
 * The same, for every live chat in the window — a solo/pop-out tab's refresh must repaint even when
 *  the host-active session is a different chat. Sessions whose engine is not up are skipped.
 */
export function allConfigSelectorMessages(
  sessions: ReadonlyMap<string, { client?: SelectorClient }>,
): object[] {
  return [...sessions].flatMap(([sessionId, session]) => configSelectorMessages(sessionId, session.client));
}
