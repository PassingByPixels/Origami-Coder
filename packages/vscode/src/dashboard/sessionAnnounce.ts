// sessionAnnounce.ts — when a new session may be shown to the user.
// A bot chat's creation is a REQUEST the engine can refuse; showing a chat panel that then vanishes
// on refusal is a worse report than the Bots pane's own refusal message. So a bot session is
// provisional: nothing is shown until the engine accepts it. An ordinary chat keeps today's
// behaviour (shown immediately, failure reported inside it).
//
// A SURFACE is two things, and both belong here (t-hb1b7e): the posts that tell the
// webview a chat exists (`announce`), and the editor tab that chat lives in (`open`).
// The tab used to be opened after the awaited `start()`, which is why a new chat's pane
// took the whole engine start-up to appear — measured at 2.4-2.5 s of engine alone on
// this PC — and why on a slower machine it could look like it never appeared at all.
// Opening the tab HERE, beside the announce, makes that impossible by construction: the
// pane's existence depends on the click, never on a post landing or an engine answering.

/**
 * Start a session's engine connection and show it, in the order that never
 * leaves a surface behind. `provisional` sessions show only on success;
 * everything else shows first, so the pane is up while the engine starts.
 * `announce`/`open` run at most once, `settled` runs exactly once whether
 * `start` resolved or rejected, and `start`'s result/rejection pass through
 * untouched.
 */
export async function startThenAnnounce<T>(input: {
  provisional: boolean;
  announce: () => void;
  /** Create (or reveal) the chat's own editor tab. Optional: a headless agent
   *  session has no tab, and the Agent Manager board is its surface. */
  open?: () => void;
  start: () => Promise<T>;
  /** The engine is no longer starting — resolved or rejected. Both settle the
   *  pane's "starting engine…" state; a rejection has already reported itself
   *  inside the pane that `open` put on screen. */
  settled?: () => void;
}): Promise<T> {
  const show = () => {
    input.announce();
    input.open?.();
  };
  if (!input.provisional) show();
  try {
    const result = await input.start();
    if (input.provisional) show();
    return result;
  } finally {
    input.settled?.();
  }
}
