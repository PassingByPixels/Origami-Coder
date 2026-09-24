// The shim is a DROP-IN, so these tests assert against how the real chat
// bundle uses the host, not against how the shim is written:
//   - `webview/shared/vscodeApi.ts` calls acquireVsCodeApi() ONCE and caches it.
//   - `webview/shared/theme.ts` does `getState() || {}` during mount.
//   - `ChatView.svelte` reads __ORIGAMI_SOLO_SESSION__ in onMount, so the
//     bundle cannot load before the desktop names a session.
//   - `sessionReplay.acceptsReplayedLog` drops a restoreMessages whose target
//     already has messages, so the flush order after mount is load-bearing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MountGate, dispatchToWebview, installShim } from './shim';

const RID = 'room1';
const stateKey = `origami-remote/view-state/${RID}`;

beforeEach(() => {
  window.localStorage.clear();
});

describe('installShim', () => {
  it('installs a SINGLETON on window, because the bundle caches the first one', () => {
    installShim(() => {}, RID);
    const grab = (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi;
    expect(grab()).toBe(grab());
  });

  it('exposes all three methods the bundle calls', () => {
    const api = installShim(() => {}, RID);
    expect(typeof api.postMessage).toBe('function');
    expect(typeof api.getState).toBe('function');
    expect(typeof api.setState).toBe('function');
  });

  it('hands every postMessage straight to the sender, unchanged', () => {
    const send = vi.fn();
    const api = installShim(send, RID);
    const msg = { type: 'send', text: 'hi', sessionId: 's1' };
    api.postMessage(msg);
    expect(send).toHaveBeenCalledWith(msg);
  });

  it('maps setState/getState onto localStorage, scoped to the room', () => {
    const api = installShim(() => {}, RID);
    api.setState({ theme: 'midnight' });
    expect(api.getState()).toEqual({ theme: 'midnight' });
    expect(JSON.parse(window.localStorage.getItem(stateKey) as string)).toEqual({ theme: 'midnight' });
    // A second pairing must not inherit the first one's view state.
    expect(installShim(() => {}, 'other').getState()).toBeUndefined();
  });

  it('returns undefined (never throws) before any setState, as VS Code does', () => {
    // theme.ts does `getState() || {}` — a throw here kills the whole mount.
    expect(installShim(() => {}, RID).getState()).toBeUndefined();
  });

  it('returns undefined for corrupt stored state instead of throwing', () => {
    window.localStorage.setItem(stateKey, '{not json');
    expect(installShim(() => {}, RID).getState()).toBeUndefined();
  });

  it('swallows a storage write failure (private mode) rather than killing boot', () => {
    const api = installShim(() => {}, RID);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => api.setState({ theme: 'lilac' })).not.toThrow();
    spy.mockRestore();
  });
});

describe('dispatchToWebview', () => {
  it('delivers a desktop message to an ordinary window message listener', () => {
    // This is the shape every arm of ChatPane's switch is written against.
    const seen: unknown[] = [];
    const onMsg = (ev: MessageEvent) => seen.push(ev.data);
    window.addEventListener('message', onMsg);
    const msg = { type: 'sessionCreated', sessionId: 's1', sessionNumber: 1, agentName: 'Tsuru' };
    dispatchToWebview(msg);
    window.removeEventListener('message', onMsg);
    expect(seen).toEqual([msg]);
  });
});

