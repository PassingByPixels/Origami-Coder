// elasticParkHost.test.ts — t-w2txb2: the pieces around a park.
//   - EngineGate's `parked` stage (src/dashboard/engineGate.ts): held work starts ONE restore and goes in order;
//     the exit a park asked for is silent; a crash is still `stopped`.
//   - the tracker's engine views and host reads never touch a parked chat (src/elastic/sessionSignals.ts).
//   - a peer message for a parked chat starts it again; closing a parked chat removes its stand-in
//     (src/elastic/parkHost.ts, src/elastic/parkedMail.ts), and the mailbox folder names mirror the engine's.
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EngineGate, type EngineStatePost } from '../../../src/dashboard/engineGate';
import { QUIET } from '../../../src/elastic/activityClass';
import { engineViews, onScreenClient, type SignalSession } from '../../../src/elastic/sessionSignals';
import { ParkHost } from '../../../src/elastic/parkHost';
import { MAILBOX_DIR, PARKED_DIR, hasMail, removeStandIn, sessionOfMail, watchMail, writeStandIn } from '../../../src/elastic/parkedMail';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('EngineGate: the parked stage', () => {
  async function upGate() {
    const told: EngineStatePost[] = [];
    const gate = new EngineGate((p) => told.push(p));
    await gate.start(async () => undefined);
    return { gate, told };
  }

  it('the first held work starts ONE restore; prompts, interjections and calls then go in order', async () => {
    const { gate } = await upGate();
    const order: string[] = [];
    let restores = 0;
    let finish: () => void = () => undefined;
    expect(gate.park(() => { restores++; return new Promise<void>((r) => { finish = r; }); })).toBe(true);
    expect(gate.current).toBe('parked');
    const a = gate.turn(async () => { order.push('prompt 1'); });
    const call = gate.whenUp().then((ok) => order.push(`call ${ok}`));
    const b = gate.turn(async () => { order.push('prompt 2'); });
    await tick();
    expect(restores).toBe(1);
    expect(gate.current).toBe('starting');
    expect(order).toEqual([]);
    finish();
    await Promise.all([a, b, call]);
    expect(order).toEqual(['prompt 1', 'call true', 'prompt 2']);
    expect(gate.current).toBe('ready');
  });

  it('the exit a park asked for is silent (no crash card); a later crash is still a crash', async () => {
    const { gate } = await upGate();
    gate.park(async () => undefined);
    expect(gate.exited('origami-acp exited (code=0) (parked: a planned stop)')).toBe(true);
    expect(gate.current).toBe('parked');
    await gate.whenUp();
    expect(gate.exited('origami-acp exited (code=1)')).toBe(false);
    expect(gate.current).toBe('stopped');
  });

  it('t-wdyi2t (review #10): the pane is never told "parked", across a park, a restore, a failed restore and its Retry', async () => {
    const { gate, told } = await upGate();
    let tries = 0;
    gate.park(async () => { tries++; if (tries === 1) throw new Error('spawn failed'); });
    gate.exited('origami-acp exited (code=0) (parked: a planned stop)');
    const sent = gate.turn(async () => 'sent');
    await tick();
    await gate.retry();
    await sent;
    expect(told.map((p) => p.stage)).toEqual(['starting', 'failed', 'starting', 'ready']);
  });

  it('refuses to park with a turn in flight or work waiting; unpark goes back to ready', async () => {
    const { gate } = await upGate();
    const slot = await gate.hold();
    expect(gate.park(async () => undefined)).toBe(false);
    if (typeof slot !== 'string') slot.done();
    expect(gate.park(async () => undefined)).toBe(true);
    gate.unpark();
    expect(gate.current).toBe('ready');
  });

  it('a failed restore offers Retry, which runs the restore again', async () => {
    const told: EngineStatePost[] = [];
    const gate = new EngineGate((p) => told.push(p));
    await gate.start(async () => undefined);
    let tries = 0;
    gate.park(async () => { tries++; if (tries === 1) throw new Error('spawn failed'); });
    const sent = gate.turn(async () => 'sent');
    await tick();
    expect(gate.current).toBe('failed');
    expect(told.at(-1)).toMatchObject({ stage: 'failed', retry: true, held: 1 });
    await gate.retry();
    expect(await sent).toEqual({ sent: true, value: 'sent' });
    expect(tries).toBe(2);
  });
});

