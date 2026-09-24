// Origami Remote — what the desk may tell this page about a chat's mode.
//
// `privilege.ts` is how authority LEAVES this page, signed. This file is
// the other direction: the desk keeps a `ModeRecord` per chat and the page
// keeps a map, and the two can drift (e.g. a killed-and-reopened app came
// back with an empty map over a desk still holding the bypass).
//
// Two frames, and the difference between them is the whole file:
//
//   remote/set-mode    a revert the desk performed for its own reasons.
//                      Only `mode: 'ask'` is honoured; an inbound `yolo`
//                      is refused, since a yolo is a signed grant and a
//                      frame is not a signature.
//
//   remote/mode-state  a report of every chat the desk knows, sent after
//                      each hydration burst. A yolo MAY be learned here,
//                      because the desk is stating its own records, not
//                      granting anything. It is adopted whole.
//
// `cache.ts` must never synthesise a mode-state: the instant paint runs
// from disk before the socket opens, so a cached copy would paint over
// the real one — the bug this file closes.

import type { Mode } from './privilege';
import { setNotice } from './ui';

/** Said on the hook for every report-changed entry, so the chip can tell desk from local tap. */
export const REPORTED = 'the desktop reported this chat mode on connect';

/** One write, for the caller's ONE mode writer. */
export interface ModeChange {
  sessionId: string;
  mode: Mode;
  reason?: string;
}

/** TRUE when this file consumed the message; it must stay off the webview
 *  bus. Every change here fires the same hook a local tap does. */
export function applyModeFrame(
  msg: unknown,
  held: ReadonlyMap<string, Mode>,
  write: (sessionId: string, mode: Mode, reason?: string) => void,
): boolean {
  const type = (msg as { type?: unknown } | null)?.type;
  if (type !== 'remote/set-mode' && type !== 'remote/mode-state') return false;
  const changes = type === 'remote/set-mode' ? revertOnly(msg) : reported(msg, held);
  for (const c of changes) write(c.sessionId, c.mode, c.reason);
  return true;
}

/** The desk's own revert; anything else here is refused out loud, not silently dropped. */
function revertOnly(msg: unknown): ModeChange[] {
  const m = msg as { mode?: unknown; sessionId?: unknown; reason?: unknown };
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId : '';
  if (m.mode !== 'ask' || !sessionId) {
    const bad = `an unsigned "${String(m.mode)}"`;
    const why = m.mode === 'ask' ? 'it names no chat' : `only a revert is honoured, never ${bad}`;
    console.warn(`[remote] the desktop's set-mode was refused — ${why}`);
    return [];
  }
  const reason = typeof m.reason === 'string' && m.reason ? m.reason : undefined;
  // The page's own strip speaks for itself — an unrequested revert must not be silent.
  const text = reason ? `This chat is back to Ask: ${reason}` : 'This chat is back to Ask.';
  console.warn(`[remote] ${text}`);
  setNotice(document, text);
  return [{ sessionId, mode: 'ask', reason }];
}

/** The desk's report, adopted whole. */
function reported(msg: unknown, held: ReadonlyMap<string, Mode>): ModeChange[] {
  const modes = (msg as { modes?: unknown }).modes;
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) {
    console.warn('[remote] a mode-state arrived carrying no modes map — ignored');
    return [];
  }
  const out: ModeChange[] = [];
  const named = new Set<string>();
  for (const [sessionId, mode] of Object.entries(modes as Record<string, unknown>)) {
    if (mode !== 'ask' && mode !== 'yolo') continue;
    named.add(sessionId);
    // A chat this page has never heard of is adopted too: the desk knows
    // the window's chats before the strip does.
    if ((held.get(sessionId) ?? 'ask') !== mode) out.push({ sessionId, mode, reason: REPORTED });
  }
  // A chat the report does NOT name is not in bypass on the desk; dropping
  // authority is always safe. `pending` is left alone (a handshake in flight).
  for (const [sessionId, mode] of held) {
    if (mode === 'yolo' && !named.has(sessionId)) out.push({ sessionId, mode: 'ask', reason: REPORTED });
  }
  return out;
}