describe('MountGate', () => {
  const created = (sessionId: string) => ({ type: 'sessionCreated', sessionId, sessionNumber: 1, agentName: 'Tsuru' });
  // The LAST message of a hydration burst: the chat the window is actually on.
  const active = (sessionId: string) => ({ type: 'restoreActiveSession', sessionId });
  /** A schedule the test drives by hand, so the grace timer is not a sleep. */
  function manualSchedule(): { run: () => void; fn: (f: () => void, ms: number) => unknown } {
    let held: (() => void) | null = null;
    return { run: () => held?.(), fn: (f) => void (held = f) };
  }

  it('buffers until the host names its ACTIVE session, then flushes IN ORDER', async () => {
    const seen: unknown[] = [];
    const loaded: string[] = [];
    const gate = new MountGate(
      async (sid) => void loaded.push(sid),
      (m) => void seen.push(m),
    );

    const early = { type: 'modelStatus', ok: true, modelName: 'qwen-coder' };
    await gate.accept(early);
    expect(gate.isMounted).toBe(false);
    expect(seen).toEqual([]);
    expect(gate.buffered).toBe(1);

    const restore = { type: 'restoreMessages', sessionId: 's1', messages: [{ kind: 'user', text: 'hi' }] };
    await gate.accept(created('s1'));
    await gate.accept(restore);
    // Still nothing: replaySessionsTo has not named the active chat yet.
    expect(gate.isMounted).toBe(false);
    await gate.accept(active('s1'));

    expect(loaded).toEqual(['s1']);
    expect(gate.isMounted).toBe(true);
    // sessionCreated MUST reach the pane before restoreMessages, or the
    // replay is dropped by acceptsReplayedLog.
    expect(seen).toEqual([early, created('s1'), restore, active('s1')]);
    expect(gate.buffered).toBe(0);
  });

  it('opens on the ACTIVE chat, not the first one announced', async () => {
    // replaySessionsTo walks the sessions map OLDEST FIRST and names the
    // active chat only at the end. Mounting on the first announcement pinned
    // the phone to a chat the owner was not looking at.
    const loaded: string[] = [];
    const gate = new MountGate(async (sid) => void loaded.push(sid));
    await gate.accept(created('old'));
    await gate.accept(created('current'));
    await gate.accept(active('current'));
    expect(loaded).toEqual(['current']);
    expect(gate.sessions).toEqual(['old', 'current']);
  });

  it('ignores an active id it has never been told about', async () => {
    // A `restoreActiveSession` with no `sessionCreated` behind it would mount a
    // ChatPane over a session it has no row for.
    const loaded: string[] = [];
    const schedule = manualSchedule();
    const gate = new MountGate(async (sid) => void loaded.push(sid), undefined, schedule.fn, 0);
    await gate.accept(active('ghost'));
    expect(loaded).toEqual([]);
    expect(gate.isMounted).toBe(false);
  });

  it('falls back to the first announced chat when no active session is named', async () => {
    // A window whose only chat was created LIVE sends no restoreActiveSession.
    const loaded: string[] = [];
    const schedule = manualSchedule();
    const gate = new MountGate(async (sid) => void loaded.push(sid), undefined, schedule.fn, 0);
    await gate.accept(created('s1'));
    expect(loaded).toEqual([]);
    schedule.run();
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toEqual(['s1']);
  });

  it('passes messages straight through once mounted', async () => {
    const seen: unknown[] = [];
    const gate = new MountGate(async () => {}, (m) => void seen.push(m));
    await gate.accept(created('s1'));
    await gate.accept(active('s1'));
    const live = { type: 'agentText', sessionId: 's1', text: 'I am Tsuru.' };
    await gate.accept(live);
    expect(seen).toEqual([created('s1'), active('s1'), live]);
  });

  it('loads the bundle exactly ONCE across a second hydration burst', async () => {
    const loaded: string[] = [];
    const gate = new MountGate(async (sid) => void loaded.push(sid));
    await gate.accept(created('s1'));
    await gate.accept(active('s1'));
    // A reconnect replays the whole burst, and may name a different chat.
    await gate.accept(created('s2'));
    await gate.accept(active('s2'));
    expect(loaded).toEqual(['s1']);
  });

  it('does not mount on a message that merely CARRIES a sessionId', async () => {
    const loaded: string[] = [];
    const gate = new MountGate(async (sid) => void loaded.push(sid));
    await gate.accept({ type: 'contextUpdate', sessionId: 's1', tokensUsed: 0 });
    await gate.accept({ type: 'agentText', sessionId: 's1', text: 'x' });
    expect(loaded).toEqual([]);
    expect(gate.buffered).toBe(2);
  });

  it.each([
    ['a sessionCreated with no id', { type: 'sessionCreated' }],
    ['a sessionCreated with an empty id', { type: 'sessionCreated', sessionId: '' }],
    ['a non-string id', { type: 'sessionCreated', sessionId: 7 }],
    ['a bare string', 'sessionCreated'],
    ['null', null],
  ])('does not mount on %s', async (_label, msg) => {
    const loaded: string[] = [];
    const gate = new MountGate(async (sid) => void loaded.push(sid));
    await gate.accept(msg);
    expect(loaded).toEqual([]);
    expect(gate.isMounted).toBe(false);
  });

  it('keeps buffering while the bundle is still loading, then flushes all of it', async () => {
    // A slow script load must not let a later message overtake the flush.
    const seen: unknown[] = [];
    let release: () => void = () => {};
    const gate = new MountGate(
      () => new Promise<void>((res) => (release = res)),
      (m) => void seen.push(m),
    );
    await gate.accept(created('s1'));
    const first = gate.accept(active('s1'));
    const during = { type: 'agentText', sessionId: 's1', text: 'mid-load' };
    await gate.accept(during);
    expect(seen).toEqual([]);
    release();
    await first;
    expect(seen).toEqual([created('s1'), active('s1'), during]);
  });
});

// t-w4w7ih / the first-time sweep. The grace timer used to be ONE SHOT armed
// by the first `sessionCreated`, so a hydration burst slower than `graceMs`
// mounted the oldest chat — the exact snag the gate exists to prevent, back
// again on any device or link slow enough. It is now debounced by the burst.
describe('MountGate — the fallback waits for the burst, not for the first frame', () => {
  const created = (sessionId: string) => ({ type: 'sessionCreated', sessionId, sessionNumber: 1, agentName: 'Tsuru' });
  const active = (sessionId: string) => ({ type: 'restoreActiveSession', sessionId });

  /** Every armed timer, so a test can fire the STALE one and prove it is inert. */
  function armedTimers(): { fns: Array<() => void>; fn: (f: () => void, ms: number) => unknown } {
    const fns: Array<() => void> = [];
    return { fns, fn: (f) => void fns.push(f) };
  }

  it('a timer armed before the rest of the burst does NOT mount the oldest chat', async () => {
    const loaded: string[] = [];
    const timers = armedTimers();
    const gate = new MountGate(async (sid) => void loaded.push(sid), undefined, timers.fn, 0);

    await gate.accept(created('old'));
    // The burst carries on. On a slow link every one of these arrives AFTER the
    // first timer would have fired.
    await gate.accept({ type: 'restoreMessages', sessionId: 'old', messages: [] });
    await gate.accept(created('current'));
    await gate.accept({ type: 'restoreMessages', sessionId: 'current', messages: [] });

    // The stale timer fires now. It must do nothing.
    timers.fns[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toEqual([]);
    expect(gate.isMounted).toBe(false);

    // ...and the host's own answer, whenever it lands, still wins outright.
    await gate.accept(active('current'));
    expect(loaded).toEqual(['current']);
  });

  it('the LAST timer still falls back, so a burst that names no active chat mounts', async () => {
    const loaded: string[] = [];
    const timers = armedTimers();
    const gate = new MountGate(async (sid) => void loaded.push(sid), undefined, timers.fn, 0);
    await gate.accept(created('s1'));
    await gate.accept({ type: 'contextUpdate', sessionId: 's1' });
    timers.fns.at(-1)!();
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toEqual(['s1']);
  });
});