describe('sessionSignals: a parked chat is left alone', () => {
  const client = (name: string) => ({ name, extMethod: vi.fn(async () => ({})) });
  const session = (id: string, stage: string, c = client(id)): SignalSession & { client: ReturnType<typeof client> } => ({
    id, client: c, gate: { current: stage }, pendingPermissions: { size: 0 }, runningChildren: { size: 0 },
  });
  const win = { sidebarVisible: () => true, phoneFocus: () => null, engineBusy: () => false };

  it('is not an engine view (nothing is classed, trimmed or asked), and the others carry a park hook', () => {
    const parked = session('session-1', 'parked');
    const live = session('session-2', 'ready');
    const park = vi.fn(async () => null);
    const panel = { sessions: () => [parked, live], activeId: () => 'session-2', grid: () => false, solo: () => undefined, question: () => false, park };
    const views = engineViews(panel, { ...win, sidebarChat: () => 'session-2' }, undefined); // t-xp0dzr: the sidebar displays session-2
    expect(views.map((v) => v.label)).toEqual(['chat session-2 · kind chat · engine session (none yet)']); // t-xoenz1: kind, pid (none here) and engine session
    void views[0]!.park!();
    expect(park).toHaveBeenCalledWith('session-2');
    expect(views[0]!.signals).toEqual({ ...QUIET, onScreen: true, lastActivityAt: 0 });
  });

  it('is never the client of a host read, even on screen: the host engine answers instead', () => {
    const parked = session('session-1', 'parked');
    const panel = { sessions: () => [parked], activeId: () => 'session-1', grid: () => false, solo: () => undefined, question: () => false };
    expect(onScreenClient(panel, { ...win, sidebarChat: () => 'session-1' })).toBeUndefined(); // t-xp0dzr: the sidebar displays it
  });
});

describe('ParkHost: mail for a parked chat, and closing one', () => {
  function chat(id: string, sid: string, stage: string) {
    const whenUp = vi.fn(async () => true);
    // A real parked client has `wake` set (park.ts): ParkHost.closed keys on it (t-wdyi2t).
    return { id, gate: { current: stage, whenUp, park: () => true, unpark: () => undefined }, client: { currentSessionId: sid, wake: stage === 'parked' ? async () => undefined : null } as never, whenUp };
  }

  it('a message for a parked chat starts it (once per message event); a live or unknown one is left alone', () => {
    const parked = chat('session-1', 'ses_a', 'parked');
    const live = chat('session-2', 'ses_b', 'ready');
    const host = new ParkHost({ sessions: () => [parked, live], log: () => undefined });
    host.mailFor('ses_a');
    host.mailFor('ses_b');
    host.mailFor('ses_unknown');
    expect(parked.whenUp).toHaveBeenCalledTimes(1);
    expect(live.whenUp).not.toHaveBeenCalled();
  });

  it('watches the mailbox only once something was parked', async () => {
    const watch = vi.fn(() => ({ dispose: () => undefined }));
    const c = chat('session-1', 'ses_a', 'ready');
    const host = new ParkHost({ sessions: () => [c], log: () => undefined, watch, mail: () => false });
    expect(watch).not.toHaveBeenCalled();
    await host.park('session-9'); // no such chat: nothing to watch for
    expect(watch).not.toHaveBeenCalled();
  });

  it('closing a parked chat removes its stand-in; closing a live one does not', () => {
    const removed: string[] = [];
    const host = new ParkHost({ sessions: () => [], log: () => undefined, removeStandIn: (sid) => void removed.push(sid) });
    host.closed(chat('session-1', 'ses_a', 'parked'));
    host.closed(chat('session-2', 'ses_b', 'ready'));
    expect(removed).toEqual(['ses_a']);
  });
});

