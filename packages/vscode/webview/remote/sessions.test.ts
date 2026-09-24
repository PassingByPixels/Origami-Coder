// The phone's chat strip — `sessions.ts` (what chats there are) and
// `sessionBar.ts` (the control that draws them), tested together because
// neither is worth anything alone. What matters is that the strip is built
// from the wire the phone ALREADY has (no new message type), that a tap
// re-pins the mounted bundle rather than asking the desktop for anything, that
// "new chat" uses the composer's own `newSession` and lands on the chat the
// host creates, and that "close" uses the desktop tab close's own
// `closeSession` and lands on whatever survives it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionBar } from './sessionBar';
import { SessionList } from './sessions';

const created = (sessionId: string, sessionNumber: number, extra: object = {}) => ({
  type: 'sessionCreated',
  sessionId,
  sessionNumber,
  agentName: 'Tsuru',
  ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '<div id="remoteSessions" data-open="false"></div>';
});

const closed = (sessionId: string) => ({ type: 'sessionClosed', sessionId });

const host = () => document.getElementById('remoteSessions') as HTMLElement;
const chips = () => [...host().querySelectorAll('.remote-chip')].map((e) => e.textContent ?? '');
const current = () => host().querySelector('.remote-chip[data-current="true"]')?.textContent ?? '';
const crosses = () =>
  [...host().querySelectorAll('.remote-chip-close')].map((e) => e.getAttribute('aria-label') ?? '');
const cross = (sessionId: string) =>
  host().querySelector(`[data-close-session-id="${sessionId}"]`) as HTMLButtonElement | null;

describe('SessionList — built from messages the phone already gets', () => {
  it('collects announced chats in session-number order', () => {
    const list = new SessionList();
    expect(list.note(created('b', 2, { title: 'Cortex-0836' }))).toBe(true);
    expect(list.note(created('a', 1, { title: 'yesterday' }))).toBe(true);
    expect(list.all.map((r) => r.id)).toEqual(['a', 'b']);
    expect(list.all.map((r) => r.label)).toEqual(['yesterday', 'Cortex-0836']);
  });

  it('falls back to the agent name when a chat has no title yet', () => {
    const list = new SessionList();
    list.note(created('a', 1));
    expect(list.all[0]!.label).toBe('Tsuru');
  });

  it('takes the title the engine reports on the first turn', () => {
    const list = new SessionList();
    list.note(created('a', 1));
    expect(list.note({ type: 'sessionTitle', sessionId: 'a', title: 'wrap the arc' })).toBe(true);
    expect(list.all[0]!.label).toBe('wrap the arc');
  });

  it('ignores a title for a chat it has never been told about', () => {
    expect(new SessionList().note({ type: 'sessionTitle', sessionId: 'ghost', title: 'x' })).toBe(false);
  });

  it('learns the active chat from restoreActiveSession, and only when it changes', () => {
    const list = new SessionList();
    list.note(created('a', 1));
    expect(list.note({ type: 'restoreActiveSession', sessionId: 'a' })).toBe(true);
    expect(list.activeId).toBe('a');
    expect(list.note({ type: 'restoreActiveSession', sessionId: 'a' })).toBe(false);
  });

  it('is not moved by a message that merely carries a sessionId', () => {
    const list = new SessionList();
    expect(list.note({ type: 'agentText', sessionId: 'a', text: 'hi' })).toBe(false);
    expect(list.all).toEqual([]);
  });

  it('drops a closed chat and keeps the numbers of the ones left', () => {
    // Closing chat 2 of 3 leaves 1 and 3 — the numbers are the host's
    // `sessionNumber`, not positions in this list.
    const list = new SessionList();
    for (const n of [1, 2, 3]) list.note(created(String(n), n));
    expect(list.note(closed('2'))).toBe(true);
    expect(list.all.map((r) => r.number)).toEqual([1, 3]);
    expect(list.has('2')).toBe(false);
  });

  it('moves the active id to the NEWEST survivor when the active chat closes', () => {
    // The rule the desktop applies to itself: DashboardPanel.closeSession ends
    // with `liveActiveSessionId(this.sessions, ...)` (last key of the map) and
    // ChatPane's own `sessionClosed` takes `sessions[sessions.length - 1]`.
    const list = new SessionList();
    for (const n of [1, 2, 3]) list.note(created(String(n), n));
    list.note({ type: 'restoreActiveSession', sessionId: '2' });
    list.note(closed('2'));
    expect(list.activeId).toBe('3');
  });

  it('leaves the active id alone when some OTHER chat closes', () => {
    const list = new SessionList();
    for (const n of [1, 2]) list.note(created(String(n), n));
    list.note({ type: 'restoreActiveSession', sessionId: '1' });
    expect(list.note(closed('2'))).toBe(true);
    expect(list.activeId).toBe('1');
  });

  it('has no active chat left when the last one closes', () => {
    const list = new SessionList();
    list.note(created('a', 1));
    list.note({ type: 'restoreActiveSession', sessionId: 'a' });
    list.note(closed('a'));
    expect(list.activeId).toBeNull();
    expect(list.all).toEqual([]);
  });

  it('ignores a close for a chat it never had', () => {
    const list = new SessionList();
    list.note(created('a', 1));
    expect(list.note(closed('ghost'))).toBe(false);
  });
});

