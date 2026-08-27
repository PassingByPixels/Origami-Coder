// sessionAnnounce.ts — WHEN a new session may be shown to the user.
//
// THE FLASH (W8-L1, live UAT): "Start session" on a bot opened a chat panel
// that vanished a moment later. Nothing was wrong with the disposal — the
// engine refused the agent and the half-built session was correctly torn down.
// The defect is the ORDER. `createSession` posts `sessionCreated` while the ACP
// client is still connecting, the webview mounts a chat from it (ChatPane's
// `sessionCreated` case pushes it onto `sessions` and activates it), and the
// refusal path's `sessionClosed` then filters it straight back out.
//
// For an ORDINARY chat that order is right: the engine is expected to come up,
// the panel carries the "Connected. Session …" line when it does, and a spawn
// failure belongs in the chat that failed. A BOT chat is the opposite case. Its
// creation is a REQUEST that the engine can legitimately refuse — an agent
// definition it has not loaded — and the refusal already has a home: the Bots
// pane renders it from the thrown message (botsManager.ts's `botSessionResult`).
// A chat panel is not the report; it is a second, wrong report that appears and
// leaves.
//
// So a bot session is PROVISIONAL: nothing is shown until the engine has
// accepted it. Pure and dependency-free — the rule is testable without an
// extension host, which is the point of it living here rather than inline.

/**
 * Start a session's engine connection and announce the session, in the order
 * that never leaves a surface behind.
 *
 * `provisional` sessions announce only on success, so a refused start shows
 * NOTHING. Everything else announces first and keeps today's behaviour, where a
 * chat is on screen while its engine connects and a failure is reported inside
 * it.
 *
 * `announce` runs at most once, and never after `start` rejected while
 * provisional. `start`'s result and its rejection both pass through untouched:
 * the caller's own error handling — including the tear-down that deletes the
 * half-built session — is unchanged by this.
 */
export async function startThenAnnounce<T>(input: {
  provisional: boolean;
  announce: () => void;
  start: () => Promise<T>;
}): Promise<T> {
  if (!input.provisional) input.announce();
  const result = await input.start();
  if (input.provisional) input.announce();
  return result;
}
