// How a chat's engine process is CLOSED (t-kgu05m round 4).
//
// The engine publishes a peer-discovery heartbeat file naming the sessions a
// chat is showing right now (engine src/origami/agent-broker.ts), and it
// DELETES that file in the finalizer that runs when its stdin reaches EOF
// (engine src/cli/cmd/acp.ts). Killing the child outright never reaches that
// finalizer — on Windows `child.kill()` is TerminateProcess, so no line of the
// engine runs again — and the entry is left behind still naming the closed
// chat as attached. For the whole of the broker's freshness window a peer then
// resolves that address, delivers a handoff to a port nobody is listening on,
// and the sender is told it went somewhere. That is the round-3 defect
// arriving by a second road, and closing a chat is what opens it.
//
// So the close is a REQUEST first and a kill second. Measured on this machine
// (2026-08-13, engine run from source): after stdin EOF the heartbeat entry is
// gone in ~60 ms and the process exits 0 in ~400 ms. The grace below is an
// order of magnitude over that, and the kill still fires when it elapses —
// closing a chat must not be able to leave a process behind either.

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

/**
 * Ask the engine to shut down, and make sure it does.
 *
 * Ending stdin is the whole request: the ACP command waits on that stream and
 * runs its broker finalizer when it closes. The timer is the guarantee — a
 * wedged engine is killed once the grace is up, and the timer is unref'd and
 * cleared on exit so a closed chat never holds the extension host awake.
 */
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
