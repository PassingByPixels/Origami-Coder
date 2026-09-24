// How a chat's engine process is CLOSED.
//
// The engine publishes a peer-discovery heartbeat file naming the sessions a chat
// is showing, and DELETES it in the finalizer that runs when its stdin reaches EOF.
// Killing the child outright never reaches that finalizer (on Windows
// `child.kill()` is TerminateProcess), so the entry is left behind and a peer then
// delivers a handoff to a port nobody is listening on while the sender is told it
// arrived. So the close is a REQUEST first and a kill second: the heartbeat is gone
// ~60 ms after EOF, and the kill still fires when the grace elapses.

/** How long the engine gets to remove its heartbeat and exit on its own. */
export const ENGINE_EXIT_GRACE_MS = 2_000;

/** The part of a `ChildProcess` this decision reads. Structural so the real
 *  child satisfies it and a test needs no spawn. */
export interface ClosableEngine {
  readonly stdin: { end(): void } | null;
  readonly exitCode: number | null;
  once(event: 'exit', listener: () => void): unknown;
  kill(): unknown;
}

/** Ask the engine to shut down, and make sure it does. Ending stdin is the whole
 *  request: the ACP command waits on that stream and runs its broker finalizer when
 *  it closes. The timer is the guarantee — a wedged engine is killed once the grace
 *  is up, and the timer is unref'd and cleared on exit. */
export function shutdownEngine(child: ClosableEngine, graceMs = ENGINE_EXIT_GRACE_MS): void {
  if (child.exitCode !== null) return;
  const hardKill = () => {
    try {
      child.kill();
    } catch {
      // Already gone between the check and here — the outcome we wanted.
    }
  };
  const stdin = child.stdin;
  if (!stdin) return hardKill();
  try {
    stdin.end();
  } catch {
    return hardKill();
  }
  const timer = setTimeout(hardKill, graceMs);
  (timer as { unref?: () => void }).unref?.();
  child.once('exit', () => clearTimeout(timer));
}
