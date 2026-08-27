// loopRows.ts — what a row on the Loops pane IS (the two wire shapes the host
// broadcasts) plus the one derived fact neither shape carries: whether this row
// has a chat to bring back.
//
// Extracted from LoopsPane.svelte at its cap when the reopen control landed —
// the same ratchet-driven split LoopCard.svelte took out of it before. Pure, so
// the rule that decides whether a control appears AT ALL is testable without
// rendering anything.

import type { LoopOutcome } from './loopFormat';

/** A LIVE loop: its engine session is open in this window, either behind a chat
 *  or headless after that chat was closed (src/dashboard/loopSchedules.ts). */
export interface LoopSchedule {
  sessionId: string;
  number: number;
  agentName: string;
  title?: string;
  intervalLabel: string;
  prompt: string;
  runs: number;
  persistent: boolean;
  headless: boolean;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastOutcome?: LoopOutcome | null;
}

/** A PERSISTED loop whose engine session did NOT come back — no live chat
 *  identity to show, only what was persisted (src/dashboard/loopAttention.ts). */
export interface NeedsAttentionLoop {
  sessionId: string;
  intervalLabel: string;
  prompt: string;
  runs: number;
  createdAt: number;
  persistent: boolean;
}

/**
 * Is there a chat to bring back for this row?
 *
 * NO for a live chat row — that loop's chat is open already, and a control that
 * "reopens" something already open does nothing you can see, which is the worst
 * kind of button. YES for a headless row (running with no chat is precisely the
 * state this action exists for) and for a needs-attention one (the card already
 * tells you to reopen the chat; without this there was no way to).
 */
export function canReopenChat(live: boolean, headless: boolean): boolean {
  return !live || headless;
}