describe('the strip', () => {
  it('opens on the FIRST chat, with that chat and the + on it', () => {
    // It used to wait for a second chat, which is why a phone paired into a
    // one-chat window had no + and could not start another one at all.
    const bar = installSessionBar(document, { post: () => {}, show: () => {} });
    expect(host().getAttribute('data-open')).toBe('false');
    bar.note(created('a', 1));
    expect(host().getAttribute('data-open')).toBe('true');
    expect(chips()).toEqual(['1 · Tsuru', '+']);
    bar.note(created('b', 2));
    expect(chips()).toEqual(['1 · Tsuru', '2 · Tsuru', '+']);
  });

  it('a tap re-pins the mounted bundle locally and tells the desk which chat it is on', () => {
    const post = vi.fn();
    const show = vi.fn();
    const bar = installSessionBar(document, { post, show });
    bar.note(created('a', 1, { title: 'yesterday' }));
    bar.note(created('b', 2, { title: 'Cortex-0836' }));
    bar.note({ type: 'restoreActiveSession', sessionId: 'b' });
    expect(current()).toBe('2 · Cortex-0836');

    (host().querySelector('[data-session-id="a"]') as HTMLButtonElement).click();
    // The pane already holds every transcript replaySessionsTo announced, so
    // the SWITCH itself is local and waits for nothing.
    expect(show).toHaveBeenCalledWith('a');
    expect(current()).toBe('1 · yesterday');
    // The one thing it cannot do locally: the desk scopes the token stream to
    // the chat it thinks the phone is on, and a tap that posted nothing left it
    // filtering the new chat's words until the owner typed. ONE verb, and it
    // asks for nothing back.
    expect(post.mock.calls).toEqual([[{ type: 'remote/focus', sessionId: 'a' }]]);
  });

  it('+ sends the composer own newSession and lands on the chat the host makes', () => {
    const post = vi.fn();
    const show = vi.fn();
    const bar = installSessionBar(document, { post, show });
    bar.note(created('a', 1));
    bar.note(created('b', 2));

    (host().querySelector('.remote-chip-new') as HTMLButtonElement).click();
    expect(post).toHaveBeenCalledWith({ type: 'newSession' });
    expect(show).not.toHaveBeenCalled();

    bar.note(created('c', 3));
    expect(show).toHaveBeenCalledWith('c');
    expect(current()).toBe('3 · Tsuru');
  });

  it('adopts only ONE chat per +, not every chat announced afterwards', () => {
    const show = vi.fn();
    const bar = installSessionBar(document, { post: () => {}, show });
    bar.note(created('a', 1));
    (host().querySelector('.remote-chip-new') as HTMLButtonElement).click();
    bar.note(created('b', 2));
    bar.note(created('c', 3));
    expect(show.mock.calls).toEqual([['b']]);
  });

  it('does not re-adopt a chat it is merely being re-told about', () => {
    // Every reconnect replays sessionCreated for every open chat. A strip that
    // read a replay as "the new chat I asked for" would yank the owner off the
    // chat he is reading.
    const show = vi.fn();
    const bar = installSessionBar(document, { post: () => {}, show });
    bar.note(created('a', 1));
    bar.note(created('b', 2));
    (host().querySelector('.remote-chip-new') as HTMLButtonElement).click();
    bar.note(created('a', 1));
    bar.note(created('b', 2));
    expect(show).not.toHaveBeenCalled();
  });

  it('survives a shell with no strip in the DOM', () => {
    document.body.innerHTML = '';
    const bar = installSessionBar(document, { post: () => {}, show: () => {} });
    expect(() => bar.note(created('a', 1))).not.toThrow();
  });
});

