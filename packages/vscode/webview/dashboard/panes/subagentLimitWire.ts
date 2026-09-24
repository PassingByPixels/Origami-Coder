// subagentLimitWire.ts — how the WEBVIEW learns the sub-agent time limit.
//
// The number lives in `origami.subagentTimeLimitHours` and only the extension
// host can read a setting, so the drawer asks for it exactly the way the
// Insights card already does (SubagentLimitCard.svelte): post
// `requestSubagentLimit`, listen for the host's `subagentLimitData`
// (src/dashboard/subagentLimitPane.ts). No new message type, no second reader
// of the setting, and therefore nothing that can report a different ceiling
// from the one the engine was actually spawned with.
//
// Its own leaf rather than ten lines inside SubagentDock.svelte, which owns a
// clock, a roster and now a map, and sat at 69/70 when this landed. Pure: it
// takes the post function and the listener registrar, so the whole subscribe /
// decode / unsubscribe path is testable with no webview at all.

import { limitMs } from './subagentWarn';

/** The one message the host answers with. Duplicated from
 *  subagentLimitPane.ts because the webview cannot import host code; the
 *  literal is asserted against that file in subagentLimitWire.test.ts. */
export const SUBAGENT_LIMIT_DATA = 'subagentLimitData';

/** The host's `subagentLimitData`, decoded to MILLISECONDS, or undefined for
 *  "not that message". `0` is a real answer — the setting is unusable, so the
 *  amber dot and the auto-sweep both stay off rather than guessing four hours
 *  (subagentWarn.ts / subagentRetire.ts). */
export function limitFromMessage(msg: unknown): number | undefined {
  const m = msg as { type?: unknown; hours?: unknown } | null;
  if (!m || m.type !== SUBAGENT_LIMIT_DATA) return undefined;
  return limitMs(typeof m.hours === 'number' ? m.hours : undefined);
}

export interface LimitWireDeps {
  /** `vscode.postMessage`. */
  post(msg: unknown): void;
  /** `window.addEventListener('message', …)`, returning its own unsubscribe. */
  listen(handler: (msg: unknown) => void): () => void;
  /** Hand the decoded ceiling (ms) to the caller. */
  onLimit(ms: number): void;
}

/**
 * Ask once, then keep listening — and return the teardown.
 *
 * KEEPS LISTENING on purpose. The card in the Insights pane can change the
 * setting while a chat is open, and the host re-broadcasts `subagentLimitData`
 * when it does, so a drawer that unsubscribed after the first answer would
 * warn against a ceiling the user has already changed.
 */
export function watchSubagentLimit(deps: LimitWireDeps): () => void {
  const stop = deps.listen((msg) => {
    const ms = limitFromMessage(msg);
    if (ms !== undefined) deps.onLimit(ms);
  });
  deps.post({ type: 'requestSubagentLimit' });
  return stop;
}
