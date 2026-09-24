// `origami/sessionStatus` fires with the ENGINE's session id, but every consumer keys on the LOCAL
// id. The old wiring posted `args.sessionId || sessionId` — since the engine id is never falsy, the
// fallback never fired, so a turn the engine starts on its own (an injected background result, a
// goal-mode check) left the ring green instead of spinning.
// DashboardPanel is at its line cap, so the routing decision lives here, testable without a real
// AcpClient.

export interface SessionStatusArgs {
  sessionId: string;
  status: string;
}

export interface SessionStatusRouteDeps {
  /** Reads the engine's own id for this connection's session, fresh on every call. */
  engineSessionId: () => string | null;
  /** The LOCAL id this chat is known by everywhere else (`session-N`). */
  localSessionId: string;
  post: (message: { type: 'sessionStatus'; status: string; sessionId: string }) => void;
}

/** Builds the `onSessionStatus` handler: forwards a status report under the LOCAL id, and drops one
 *  naming a session this connection doesn't own rather than mis-routing it. */
export function makeSessionStatusHandler(deps: SessionStatusRouteDeps): (args: SessionStatusArgs) => void {
  return (args) => {
    if (args.sessionId !== deps.engineSessionId()) return;
    deps.post({ type: 'sessionStatus', status: args.status, sessionId: deps.localSessionId });
  };
}