describe('closing a chat from the phone', () => {
  it('puts an x on the CURRENT chip only, with a name a screen reader can use', () => {
    const bar = installSessionBar(document, { post: () => {}, show: () => {} });
    bar.note(created('a', 1, { title: 'yesterday' }));
    bar.note(created('b', 2, { title: 'Cortex-0836' }));
    bar.note({ type: 'restoreActiveSession', sessionId: 'b' });
    // One cross, on chat 2. A cross on every chip is a misfire waiting for a
    // thumb, and a chat the owner is not reading has to be tapped to first.
    expect(crosses()).toEqual(['Close chat 2']);
    expect(cross('b')).not.toBeNull();
    expect(cross('a')).toBeNull();
    // The label text stays the label — the cross is a sibling of the chip.
    expect(current()).toBe('2 · Cortex-0836');
  });

  it('the x posts closeSession for THAT chat and nothing else', () => {
    const post = vi.fn();
    const show = vi.fn();
    const bar = installSessionBar(document, { post, show });
    bar.note(created('a', 1));
    bar.note(created('b', 2));
    bar.note({ type: 'restoreActiveSession', sessionId: 'b' });

    cross('b')!.click();
    // The desktop tab close's own message, unchanged: DashboardPanel's
    // `case 'closeSession'` reads exactly this.
    expect(post.mock.calls).toEqual([[{ type: 'closeSession', sessionId: 'b' }]]);
    // Nothing moves until the host says the chat is gone.
    expect(show).not.toHaveBeenCalled();
    expect(current()).toBe('2 · Tsuru');
  });

  it('the answering sessionClosed drops the row and re-pins the mounted bundle', () => {
    const show = vi.fn();
    const bar = installSessionBar(document, { post: () => {}, show });
    for (const n of [1, 2, 3]) bar.note(created(String(n), n));
    bar.note({ type: 'restoreActiveSession', sessionId: '2' });

    bar.note(closed('2'));
    // The host announces the close and nothing after it, so the phone applies
    // the desktop's rule itself: the newest survivor.
    expect(show.mock.calls).toEqual([['3']]);
    expect(chips()).toEqual(['1 · Tsuru', '3 · Tsuru', '+']);
    expect(current()).toBe('3 · Tsuru');
    expect(crosses()).toEqual(['Close chat 3']);
  });

  it('does not re-pin when the chat that closed was not the one on screen', () => {
    const show = vi.fn();
    const bar = installSessionBar(document, { post: () => {}, show });
    bar.note(created('a', 1));
    bar.note(created('b', 2));
    bar.note({ type: 'restoreActiveSession', sessionId: 'a' });
    bar.note(closed('b'));
    expect(show).not.toHaveBeenCalled();
    expect(chips()).toEqual(['1 · Tsuru', '+']);
  });

  it('keeps the + after the LAST chat closes, so the phone is not stranded', () => {
    // The host creates nothing on its own here: DashboardPanel.closeSession
    // ends at `liveActiveSessionId` -> null and posts no further message, so
    // there is no new chat for the phone to land on. What it must not do is
    // hide the one control that can make one.
    const post = vi.fn();
    const show = vi.fn();
    const bar = installSessionBar(document, { post, show });
    bar.note(created('a', 1));
    bar.note({ type: 'restoreActiveSession', sessionId: 'a' });

    cross('a')!.click();
    bar.note(closed('a'));
    expect(show).not.toHaveBeenCalled();
    expect(host().getAttribute('data-open')).toBe('true');
    expect(chips()).toEqual(['+']);

    (host().querySelector('.remote-chip-new') as HTMLButtonElement).click();
    expect(post.mock.calls.at(-1)).toEqual([{ type: 'newSession' }]);
    // ...and the phone lands on the chat the host makes for it.
    bar.note(created('b', 2));
    expect(show.mock.calls).toEqual([['b']]);
  });
});
