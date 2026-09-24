// engineNotice.ts — the chat's engine state, drawn as the reconnect card (t-v5qn37).
//
// The host (src/dashboard/engineGate.ts) posts `engineState` when a prompt waits for the
// engine, when a start fails, and when the engine is up again. The pane shows it with
// SystemAlertRow — the card a dropped provider stream uses — not the red Error row:
//   starting -> the pulsing "retrying" look; ready -> the "recovered" look;
//   failed   -> the "stopped" look with Retry; stopped (the engine exited) -> "stopped", no Retry.
// One card per start: later states fold into the open card instead of stacking.

/** MIRROR of src/dashboard/engineGate.ts EngineStage. A webview .ts file cannot import from
 *  src/ (tsconfig.webview.json rootDir); engineNotice.test.ts reads both files. */
export type EngineStage = 'starting' | 'ready' | 'failed' | 'stopped';

/** One `engineState` post. `held` = the messages waiting on the engine at that moment;
 *  `retry` = a failed start that is safe to run again (a fork that never got its id is not). */
export interface EngineNotice {
  stage: EngineStage;
  reason: string;
  held: number;
  retry: boolean;
}

const STAGES: readonly EngineStage[] = ['starting', 'ready', 'failed', 'stopped'];

/** Fail-closed shape check for a value off the host wire. */
export function asEngineNotice(value: unknown): EngineNotice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { stage, reason, held, retry } = value as Record<string, unknown>;
  if (!STAGES.includes(stage as EngineStage)) return undefined;
  return {
    stage: stage as EngineStage,
    reason: typeof reason === 'string' ? reason : '',
    held: Number.isInteger(held) && (held as number) > 0 ? (held as number) : 0,
    retry: stage === 'failed' && retry === true, // fail-closed: no Retry unless the host said so
  };
}

/** What SystemAlertRow draws for a notice. */
export interface EngineAlert {
  state: 'retrying' | 'recovered' | 'stopped';
  title: string;
  detail: string;
  /** Only a failed start can be tried again from the card. */
  retry: boolean;
}

export function engineAlert(n: EngineNotice): EngineAlert {
  const yours = n.held === 1 ? 'Your message' : `${n.held} messages`;
  const join = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  switch (n.stage) {
    case 'starting':
      return { state: 'retrying', title: 'Starting the engine', detail: n.held > 0 ? `${yours} will send when the engine is up.` : '', retry: false };
    case 'ready':
      return { state: 'recovered', title: 'Engine ready', detail: n.held === 1 ? 'Your message was sent.' : n.held > 1 ? `${yours} go out in the order you sent them.` : '', retry: false };
    case 'failed':
      return { state: 'stopped', title: 'The engine did not start', detail: join(n.reason, n.retry && n.held > 0 ? `${yours} ${n.held === 1 ? 'is kept. Retry sends it.' : 'are kept. Retry sends them.'}` : ''), retry: n.retry };
    case 'stopped':
      return { state: 'stopped', title: 'The engine stopped', detail: join(n.reason, 'Reload the window to start it again.'), retry: false };
  }
}

/** A card that a later state still belongs to. `ready` and `stopped` are final. */
function isOpen(row: { kind?: string; engine?: EngineNotice }): boolean {
  return row.kind === 'engine' && (row.engine?.stage === 'starting' || row.engine?.stage === 'failed');
}

/**
 * The rows with `n` folded into the open engine card, or undefined when the caller must
 * append a new card (`opens` says whether one is wanted at all). A `stopped` notice always
 * appends: it answers a prompt sent after the engine exited, and belongs under that prompt.
 */
export function foldEngineNotice<R extends { kind?: string; engine?: EngineNotice }>(rows: R[], n: EngineNotice): R[] | undefined {
  if (n.stage === 'stopped') return undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && isOpen(row)) return [...rows.slice(0, i), { ...row, engine: n }, ...rows.slice(i + 1)];
  }
  return undefined;
}

/** With no open card: does this notice need one? A start nobody waits on has nothing to say. */
export function opensEngineCard(n: EngineNotice): boolean {
  return n.stage === 'failed' || n.stage === 'stopped' || (n.stage === 'starting' && n.held > 0);
}