describe('parkedMail: the file protocol with the engine', () => {
  it('the folder names mirror the engine (origami/agent-broker.ts)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const broker = readFileSync(path.resolve(here, '../../../../engine/src/origami/agent-broker.ts'), 'utf8');
    expect(broker).toContain(`export const PARKED_DIR = "${PARKED_DIR}"`);
    expect(broker).toContain(`export const MAILBOX_DIR = "${MAILBOX_DIR}"`);
  });

  it('reads the engine session id off a mailbox event, and refuses a path that could leave the folder', () => {
    expect(sessionOfMail(`ses_abc${path.sep}1790000000000-m1.json`)).toBe('ses_abc');
    expect(sessionOfMail('ses_abc/1790000000000-m1.json')).toBe('ses_abc');
    expect(sessionOfMail('../x/1.json')).toBeNull();
    expect(sessionOfMail(null)).toBeNull();
  });

  it('the watch (real file system) names the engine session a message lands for; a tmp file is ignored', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'parked-watch-'));
    const seen: string[] = [];
    const w = watchMail((sid) => seen.push(sid), root);
    try {
      mkdirSync(path.join(root, MAILBOX_DIR, 'ses_w'), { recursive: true });
      writeFileSync(path.join(root, MAILBOX_DIR, 'ses_w', '1-m.json.9.tmp'), '{');
      writeFileSync(path.join(root, MAILBOX_DIR, 'ses_w', '1-m.json'), '{}');
      for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen)).toEqual(new Set(['ses_w']));
    } finally {
      w.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sees a delivered message (not a half-written one) and removes a stand-in', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'parked-mail-'));
    mkdirSync(path.join(root, MAILBOX_DIR, 'ses_a'), { recursive: true });
    writeFileSync(path.join(root, MAILBOX_DIR, 'ses_a', '1-m.json.123.tmp'), '{');
    expect(hasMail('ses_a', root)).toBe(false);
    writeFileSync(path.join(root, MAILBOX_DIR, 'ses_a', '1-m.json'), '{}');
    expect(hasMail('ses_a', root)).toBe(true);
    mkdirSync(path.join(root, PARKED_DIR), { recursive: true });
    writeFileSync(path.join(root, PARKED_DIR, 'ses_a.json'), '{}');
    removeStandIn('ses_a', root);
    expect(existsSync(path.join(root, PARKED_DIR, 'ses_a.json'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  // t-wypna7: a chat reopened at a reload without its engine gets its stand-in from the window, not from an engine.
  it('a stand-in the window writes has exactly the fields the engine reads (origami/agent-broker.ts Parked)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const broker = readFileSync(path.resolve(here, '../../../../engine/src/origami/agent-broker.ts'), 'utf8');
    const block = /export type Parked = \{([\s\S]*?)\n\}/.exec(broker)?.[1] ?? '';
    const engineKeys = [...block.matchAll(/readonly (\w+):/g)].map((m) => m[1]).sort();
    expect(engineKeys.length).toBeGreaterThan(0);
    const root = mkdtempSync(path.join(os.tmpdir(), 'parked-standin-'));
    try {
      expect(writeStandIn({ name: 'proj', cwd: '/work/proj', kind: 'interactive', sessionId: 'ses_s1', hostPid: 4242, parkedAt: 1790000000000 }, root)).toBe(true);
      const file = path.join(root, PARKED_DIR, 'ses_s1.json'); // the engine checks the file name equals the session id
      const read = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(read).sort()).toEqual(engineKeys);
      expect(read).toEqual({ version: 1, parked: true, name: 'proj', cwd: '/work/proj', kind: 'interactive', sessionId: 'ses_s1', hostPid: 4242, parkedAt: 1790000000000 });
      expect(readdirSync(path.join(root, PARKED_DIR))).toEqual(['ses_s1.json']); // no tmp file left behind
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes no stand-in for a session id that could leave its folder', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'parked-standin-'));
    try {
      expect(writeStandIn({ name: 'x', cwd: '/w', kind: 'interactive', sessionId: '../evil', hostPid: 1, parkedAt: 0 }, root)).toBe(false);
      expect(existsSync(path.join(root, PARKED_DIR))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// t-wdyi2t (review_extension-lifecycle.md #4, #9)
describe('ParkHost: a close in the middle of a park or a restore, and a finished fold', () => {
  /** A chat whose `_elastic_park` answer the test gives by hand. */
  function asking(id: string, sid: string) {
    let answer: (v: Record<string, unknown>) => void = () => undefined;
    const client = {
      currentSessionId: sid as string | null, wake: null as null | (() => Promise<void>), sets: new Map<string, string>(), calls: [] as string[],
      park: async () => undefined, restore: async () => true, setConfigOption: async () => undefined,
      getModelOption: () => null, getEffortOption: () => null, getModeOption: () => null,
      extMethod: async (m: string) => { client.calls.push(m); return m === '_elastic_park' ? new Promise<Record<string, unknown>>((r) => { answer = r; }) : {}; },
    };
    const gate = new EngineGate(() => undefined);
    return { id, client, gate, answer: (v: Record<string, unknown>) => answer(v) };
  }

  it('#4 closing a chat while its restore runs (gate "starting") removes its stand-in', () => {
    const removed: string[] = [];
    const host = new ParkHost({ sessions: () => [], log: () => undefined, removeStandIn: (sid) => void removed.push(sid) });
    const restoring = { id: 'session-1', gate: { current: 'starting', whenUp: async () => true, park: () => true, unpark: () => undefined }, client: { currentSessionId: 'ses_a', wake: async () => undefined } as never };
    host.closed(restoring);
    expect(removed).toEqual(['ses_a']);
  });

  it('#4 closing a chat while its park request is out removes the stand-in now AND after the engine answered', async () => {
    const removed: string[] = [];
    const c = asking('session-1', 'ses_a');
    await c.gate.start(async () => undefined);
    const host = new ParkHost({ sessions: () => [c], log: () => undefined, watch: () => ({ dispose() {} }), mail: () => false, removeStandIn: (sid) => void removed.push(sid) });
    const parking = host.park('session-1');
    await tick();
    host.closed(c);
    expect(removed).toEqual(['ses_a']);
    c.client.currentSessionId = null; // client.dispose()
    c.answer({ parked: true, sessionIds: ['ses_a'] }); // the engine wrote the stand-in after the first removal
    await parking;
    await tick();
    expect(removed).toEqual(['ses_a', 'ses_a']);
  });

  // t-xsrtml: an ordinary park (not through finished()/parkSoon) must also tell the caller — the
  // Nest hub reads this to touch() its index within 2 s instead of waiting for the 30 s tick.
  it('t-xsrtml: an ordinary successful park calls changed(), the same signal a restore already gets', async () => {
    const c = asking('session-1', 'ses_a');
    await c.gate.start(async () => undefined);
    const changed = vi.fn();
    const host = new ParkHost({ sessions: () => [c], log: () => undefined, watch: () => ({ dispose() {} }), mail: () => false, changed });
    const parking = host.park('session-1');
    c.answer({ parked: true });
    expect(await parking).toBeNull();
    expect(changed).toHaveBeenCalled();
  });

  it('#9 a finished fold is not parked by ParkHost itself; it is marked parkSoon, and its park waives only warm-pending', async () => {
    const c = asking('session-1', 'ses_a');
    await c.gate.start(async () => undefined);
    const changed = vi.fn();
    const host = new ParkHost({ sessions: () => [c], log: () => undefined, watch: () => ({ dispose() {} }), mail: () => false, changed });
    expect(await host.finished('session-1', ['warm-pending'])).toBeNull();
    expect(c.client.calls).toEqual([]);
    expect(host.parkSoon('session-1')).toBe(true);
    expect(changed).toHaveBeenCalled(); // the tracker reads it on its next pass
    const params: unknown[] = [];
    c.client.extMethod = async (m: string, p?: unknown) => { params.push(p); return m === '_elastic_park' ? { parked: true } : {}; };
    expect(await host.park('session-1')).toBeNull();
    expect(params[0]).toMatchObject({ allow: ['warm-pending'] });
    expect(host.parkSoon('session-1')).toBe(false);
  });

  it('#9 a finished fold the user takes up again (a turn runs) becomes an ordinary chat: no early park, no waived warm', async () => {
    const c = { ...asking('session-1', 'ses_a'), turnBusy: false };
    const host = new ParkHost({ sessions: () => [c], log: () => undefined });
    await host.finished('session-1', ['warm-pending']);
    expect(host.parkSoon('session-1')).toBe(true);
    c.turnBusy = true;
    expect(host.parkSoon('session-1')).toBe(false);
    c.turnBusy = false;
    expect(host.parkSoon('session-1')).toBe(false);
  });
});
