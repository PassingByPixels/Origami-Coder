// The chat strip: the phone's answer to the desktop's session tabs.
//
// The phone runs the bundle in solo mode, rendering one session and
// hiding the desktop's tab strip, using facts already on the wire plus
// one exception: `remote/focus`, which tells the desk which chat the
// phone is reading so its outbound scoping is right (see `choose()`).
//
// Switching, new-chat and close all ride existing broadcasts that every
// view already reacts to, so solo mode is only a filter over sessions
// the bundle already holds.
//
// `soloSessionId` could not change after mount, so this file also
// honours a `soloSession` message to re-pin it, inert inside VS Code.

import './strip.css';
import { SessionList, type SessionRow } from './sessions';
import { dispatchToWebview } from './shim';

export interface SessionBar {
  /** Feed every inbound desktop message. */
  note(msg: unknown): void;
  /** The chat the strip is on, or `''` — see `privilege.ts`. */
  activeId(): string;
}

export interface SessionBarOptions {
  /** Phone -> desktop, for `newSession`, `closeSession` and `remote/focus`. */
  post: (msg: unknown) => void;
  /** Re-pin the mounted bundle onto a session. */
  show: (sessionId: string) => void;
}

/** Build the chat strip against `#remoteSessions`. One chip per chat plus
 *  a `+`, and an `x` on the chip the phone is reading. Stays open once
 *  opened, so `+` is reachable even after the last chat closes. */
export function installSessionBar(doc: Document, opts: SessionBarOptions): SessionBar {
  const host = doc.getElementById('remoteSessions');
  const list = new SessionList();
  /** Set while a `newSession` we asked for is still on its way, so the chat
   *  the host creates is the one the phone lands on. */
  let adoptNext = false;
  /** True once a chat has been announced. Sticky: closing the last chat must
   *  leave the `+` on screen, or the phone is stranded with no way back. */
  let opened = false;

  const choose = (id: string): void => {
    list.select(id);
    opts.show(id);
    // The desk scopes the token stream to the chat it believes the phone
    // is on, so a silent tap would leave it filtering the new chat's words.
    opts.post({ type: 'remote/focus', sessionId: id });
    paint();
  };

  /** The `x` on the current chip only, to avoid a strip of misfires under
   *  a thumb. Sibling of the chip, not a child (nested buttons are invalid). */
  function closer(row: SessionRow): HTMLButtonElement {
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'remote-chip-close';
    x.textContent = '×';
    x.setAttribute('data-close-session-id', row.id);
    x.setAttribute('aria-label', `Close chat ${row.number}`);
    // No confirm: the desktop's tab close has none either; the chat stays in history.
    x.addEventListener('click', () => opts.post({ type: 'closeSession', sessionId: row.id }));
    return x;
  }

  function paint(): void {
    if (!host) return;
    const rows = list.all;
    if (rows.length > 0) opened = true;
    host.textContent = '';
    host.setAttribute('data-open', opened ? 'true' : 'false');
    for (const row of rows) {
      const tab = doc.createElement('span');
      tab.className = 'remote-tab';
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'remote-chip';
      chip.textContent = row.label ? `${row.number} · ${row.label}` : String(row.number);
      chip.setAttribute('data-session-id', row.id);
      chip.addEventListener('click', () => choose(row.id));
      tab.appendChild(chip);
      if (row.id === list.activeId) {
        chip.setAttribute('data-current', 'true');
        tab.setAttribute('data-current', 'true');
        tab.appendChild(closer(row));
      }
      host.appendChild(tab);
    }
    const add = doc.createElement('button');
    add.type = 'button';
    add.className = 'remote-chip remote-chip-new';
    add.textContent = '+';
    add.setAttribute('aria-label', 'New chat');
    add.addEventListener('click', () => {
      adoptNext = true;
      opts.post({ type: 'newSession' });
    });
    host.appendChild(add);
  }

  return {
    activeId: () => list.activeId ?? '',
    note(msg) {
      const type = (msg as { type?: unknown } | null)?.type;
      const known = list.has(sessionIdOf(msg));
      const wasActive = list.activeId;
      if (!list.note(msg)) return;
      const id = sessionIdOf(msg);
      // The chat WE asked for: land on it, once.
      if (adoptNext && !known && id && type === 'sessionCreated') {
        adoptNext = false;
        choose(id);
        return;
      }
      // The active chat closed with no replacement named; move the bundle to the successor.
      const active = list.activeId;
      if (type === 'sessionClosed' && active && active !== wasActive) opts.show(active);
      paint();
    },
  };
}

function sessionIdOf(msg: unknown): string {
  const id = (msg as { sessionId?: unknown } | null)?.sessionId;
  return typeof id === 'string' ? id : '';
}

/** The default `show`: tell the mounted bundle which chat to render. */
export function repin(sessionId: string): void {
  dispatchToWebview({ type: 'soloSession', sessionId });
}
