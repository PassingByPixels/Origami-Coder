// chatDensity.ts — t-qn0wj5, proposal 26 (port of Mock-Redesign CHANGES.md
// #39). Comfortable/Compact, persisted PER WINDOW via workspaceState — the
// same mechanism and the same shape as collabsSection.ts's COLLABS_OPEN_KEY:
// absent = the default (Comfortable), stored only when it differs, so an
// untouched workspace never gains a globalState/workspaceState entry for a
// setting nobody touched.
import type { Memento } from 'vscode';

/** Whether Compact is on. Absent = Comfortable (the default, and today's sizes). */
export const CHAT_DENSITY_KEY = 'origamicoder.chatDensityCompact';

export const CHAT_DENSITY_MESSAGE_TYPES = new Set(['setChatDensity']);

export interface ChatDensityHost {
  workspaceState(): Memento;
}

/** Read the stored value. Only an exact `true` reads as Compact. */
export function chatDensityCompact(host: ChatDensityHost): boolean {
  return host.workspaceState().get<boolean>(CHAT_DENSITY_KEY) === true;
}

/** Stored only when Compact (true); Comfortable clears the key rather than
 *  writing `false`, on the same reasoning as collabsSection.ts's open flag. */
export function handleChatDensityMessage(
  host: ChatDensityHost,
  m: { type?: string; compact?: unknown },
): void {
  if (m.type !== 'setChatDensity') return;
  const compact = m.compact === true;
  void host.workspaceState().update(CHAT_DENSITY_KEY, compact ? true : undefined);
}
