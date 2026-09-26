// engineLabel.ts — t-xoenz1: how every Origami Elastic lifecycle line names an engine (start, class moves, parked,
// restored, closed, closed while parked, stopped), so a log reader can map a line to a process (pid) and to a chat
// (engine session id), and tell a chat, a Folds agent and a headless /loop session apart: the window calls the last
// two `agent N` alike, and neither is in the peer registry. No vscode here.

import { engineDescribe } from '../dashboard/engineLog';

export type EngineKind = 'chat' | 'Folds agent' | 'headless loop';

/** The slice of DashboardPanel's `Session` this reads. */
export interface LabelSession {
  id: string;
  number?: number;
  kind?: 'chat' | 'agent';
  /** A persistent /loop recalled on a session with no chat tab (DashboardPanel.recallLoopHeadless). */
  headlessLoop?: boolean;
  client?: { readonly pid?: number; readonly currentSessionId?: string | null } | null;
}

export function engineKind(s: LabelSession): EngineKind {
  if (s.kind !== 'agent') return 'chat';
  return s.headlessLoop ? 'headless loop' : 'Folds agent';
}

/** `chat 5 · kind chat · pid 72488`: the window's name for it, its kind, and the OS pid while a process runs. */
export function engineWho(s: LabelSession): string {
  const pid = s.client?.pid;
  return `${s.kind === 'agent' ? 'agent' : 'chat'} ${s.number ?? s.id} · kind ${engineKind(s)}${pid !== undefined ? ` · pid ${pid}` : ''}`;
}

/** engineWho and the engine session id: `chat 5 · kind chat · pid 72488 · engine session ses_…` (the Copy details form). */
export function engineLabel(s: LabelSession): string {
  return engineDescribe(engineWho(s), s.client?.currentSessionId)[0]!;
}
