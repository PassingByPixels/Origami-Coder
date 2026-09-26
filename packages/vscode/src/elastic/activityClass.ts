// activityClass.ts — t-w2qv3o (epic t-w1r73y, option D1/D2): which activity class ONE engine is in.
// Pure: no vscode, no clock, no engine. The tracker (activityTracker.ts) feeds it signals and the time.
//
// The class names are the engine's wire contract (`_elastic_class`, ticket t-w2qlop). The priority each
// class maps to is the ENGINE's decision; this file only decides the class.
//
//   active      a view of this chat is on screen, or the phone is on it (owner decision 2026-09-24).
//   background  hidden. Also every hidden engine that holds work: a turn (host- or engine-started),
//               an open permission or question, a background sub-agent, an armed /loop. The owner
//               decision is that a running turn in a HIDDEN chat is background, not active.
//   idle        hidden, holds no work, and quiet for `idleAfterMs`.

export type ActivityClass = 'active' | 'background' | 'idle';

/** Every input the host can read for one engine. The host engine has only `lastActivityAt`. */
export interface EngineSignals {
  /** A view of this chat is visible: the sidebar chat view shows it, or its editor tab is visible. */
  onScreen: boolean;
  /** The paired phone is on this chat. */
  phone: boolean;
  /** The host awaits a prompt on this chat (`Session.turnBusy`). */
  turnBusy: boolean;
  /** The engine said it runs a turn for this chat (`origami/sessionStatus` not `idle`). */
  engineBusy: boolean;
  /** An unanswered permission or question. */
  pendingAsk: boolean;
  /** Background `task` sub-agents still out (`Session.runningChildren`). */
  runningChildren: boolean;
  /** A /loop schedule that is not stopped. */
  loopArmed: boolean;
  /** The last time the host asked this engine something (AcpClient.lastExtAt). 0 = never. */
  lastActivityAt?: number;
}

export const QUIET: EngineSignals = {
  onScreen: false, phone: false, turnBusy: false, engineBusy: false, pendingAsk: false, runningChildren: false, loopArmed: false,
};

/** One engine's classifier state. `quietSince` is set only while the engine is hidden and holds no work. */
export interface ClassState {
  cls: ActivityClass;
  quietSince: number | null;
}

export const START: ClassState = { cls: 'background', quietSince: null };

/** Work the engine holds. While any is true the class never drops below background. */
export function holdsWork(s: EngineSignals): boolean {
  return s.turnBusy || s.engineBusy || s.pendingAsk || s.runningChildren || s.loopArmed;
}

/** The next state for one engine, from its signals at `now`. */
export function nextClass(prev: ClassState, s: EngineSignals, now: number, idleAfterMs: number): ClassState {
  if (s.onScreen || s.phone) return { cls: 'active', quietSince: null };
  if (holdsWork(s)) return { cls: 'background', quietSince: null };
  // Hidden and quiet. The clock starts at the first quiet reading, and a host call restarts it.
  const quietSince = Math.max(prev.quietSince ?? now, s.lastActivityAt ?? 0);
  return { cls: now - quietSince >= idleAfterMs ? 'idle' : 'background', quietSince };
}
