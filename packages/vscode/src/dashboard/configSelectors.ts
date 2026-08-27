// configSelectors.ts — the composer's Effort / Session-Mode / Approve controls,
// as messages, PER SESSION.
//
// WHY THIS IS A LEAF. The three controls read nothing of their own: each holds
// exactly what the host last pushed, and the Effort button HIDES itself when it
// holds zero options (InputBar.svelte's `{#if effortOptions.length > 0}`). So
// "which sessions get a push, and when" is the whole behaviour — and it used to
// be written inline as "the active one, now", which is wrong in two ways a chat
// window hits every day:
//
//   - A chat that is NOT the host-active session got nothing. A popped-out solo
//     tab never posts `activeSessionChanged` (ChatPane.svelte pins itself and
//     returns early, deliberately, so it cannot clobber the side bar's focus),
//     so it cannot make itself active and therefore could never be pushed to.
//   - A chat view that ATTACHED after the host had already pushed got nothing
//     either. The chat and config side-bar views share one host; whichever
//     resolves second is caught up by `replaySessionsTo`, which carried the
//     transcript, the context gauge and the focus — but not these.
//
// The owner-visible symptom (0.4.58): a chat on `xai/grok-4.5` with no Effort
// button, while the engine reported `low / medium / high` for that model on the
// very same box. Nothing model-specific about it; grok is where it was noticed.
//
// Pure — no `vscode`, no client construction — so the fan-out is exercised on a
// plain Map of stand-ins.

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
 *
 * `effortOptions` is ALWAYS produced (empty when the model declares no
 * variants) — the control hides on an empty list, and not sending it would
 * leave the previous model's levels on screen. `modeOptions` is withheld when
 * the list is empty, because a `select` whose current value is absent from its
 * options renders as nothing chosen. `approveUpdate` is withheld when the
 * engine reported no preset, rather than asserting a default the engine never
 * said.
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
 * The same, for EVERY live chat in the window — the rule the sibling
 * `modelStatus` broadcast already follows ("statuses are per-session now, and a
 * solo/pop-out tab's refresh must repaint even when the host-active session is
 * a different chat"). Sessions whose engine is not up are skipped.
 */
export function allConfigSelectorMessages(
  sessions: ReadonlyMap<string, { client?: SelectorClient }>,
): object[] {
  return [...sessions].flatMap(([sessionId, session]) => configSelectorMessages(sessionId, session.client));
}
