// The section a board should show on its next mount.
//
// Module state: a board opened for the first time hasn't attached when the
// broadcast goes out, so it also ASKS on mount and acknowledges what it was
// given — the ack stops a stale request from hijacking a board opened later.
// Two callers (webview and a command with no webview to post from) share this.

let pendingSection: string | undefined;

/**
 * Ask the next board that reports ready to show `section`.
 *
 * A board already open on another view is only revealed, not switched,
 * unless its caller can broadcast to it directly.
 */
export function requestBoardSection(section: string): void {
  pendingSection = section || undefined;
}

export function pendingBoardSection(): string | undefined {
  return pendingSection;
}

/** The board acted on the request. Clearing it is what bounds its lifetime. */
export function clearBoardSection(): void {
  pendingSection = undefined;
}
