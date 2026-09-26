// t-sc093o — the Nests wiring end to end: TWO desks, ONE process.
//
// Real: both GroupControllers (keychains, derivation, sealed frames, seq
// marks), the frame chunker, and the two NestHubs under test. Faked: the relay
// (LoopbackRelay, the relay's own rules) and each desk's ENGINE, by
// FakeNestEngine below, which answers the L4a methods in their exact reply
// shapes (packages/engine/src/storage/nests.ts) and the L5 methods in the
// t-sb9tlk host contract. What this proves that no unit test can: rows reach
// the other desk's engine and its webview, a body crosses in chunks over the
// sealed link and resumes after a gap, and a take-over tells the old owner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopbackRelay, settle } from './remoteLoopback';
import { GroupController } from '../../../src/remote/groupController';
import { GroupRosterStore } from '../../../src/remote/groupMembers';
import { SEQ_KEY, registerRemoteSeq, resetRemoteSeq } from '../../../src/remote/seqStore';
import { derivePairRid, pairRole } from '../../../src/remote/groupCrypto';
import { ROLE_DESKTOP } from '../../../src/remote/frame';
import { groupHelloMessage } from '../../../src/remote/groupWire';
import type { SecretStore } from '../../../src/remote/pairing';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';
import { NEST_SYNC_MS, NestHub } from '../../../src/dashboard/nestHub';
import { NEST_GROUP_VERBS } from '../../../src/remote/nestWire';
import { HostEngine, attachHostNestView, type HostClient } from '../../../src/dashboard/hostEngine';
import { NAMED_REFUSALS } from '../../../src/remote/remoteVerbs';

const RELAY = 'wss://relay.test';

function secrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => { map.set(k, v); return Promise.resolve(); },
    delete: (k) => { map.delete(k); return Promise.resolve(); },
  };
}
function memento(): { get<T>(k: string, d: T): T; update(k: string, v: unknown): PromiseLike<void> } {
  const bag = new Map<string, unknown>();
  return {
    get: <T,>(k: string, d: T) => (bag.has(k) ? (bag.get(k) as T) : d),
    update: (k, v) => { bag.set(k, v); return Promise.resolve(); },
  };
}
class RelayFleet {
  public readonly byRid = new Map<string, LoopbackRelay>();
  public relay(rid: string): LoopbackRelay {
    let found = this.byRid.get(rid);
    if (!found) this.byRid.set(rid, (found = new LoopbackRelay()));
    return found;
  }
  public connect = (url: string): RemoteSocket => {
    const rid = decodeURIComponent(/\/r\/([^?]+)/.exec(url)?.[1] ?? '');
    return this.relay(rid).connect(url) as unknown as RemoteSocket;
  };
}

type Ev = { id: string; aggregateID: string; seq: number; type: string; data: Record<string, unknown> };
type Session = { id: string; title: string; owner: string | null; state: 'running' | 'open' | 'closed'; events: Ev[] };

/** One desk's engine store, answering in the L4a / L5 shapes. */
class FakeNestEngine {
  public readonly sessions = new Map<string, Session>();
  public readonly foreign = new Map<string, unknown[]>();
  public readonly calls: Array<[string, Record<string, unknown>]> = [];
  /** Test hook: the next export skips this many events (a lost chunk). */
  public skipOnce = 0;
  constructor(public perChunk = 2) {}

  public add(id: string, title: string, n: number, state: Session['state'] = 'open', big = 0): void {
    const events = Array.from({ length: n }, (_, seq) => ({
      id: `${id}-e${seq}`, aggregateID: id, seq, type: 'message.part.updated.1',
      data: { text: seq === 0 && big ? 'x'.repeat(big) : `event ${seq}` },
    }));
    this.sessions.set(id, { id, title, owner: null, state, events });
  }

  public extMethod = async (method: string, p: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    this.calls.push([method, p]);
    if (p['enabled'] !== true) throw Object.assign(new Error(`${method} refused: Nests is off on this desk`), { code: -32602 });
    const self = String(p['deviceId']);
    const s = (id: unknown) => this.sessions.get(String(id));
    switch (method) {
      case 'nest_index': {
        const rows = [...this.sessions.values()].map((x) => ({
          id: x.id, title: x.title, desk: self, deskName: String(p['deskName']), state: x.owner && x.owner !== self ? 'closed' : x.state,
          owner: x.owner ?? self, lastAt: 1_000 + x.events.length, size: x.events.length * 10, seq: x.events.length - 1,
        }));
        return { rows, others: [...this.foreign.values()].flat() };
      }
      case 'nest_apply_index': {
        const rows = (p['rows'] as Array<Record<string, unknown>>).filter((r) => r['desk'] === p['desk']);
        this.foreign.set(String(p['desk']), rows);
        return { inserted: rows.length, updated: 0, unchanged: 0, stale: 0, rejected: 0, removed: 0 };
      }
      case 'nest_export': {
        const x = s(p['sessionId']);
        if (!x) return { refused: 'not-found', sessionId: p['sessionId'] };
        const after = Number(p['after']) + this.skipOnce;
        this.skipOnce = 0;
        const events = x.events.filter((e) => e.seq > after).slice(0, this.perChunk);
        const last = x.events.length - 1;
        const to = events.length ? events[events.length - 1]!.seq : after;
        return { sessionId: x.id, owner: x.owner ?? self, from: after + 1, to, last, done: to >= last, events };
      }
      case 'nest_import': {
        const c = p['chunk'] as { sessionId: string; owner: string; last: number; events: Ev[] };
        let x = s(c.sessionId);
        const have = x ? x.events.length - 1 : -1;
        const res = (h: number, refused?: string) => ({ sessionId: c.sessionId, have: h, applied: h - have, done: h >= c.last, ...(refused ? { refused } : {}) });
        if (x && (x.owner ?? self) !== c.owner) return res(have, 'owner');
        if (c.events.length === 0) return res(have);
        if (c.events[0]!.seq > have + 1) return res(have, 'gap');
        if (!x) this.sessions.set(c.sessionId, (x = { id: c.sessionId, title: c.sessionId, owner: c.owner, state: 'closed', events: [] }));
        for (const e of c.events) if (e.seq > x.events.length - 1) x.events.push(e);
        return res(x.events.length - 1);
      }
      case 'nest_continue': {
        const x = s(p['sessionId']);
        if (!x) return { refused: 'not-found', sessionId: p['sessionId'] };
        const seq = x.events.length - 1;
        if (p['ownerRunning'] === true) {
          const id = `${x.id}-fork`;
          this.sessions.set(id, { ...x, id, owner: self, events: [...x.events] });
          return { result: 'forked', sessionId: id, forkOf: { id: x.id, desk: x.owner, at: 1 }, seq };
        }
        x.owner = self;
        return { result: 'taken', sessionId: x.id, seq };
      }
      case 'nest_release': {
        const x = s(p['sessionId']);
        if (!x) return { refused: 'not-found', sessionId: p['sessionId'] };
        x.owner = String(p['owner']);
        x.state = 'closed';
        return { sessionId: x.id, owner: x.owner, seq: x.events.length - 1, aborted: true };
      }
      case 'nest_reconcile': {
        const x = s(p['sessionId'])!;
        const remote = Number(p['remoteSeq']);
        if (x.events.length - 1 <= remote) return { result: 'clean', sessionId: x.id, have: x.events.length - 1 };
        const fork = { sessionId: `${x.id}-rec`, title: `${x.title} (5090, 14:02)`, forkOf: { id: x.id, desk: self, at: 1 } };
        this.sessions.set(fork.sessionId, { ...x, id: fork.sessionId, owner: self, events: [...x.events] });
        x.events = x.events.slice(0, remote + 1);
        return { result: 'forked', sessionId: x.id, have: remote, owner: String(p['owner']), fork };
      }
    }
    throw Object.assign(new Error('Method not found'), { code: -32601 });
  };
}

interface Desk {
  ctl: GroupController;
  hub: NestHub;
  engine: FakeNestEngine;
  posts: Array<Record<string, unknown>>;
  opened: string[];
  ticks: Array<{ fn: () => void; ms: number }>;
  status: string[];
  /** While true the transport's reconnect timers wait: the desk stays offline. */
  hold: { on: boolean; queued: Array<() => void> };
  /** The keychain and globalState: pass them to makeDesk again to restart the desk. */
  keep: { secrets: SecretStore; roster: GroupRosterStore };
  /** t-xsrtml: this window's open-chat engine session ids, as the panel would report them
   *  (incl. a parked chat's id). Mutable so a test can change what is "open" mid-run. */
  openIds: string[];
}

function makeDesk(name: string, fleet: RelayFleet, keep: Desk['keep'] = { secrets: secrets(), roster: new GroupRosterStore(memento()) }): Desk {
  const ticks: Desk['ticks'] = [];
  const status: string[] = [];
  const openIds: string[] = [];
  const hub = new NestHub({
    enabled: () => true,
    // The 30 s index tick is captured and fired by hand; the pull's answer
    // timeout is shortened so a silent peer fails the test in milliseconds.
    setTimer: (fn, ms) => (ms === NEST_SYNC_MS ? (ticks.push({ fn, ms }), ticks.length) : setTimeout(fn, 60)),
    clearTimer: (h) => { if (typeof h !== 'number') clearTimeout(h as ReturnType<typeof setTimeout>); },
    status: (t) => status.push(t),
  });
  const hold: Desk['hold'] = { on: false, queued: [] };
  const deps: TransportDeps = {
    connect: fleet.connect,
    setTimer: (fn, ms) => (hold.on ? void hold.queued.push(fn) : setTimeout(fn, ms)),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const ctl = new GroupController({
    config: () => ({ enabled: true, relayUrl: RELAY }), secrets: keep.secrets, deps, deviceName: name,
    roster: keep.roster,
    onStatus: (t) => status.push(t),
    onChange: () => hub.onGroupChange(),
    onPeerMessage: (peer, msg) => void hub.onPeer(peer, msg),
  });
  const engine = new FakeNestEngine();
  const posts: Array<Record<string, unknown>> = [];
  const opened: string[] = [];
  hub.attachGroup({ deviceId: () => ctl.deviceId, deskName: name, devices: () => ctl.snapshot().devices, send: (p, m) => ctl.send(p, m) });
  hub.attachView({ engine: () => engine, post: (m) => void posts.push(m), open: (id) => void opened.push(id), openSessionIds: () => openIds });
  return { ctl, hub, engine, posts, opened, ticks, status, hold, keep, openIds };
}

// t-tbyb2c: a Date.now() deadline reads as "failed" under CPU contention
// alone, with no forward progress lost — a busy box just gets fewer event
// loop turns per wall-clock millisecond. Bound the poll by attempts instead,
// so a slow box still gets there; only a condition that never turns true
// fails, and vitest's own test timeout (raised below) is the backstop against
// a genuinely stuck test.
const UNTIL_ATTEMPTS = 4_000;
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < UNTIL_ATTEMPTS && !cond(); i++) await settle(2);
  expect(cond(), what).toBe(true);
}
/** t-sj32zl: invite, paste, and the inviting desk's owner clicks Accept. */
async function admit(inviter: Desk, joiner: Desk): Promise<void> {
  await joiner.ctl.join((await inviter.ctl.invite()).key);
  await until(() => inviter.ctl.snapshot().joinCheck?.side === 'inviter', 'the inviting desk shows the join request');
  await inviter.ctl.answerJoin(true);
}
const lastIndex = (d: Desk) => [...d.posts].reverse().find((m) => m['type'] === 'origami/nestIndex') as { rows: Array<Record<string, unknown>>; desks: Array<Record<string, unknown>> } | undefined;
const ids = (d: Desk) => (lastIndex(d)?.rows ?? []).map((r) => r['id']);

describe('Nests wiring — two desks over a loopback relay', () => {
  let fleet: RelayFleet;
  let A: Desk;
  let B: Desk;
  let seq: ReturnType<typeof memento>;

  beforeEach(async () => {
    registerRemoteSeq((seq = memento()));
    fleet = new RelayFleet();
    A = makeDesk('Surface', fleet);
    B = makeDesk('5090', fleet);
    A.engine.add('a1', 'Godot rig', 2);
    B.engine.add('b1', 'Agent message', 5);
    B.engine.add('b2', 'Cron sweep', 3, 'running');
    B.engine.add('b3', 'Big paste', 4, 'open', 40_000);
    await admit(A, B);
    await until(() => ids(A).length === 3 && ids(B).length === 1, 'both desks received the other desk\'s rows');
  });

  afterEach(() => {
    A.ctl.dispose();
    B.ctl.dispose();
    resetRemoteSeq();
  });

  it('index: rows cross on the desk arriving, land in the other engine, and the webview gets only the OTHER desk\'s rows', () => {
    const a = A.ctl.deviceId!;
    const b = B.ctl.deviceId!;
    expect(ids(A).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(ids(B)).toEqual(['a1']);
    expect(lastIndex(A)!.rows.every((r) => r['desk'] === b)).toBe(true);
    // Each engine was told the other desk's rows, under that desk's id.
    expect(A.engine.calls.find(([m]) => m === 'nest_apply_index')![1]).toMatchObject({ enabled: true, deviceId: a, desk: b, replace: true });
    // The desks travel too, both online.
    expect(lastIndex(A)!.desks.map((d) => [d['id'], d['online']]).sort()).toEqual([[a, true], [b, true]].sort());
    expect(A.ticks.map((t) => t.ms)).toEqual([30_000]);
  });

  // t-xsrtml: nestHub.sync() used to hard-code `open: []` — the extension never told the engine
  // which chats are open in the window, so a parked chat (no engine loaded) could never read as
  // open on a peer. openSessionIds() is the extension's own answer; sync() must forward it as is.
  it('t-xsrtml: nest_index carries this window\'s open-chat ids, incl. a parked chat with no engine loaded', async () => {
    A.openIds.push('a1', 'a-parked'); // same array the attachView() closure reads; reassigning A.openIds would not be seen
    A.engine.calls.length = 0;
    await A.hub.sync();
    const call = A.engine.calls.find(([m]) => m === 'nest_index');
    expect(call?.[1]['open']).toEqual(['a1', 'a-parked']);
  });

  it('index: the 30 s tick resends, a desk going offline keeps its last rows with online=false', async () => {
    B.engine.add('b4', 'New on the 5090', 1);
    B.ticks.shift()!.fn();
    await until(() => ids(A).includes('b4'), 'the tick carried the new row');
    B.ctl.dispose();
    const b = B.ctl.snapshot().deviceId;
    await until(() => lastIndex(A)!.desks.find((d) => d['id'] === b)?.['online'] === false, 'desk B shows offline');
    expect(ids(A).sort()).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  // t-z6nt1b: a close writes no journal event (seq unchanged); the touch sync must still carry it.
  it('t-z6nt1b: a state-only change (open -> closed, same seq) reaches the other desk within one touch sync', async () => {
    const state = () => lastIndex(A)!.rows.find((r) => r['id'] === 'b3')?.['state'];
    expect(state()).toBe('open');
    B.engine.sessions.get('b3')!.state = 'closed';
    B.hub.touch(); // the fixture runs the 2 s touch timer as a short real timeout
    await until(() => state() === 'closed', 'the closed state crossed');
  });

  it('continue (idle owner): the body crosses in chunks over the link, then taken, the chat opens here, the owner gets nest_release', async () => {
    const r = await A.hub.continueHere('b3');
    expect(r).toEqual({ result: 'taken', newId: 'b3' });
    // The body is here, byte for byte, including the 40 KB event that needed the frame chunker.
    expect(A.engine.sessions.get('b3')!.events).toEqual(B.engine.sessions.get('b3')!.events);
    const exports = B.engine.calls.filter(([m]) => m === 'nest_export').map(([, p]) => p['after']);
    expect(exports).toEqual([-1, 1]);
    expect(A.engine.calls.find(([m]) => m === 'nest_continue')![1]).toMatchObject({ sessionId: 'b3', ownerOnline: true, ownerRunning: false });
    expect(A.opened).toEqual(['b3']);
    await until(() => B.engine.calls.some(([m]) => m === 'nest_release'), 'the old owner released');
    expect(B.engine.calls.find(([m]) => m === 'nest_release')![1]).toMatchObject({ sessionId: 'b3', owner: A.ctl.deviceId });
    expect(B.engine.sessions.get('b3')!.owner).toBe(A.ctl.deviceId);
    // It left A's Nest at once, and stays out once B re-sends it owned by A;
    // on B it is now a chat in the Nest, held and written by A.
    expect(ids(A)).not.toContain('b3');
    await until(() => ids(B).includes('b3'), 'B lists the moved chat in its Nest');
    expect(lastIndex(B)!.rows.find((r) => r['id'] === 'b3')).toMatchObject({ desk: A.ctl.deviceId, owner: A.ctl.deviceId });
    expect(ids(A).sort()).toEqual(['b1', 'b2']);
  });

  it('continue (owner mid-turn): forked, the fork opens, no release is sent', async () => {
    const r = await A.hub.continueHere('b2');
    expect(r).toEqual({ result: 'forked', newId: 'b2-fork' });
    expect(A.engine.calls.find(([m]) => m === 'nest_continue')![1]).toMatchObject({ ownerRunning: true });
    expect(A.opened).toEqual(['b2-fork']);
    await settle(20);
    expect(B.engine.calls.some(([m]) => m === 'nest_release')).toBe(false);
    expect(ids(A)).toContain('b2');
  });

  it('t-t7l3pa: a desk that forgets its group and joins again keeps its id, so a chat it took stays its own', async () => {
    const b = B.ctl.deviceId!;
    await B.hub.continueHere('a1');
    expect(B.engine.sessions.get('a1')!.owner).toBe(b);
    const kg = (A.ctl as unknown as { group: { current: { kg: Uint8Array } } }).group.current.kg;
    await B.ctl.forget();
    // Same Kg and ids, so the same pair rid. The seq store is ONE per process
    // (see the L7 restart test): model B's own record, which holds only what B accepted.
    const rid = await derivePairRid(kg, b, A.ctl.deviceId!);
    const marks = seq.get<Record<string, { out: number; in: number }>>(SEQ_KEY, {});
    await seq.update(SEQ_KEY, { ...marks, [rid]: { out: marks[rid]!.out, in: 0 } });
    A.posts.length = 0;
    await admit(A, B);
    await until(() => B.ctl.deviceId !== null, 'B holds the group again');
    // The owner-visible fault: a new id here left a1 owned by the old one.
    expect(B.ctl.deviceId).toBe(b);
    const up = (x: Desk, id: string) => x.ctl.snapshot().devices.find((d) => d.id === id)?.online === true;
    await until(() => up(A, b) && up(B, A.ctl.deviceId!), 'A and B are linked again');
    B.ticks.shift()!.fn(); // the 30 s tick carries B's rows
    await until(() => ids(A).includes('a1'), 'A lists the chat B took, after B joined again');
    expect(lastIndex(A)!.rows.find((r) => r['id'] === 'a1')).toMatchObject({ desk: b, owner: b });
    expect(lastIndex(A)!.desks.map((d) => d['id']).sort()).toEqual([A.ctl.deviceId, b].sort());
  });

  it('t-t7l3pa: a desk not in the roster is never a desk in the Nest, and a chat open on an online desk under an unknown owner is not offline', async () => {
    const b = B.ctl.deviceId!;
    const GHOST = 'gNvJjvRNjEo'; // the owner's live case: the Mac's id before it re-paired
    B.engine.add('bg', 'Greeting and quick check-in', 3, 'open');
    B.engine.sessions.get('bg')!.owner = GHOST;
    // The real engine reports a chat another id writes as open (never running) when it is open here.
    const real = B.engine.extMethod;
    B.engine.extMethod = async (m, p) => {
      const r = await real(m, p);
      if (m === 'nest_index') for (const row of r['rows'] as Array<Record<string, unknown>>) if (row['id'] === 'bg') row['state'] = 'open';
      return r;
    };
    // A still holds the rows the old id sent: an older copy of bg, and a chat only it had.
    const ghostRow = (id: string, state: string) => ({ id, title: id, desk: GHOST, deskName: '5090', state, owner: GHOST, lastAt: 1, size: 10, seq: 1 });
    A.engine.foreign.set(GHOST, [ghostRow('bg', 'open'), ghostRow('g-only', 'closed')]);
    B.ticks.shift()!.fn();
    await until(() => ids(A).includes('bg'), 'A lists bg');
    const rows = lastIndex(A)!.rows;
    expect(rows.filter((r) => r['desk'] === GHOST)).toEqual([]);
    expect(ids(A)).not.toContain('g-only');
    expect(rows.find((r) => r['id'] === 'bg')).toMatchObject({ desk: b, state: 'open', owner: GHOST });
    // Continue here reads the owner as the desk that reports the chat open, which is online.
    await A.hub.continueHere('bg');
    expect(A.engine.calls.find(([m]) => m === 'nest_continue')![1]).toMatchObject({ sessionId: 'bg', ownerOnline: true, ownerRunning: false });
  });

  it('pull resumes: a lost chunk (gap) is asked for again from `have`, and a broken pull restarts where the store stands', async () => {
    B.engine.skipOnce = 2;
    await A.hub.openRead('b1');
    expect(A.engine.sessions.get('b1')!.events).toHaveLength(5);
    const after = B.engine.calls.filter(([m]) => m === 'nest_export').map(([, p]) => p['after']);
    expect(after).toEqual([-1, -1, 1, 3]);
    expect(A.opened).toEqual(['b1']);

    // A peer that goes silent mid-pull: the pull fails, and the next one starts from what arrived.
    B.engine.add('b5', 'Long', 6);
    B.ticks.shift()!.fn();
    await until(() => ids(A).includes('b5'), 'b5 is in the index');
    let served = 0;
    const real = B.engine.extMethod;
    B.engine.extMethod = async (m, p) => (m === 'nest_export' && ++served > 1 ? new Promise(() => undefined) : real(m, p));
    await expect(A.hub.openRead('b5')).rejects.toThrow(/did not answer/);
    expect(A.engine.sessions.get('b5')!.events).toHaveLength(2);
    B.engine.extMethod = real;
    await A.hub.openRead('b5');
    const resumed = B.engine.calls.filter(([m, p]) => m === 'nest_export' && p['sessionId'] === 'b5').map(([, p]) => p['after']);
    // The hung request never reached the engine; the second pull asks from 1, not from -1.
    expect(resumed).toEqual([-1, 1, 3]);
    expect(A.engine.sessions.get('b5')!.events).toHaveLength(6);
  });

  it('continue (owner offline): taken here; on its return the owner gets the release, reconciles what it wrote offline, and pulls from here', async () => {
    await A.hub.openRead('b1');
    const a = A.ctl.deviceId!;
    const b = B.ctl.deviceId!;
    // B's socket drops (a sleeping laptop) and cannot reconnect until released.
    const kg = (A.ctl as unknown as { group: { current: { kg: Uint8Array } } }).group.current.kg;
    const relay = fleet.relay(await derivePairRid(kg, a, b));
    B.hold.on = true;
    if (pairRole(b, a) === ROLE_DESKTOP) relay.dropDesktop();
    else relay.dropPhone();
    await until(() => lastIndex(A)!.desks.find((d) => d['id'] === b)?.['online'] === false, 'desk B is offline');
    // B writes on while it is away.
    const ev = B.engine.sessions.get('b1')!.events;
    ev.push({ ...ev[0]!, id: 'b1-offline', seq: ev.length, data: { text: 'written offline' } });
    const r = await A.hub.continueHere('b1');
    expect(r).toEqual({ result: 'taken', newId: 'b1' });
    expect(A.engine.calls.find(([m]) => m === 'nest_continue')![1]).toMatchObject({ ownerOnline: false, ownerRunning: false });
    expect(B.engine.calls.some(([m]) => m === 'nest_release')).toBe(false);
    B.hold.on = false;
    for (const fn of B.hold.queued.splice(0)) fn();
    await until(() => B.engine.calls.some(([m]) => m === 'nest_reconcile'), 'B reconciled on its return');
    expect(B.engine.calls.find(([m]) => m === 'nest_release')![1]).toMatchObject({ sessionId: 'b1', owner: A.ctl.deviceId });
    expect(B.engine.calls.find(([m]) => m === 'nest_reconcile')![1]).toMatchObject({ sessionId: 'b1', remoteSeq: 4, owner: A.ctl.deviceId });
    // The offline event is in B's fork; the original is back to what A holds, and B asked A from there.
    expect(B.engine.sessions.get('b1-rec')!.events.map((e) => e.id)).toContain('b1-offline');
    await until(() => A.engine.calls.some(([m, p]) => m === 'nest_export' && p['sessionId'] === 'b1'), 'B pulled the original from A');
    expect(A.engine.calls.find(([m, p]) => m === 'nest_export' && p['sessionId'] === 'b1')![1]).toMatchObject({ after: 4 });
    expect(B.engine.sessions.get('b1')!.events).toEqual(A.engine.sessions.get('b1')!.events);
  });

  it('a release names its sender: a desk cannot release a chat on behalf of another', async () => {
    await B.hub.onPeer(A.ctl.deviceId!, { type: 'nest/release', sessionId: 'b1', newOwner: 'ZZZZZZZZZZZ' });
    expect(B.engine.calls.some(([m]) => m === 'nest_release')).toBe(false);
  });
});

// t-selspn (Nests L6): THREE desks. A writes, B is the mother base and tails
// every live chat, C is a third desk. The claims: B holds A's turns within a
// tick; with A shut, C pulls from B (the online desk with the highest seq) and
// Continue here on B is `taken` with the whole body; A comes back, gets the
// release, and its offline write is kept in a fork. Nothing is lost.
describe('Nests tail — the mother base keeps every live chat (L6)', () => {
  let fleet: RelayFleet;
  let A: Desk;
  let B: Desk;
  let C: Desk;
  const idOf = (d: Desk) => d.ctl.deviceId!;
  const online = (from: Desk, to: Desk) => lastIndex(from)?.desks.find((d) => d['id'] === idOf(to))?.['online'] === true;
  const tailOf = (d: Desk) => (lastIndex(d) as unknown as { tail?: { running: boolean; desks: Record<string, unknown> } | null }).tail;

  /** Drop `d`'s side of its link to `peer`; with `d.hold.on` it stays down. */
  async function dropLink(d: Desk, peer: Desk): Promise<void> {
    const kg = (A.ctl as unknown as { group: { current: { kg: Uint8Array } } }).group.current.kg;
    const relay = fleet.relay(await derivePairRid(kg, idOf(d), idOf(peer)));
    if (pairRole(idOf(d), idOf(peer)) === ROLE_DESKTOP) relay.dropDesktop();
    else relay.dropPhone();
  }

  beforeEach(async () => {
    registerRemoteSeq(memento());
    fleet = new RelayFleet();
    A = makeDesk('MacBook', fleet);
    B = makeDesk('5090', fleet);
    C = makeDesk('Surface', fleet);
    A.engine.add('a7', 'Rig retarget', 3, 'running');
    A.engine.add('a8', 'Old closed chat', 2, 'closed');
    await admit(A, B);
    await until(() => online(A, B) && online(B, A), 'A and B are linked');
    await admit(A, C);
    // No introduction: A gossips C's arrival to B (t-sfyata), C learns B from the welcome.
    await until(() => online(B, C) && online(C, B) && online(C, A), 'all three desks are linked');
    for (const d of [A, B, C]) await d.ctl.markMotherBase(idOf(B));
    // The mother base tails on the next index merge: here, B's own tick.
    B.ticks.shift()!.fn();
    await until(() => B.engine.sessions.get('a7')?.events.length === 3, 'B tailed the running chat');
  });

  afterEach(() => {
    for (const d of [A, B, C]) d.ctl.dispose();
    resetRemoteSeq();
  });

  it('tails live chats only, holds them read only, and keeps up within one tick of A writing', async () => {
    // A closed chat that never changed is not copied; the tailed copy keeps A as its writer.
    expect(B.engine.sessions.has('a8')).toBe(false);
    expect(B.engine.sessions.get('a7')!.owner).toBe(idOf(A));
    expect(A.engine.calls.filter(([m]) => m === 'nest_export').every(([, p]) => p['sessionId'] === 'a7')).toBe(true);
    // A writes a turn. B's next tick asks from what it holds and gets only the new range.
    const ev = A.engine.sessions.get('a7')!.events;
    for (let i = 0; i < 3; i++) ev.push({ ...ev[0]!, id: `a7-t${i}`, seq: ev.length, data: { text: `turn ${i}` } });
    const before = A.engine.calls.length;
    B.ticks.shift()!.fn();
    await until(() => B.engine.sessions.get('a7')!.events.length === 6, 'B holds the new turn after one tick');
    expect(B.engine.sessions.get('a7')!.events).toEqual(A.engine.sessions.get('a7')!.events);
    expect(A.engine.calls.slice(before).find(([m, p]) => m === 'nest_export' && p['sessionId'] === 'a7')![1]).toMatchObject({ after: 2 });
    // The Nests view on B: A's chat is tailed and up to date, and no tail is running now.
    await until(() => tailOf(B)?.running === false && tailOf(B)?.desks[idOf(A)] !== undefined, 'B posts its tail status');
    expect(tailOf(B)).toEqual({ running: false, desks: { [idOf(A)]: { tailed: 1, behind: 0 } } });
    // Only the mother base tails, and only it posts a tail status.
    expect(C.engine.sessions.has('a7')).toBe(false);
    expect(tailOf(C)).toBeNull();
  });

  it('A shut: C pulls from B (highest online seq); Continue here on B is taken with the whole body; A returns and reconciles with no loss', async () => {
    const ev = A.engine.sessions.get('a7')!.events;
    ev.push({ ...ev[0]!, id: 'a7-t0', seq: ev.length, data: { text: 'turn 0' } });
    B.ticks.shift()!.fn();
    await until(() => B.engine.sessions.get('a7')!.events.length === 4, 'B tailed the turn');
    const body = structuredClone(A.engine.sessions.get('a7')!.events);
    // B's index (sent by the tail's touch) tells C that B holds seq 3.
    const cSeesB = () => (C.engine.foreign.get(idOf(B)) as Array<Record<string, unknown>> | undefined)?.some((r) => r['id'] === 'a7' && r['seq'] === 3) === true;
    await until(cSeesB, 'C sees the copy on B');

    // A's laptop shuts: both its links drop and stay down; it writes on offline.
    A.hold.on = true;
    await dropLink(A, B);
    await dropLink(A, C);
    await until(() => !online(B, A) && !online(C, A), 'A is offline for B and C');
    ev.push({ ...ev[0]!, id: 'a7-offline', seq: ev.length, data: { text: 'written offline' } });

    // C: a plain click. The body comes from B, the only online holder, at B's seq.
    const served = B.engine.calls.length;
    await C.hub.openRead('a7');
    expect(C.engine.sessions.get('a7')!.events).toEqual(body);
    expect(B.engine.calls.slice(served).some(([m, p]) => m === 'nest_export' && p['sessionId'] === 'a7')).toBe(true);
    expect(C.opened).toEqual(['a7']);

    // B: Continue here with the owner shut. Taken, and the whole body is here.
    const r = await B.hub.continueHere('a7');
    expect(r).toEqual({ result: 'taken', newId: 'a7' });
    expect(B.engine.calls.find(([m]) => m === 'nest_continue')![1]).toMatchObject({ ownerOnline: false, ownerRunning: false });
    expect(B.engine.sessions.get('a7')!.events).toEqual(body);
    expect(B.engine.sessions.get('a7')!.owner).toBe(idOf(B));

    // A comes back: the release arrives, A reconciles past seq 3, its offline turn is a fork, the original matches B.
    A.hold.on = false;
    for (const fn of A.hold.queued.splice(0)) fn();
    await until(() => A.engine.calls.some(([m]) => m === 'nest_reconcile'), 'A reconciled on its return');
    expect(A.engine.calls.find(([m]) => m === 'nest_release')![1]).toMatchObject({ sessionId: 'a7', owner: idOf(B) });
    expect(A.engine.calls.find(([m]) => m === 'nest_reconcile')![1]).toMatchObject({ remoteSeq: 3, owner: idOf(B) });
    expect(A.engine.sessions.get('a7-rec')!.events.map((e) => e.id)).toContain('a7-offline');
    await until(() => A.engine.sessions.get('a7')!.events.length === 4, 'A pulled the original back from B');
    expect(A.engine.sessions.get('a7')!.events).toEqual(B.engine.sessions.get('a7')!.events);
    expect(A.engine.sessions.get('a7')!.owner).toBe(idOf(B));
  });
});

// t-sfyata (Nests L7): ROSTER GOSSIP. C joins through A only; nobody tells B.
// The claims: B and C link and swap nest/index on their own; a restarted desk
// reopens every link from what it persisted; a removal and a mother-base mark
// made on ONE desk reach the other two.
describe('Nests roster gossip — a desk that joins through A is known to B (L7)', () => {
  let fleet: RelayFleet;
  let A: Desk;
  let B: Desk;
  let C: Desk;
  const idOf = (d: Desk) => d.ctl.deviceId!;
  const sees = (from: Desk, to: Desk) => from.ctl.snapshot().devices.find((d) => d.id === idOf(to));
  const linked = (x: Desk, y: Desk) => sees(x, y)?.online === true && sees(y, x)?.online === true;
  const base = (d: Desk) => d.ctl.snapshot().devices.find((x) => x.motherBase)?.id ?? null;
  let seq: ReturnType<typeof memento>;

  beforeEach(async () => {
    registerRemoteSeq((seq = memento()));
    fleet = new RelayFleet();
    A = makeDesk('MacBook', fleet);
    B = makeDesk('5090', fleet);
    C = makeDesk('Surface', fleet);
    B.engine.add('b1', 'On the 5090', 2);
    C.engine.add('c1', 'On the Surface', 3);
    await admit(A, B);
    await until(() => linked(A, B), 'A and B are linked');
    await admit(A, C);
    await until(() => linked(A, C) && linked(B, C), 'all three desks are linked');
  });

  afterEach(() => {
    for (const d of [A, B, C]) d.ctl.dispose();
    resetRemoteSeq();
  });

  it('B and C link with no introduction and exchange nest/index; every desk lists all three', async () => {
    await until(() => ids(B).includes('c1') && ids(C).includes('b1'), 'B and C hold each other\'s rows');
    expect(B.engine.calls.find(([m, p]) => m === 'nest_apply_index' && p['desk'] === idOf(C))).toBeDefined();
    expect(C.engine.calls.find(([m, p]) => m === 'nest_apply_index' && p['desk'] === idOf(B))).toBeDefined();
    const all = [idOf(A), idOf(B), idOf(C)].sort();
    for (const d of [A, B, C]) expect(d.ctl.snapshot().devices.map((x) => x.id).sort()).toEqual(all);
    // B learned C's name from the gossip, before any hello could have said it.
    expect(sees(B, C)?.name).toBe('Surface');
  });

  it('restart: a new controller from the same keychain and globalState reopens every link', async () => {
    C.ctl.dispose();
    await until(() => sees(A, C)?.online === false && sees(B, C)?.online === false, 'C is offline for A and B');
    // The seq store is ONE per process, so in this harness both ends of a pair
    // write one record, and its `in` is the higher end's. On a real machine C's
    // record holds only what C accepted: model that, or C rejects A's frames as replays.
    const kg = (A.ctl as unknown as { group: { current: { kg: Uint8Array } } }).group.current.kg;
    const marks = seq.get<Record<string, { out: number; in: number }>>(SEQ_KEY, {});
    for (const peer of [A, B]) {
      const rid = await derivePairRid(kg, idOf(C), idOf(peer));
      marks[rid] = { out: marks[rid]!.out, in: 0 };
    }
    await seq.update(SEQ_KEY, { ...marks });
    const again = makeDesk('Surface', fleet, C.keep);
    C = again;
    await C.ctl.restore();
    await until(() => linked(A, C) && linked(B, C), 'the restarted C is linked to A and B');
    await until(() => ids(C).includes('b1'), 'the restarted C has B\'s rows again');
  });

  it('removal: a desk removed on A is removed on B too, B drops its link, and C stays out', async () => {
    await A.ctl.removeDevice(idOf(C));
    await until(() => sees(B, C) === undefined, 'B no longer lists C');
    expect(sees(A, C)).toBeUndefined();
    await until(() => sees(C, B)?.online === false && sees(C, A)?.online === false, 'C has no live link left');
    expect(B.keep.roster.read().removed).toEqual([idOf(C)]);
    // A and B still agree on the rest after a full hello round: C does not come back.
    await B.ctl.markMotherBase(idOf(A));
    await until(() => base(A) === idOf(A), 'the mark crossed');
    expect(A.ctl.snapshot().devices.map((x) => x.id).sort()).toEqual([idOf(A), idOf(B)].sort());
  });

  // t-t8khdv: a desk keeps its id for life (t-t7l3pa), so a removed desk that
  // is invited again comes back under the SAME id. B holds the old tombstone
  // and must let the newer admission beat it; a removal made after that
  // admission must still beat it on every desk.
  it('t-t8khdv: removed on A, invited again on A: B and C link again after the gossip; a later removal on B removes it everywhere', async () => {
    const all = () => [idOf(A), idOf(B), idOf(C)].sort();
    await A.ctl.removeDevice(idOf(C));
    await until(() => sees(B, C) === undefined, 'B no longer lists C');
    await admit(A, C);
    await until(() => linked(A, C), 'A links to the desk it invited again');
    await until(() => linked(B, C), 'B links to the desk A invited again');
    for (const d of [A, B, C]) expect(d.ctl.snapshot().devices.map((x) => x.id).sort()).toEqual(all());
    expect(B.keep.roster.read().removed).toEqual([]);
    await B.ctl.removeDevice(idOf(C));
    await until(() => sees(A, C) === undefined, 'A drops C: the removal is newer than the admission');
    await until(() => sees(C, A)?.online === false && sees(C, B)?.online === false, 'C has no live link left');
    expect(A.keep.roster.read().removed).toEqual([idOf(C)]);
  });

  it('t-t8khdv: a hello from a removed desk (one in flight at the removal) does not admit it again', async () => {
    await A.ctl.removeDevice(idOf(C));
    const late = groupHelloMessage(idOf(C), 'Surface', null, Date.now(), '');
    await (A.ctl as unknown as { onPeerMessage(p: string, m: Record<string, unknown>): Promise<void> }).onPeerMessage(idOf(C), late);
    expect(sees(A, C)).toBeUndefined();
    expect(A.keep.roster.read().removed).toEqual([idOf(C)]);
  });

  it('mother base: marked on C, it reaches A and B; a later mark on A wins everywhere; clearing gossips too', async () => {
    await C.ctl.markMotherBase(idOf(B));
    await until(() => [A, B, C].every((d) => base(d) === idOf(B)), 'every desk has B as the mother base');
    await A.ctl.markMotherBase(idOf(A));
    await until(() => [A, B, C].every((d) => base(d) === idOf(A)), 'every desk has A as the mother base');
    await B.ctl.markMotherBase(null);
    await until(() => [A, B, C].every((d) => base(d) === null), 'every desk has no mother base');
  });
});

// t-sh7cog: the mother base with NO chat open. B has no panel view and no chat
// client; its hub reads through the window's host engine (hostEngine.ts), which
// starts on the hub's first engine call. Before the fix the hub's only engine was
// the active chat's client, so B answered "Open a chat first" and tailed nothing.
describe('Nests with no chat open — the mother base reads through the host engine (t-sh7cog)', () => {
  let fleet: RelayFleet;
  let A: Desk;
  let B: Desk;
  let host: HostEngine<HostClient>;
  let spawned: Array<{ connects: number; disposed: number }>;
  const idOf = (d: Desk) => d.ctl.deviceId!;
  const online = (from: Desk, to: Desk) => from.ctl.snapshot().devices.find((d) => d.id === idOf(to))?.online === true;
  const holds = (d: Desk, desk: Desk, id: string) => ((d.engine.foreign.get(idOf(desk)) ?? []) as Array<Record<string, unknown>>).some((r) => r['id'] === id);

  beforeEach(() => {
    registerRemoteSeq(memento());
    fleet = new RelayFleet();
    A = makeDesk('MacBook', fleet);
    B = makeDesk('5090', fleet);
    spawned = [];
    const store = B.engine;
    host = new HostEngine<HostClient>({
      make: () => {
        const rec = { connects: 0, disposed: 0 };
        spawned.push(rec);
        return { connect: async () => void rec.connects++, extMethod: (m, p) => store.extMethod(m, p), dispose: () => void rec.disposed++ };
      },
      cwd: () => 'C:/mother',
      log: () => undefined,
    });
    // No chat on B, so no setChats; the window's view replaces the harness's chat view.
    attachHostNestView(B.hub, host);
    A.engine.add('a7', 'Rig retarget', 3, 'running');
    B.engine.add('b1', 'Cron sweep on the 5090', 2);
  });

  afterEach(() => {
    for (const d of [A, B]) d.ctl.dispose();
    resetRemoteSeq();
  });

  it('no engine before the hub needs one; the index syncs both ways and the tick tails A\'s live chat, through ONE host engine', async () => {
    expect(spawned).toHaveLength(0);
    await admit(A, B);
    await until(() => online(A, B) && online(B, A), 'A and B are linked');
    await until(() => holds(A, B, 'b1') && holds(B, A, 'a7'), 'the index crossed both ways with no chat on B');
    for (const d of [A, B]) await d.ctl.markMotherBase(idOf(B));
    B.ticks.shift()!.fn();
    await until(() => B.engine.sessions.get('a7')?.events.length === 3, 'B tailed the running chat');
    expect(B.engine.sessions.get('a7')!.events).toEqual(A.engine.sessions.get('a7')!.events);
    expect(B.engine.sessions.get('a7')!.owner).toBe(idOf(A));
    expect(B.status.filter((s) => /Open a chat first|did not start/.test(s))).toEqual([]);
    expect(spawned).toEqual([{ connects: 1, disposed: 0 }]);
    // Window close: the host engine goes with it.
    host.dispose();
    expect(spawned).toEqual([{ connects: 1, disposed: 1 }]);
  });
});

// t-t7lfho: the hand-over as the desk that LOSES the chat sees it. The claims:
// one release message is enough for the old owner to post "continued on <desk>"
// (no index from the new owner needed); Take back here is Continue here run on
// the other desk, and A->B->A->B keeps one chat with the right owner and no fork;
// a desk that was offline at the take-over posts it when it comes back.
describe('Hand-over (t-t7lfho) — the desk that lost the chat', () => {
  let fleet: RelayFleet;
  let A: Desk;
  let B: Desk;
  const idOf = (d: Desk) => d.ctl.deviceId!;
  const away = (d: Desk) => ((lastIndex(d) as { away?: Array<Record<string, unknown>> } | undefined)?.away ?? []);
  const indexRow = (d: Desk, id: string) => lastIndex(d)?.rows.find((r) => r['id'] === id);
  const forks = (d: Desk) => [...d.engine.sessions.keys()].filter((k) => /-(fork|rec)$/.test(k));
  const indexLog = (d: Desk, id: string, from = 0) => d.posts.slice(from).filter((m) => m['type'] === 'origami/nestIndex')
    .map((m) => ({ row: ((m['rows'] as Array<Record<string, unknown>>).find((r) => r['id'] === id) ?? null) && 'row', away: (m['away'] as unknown[] | undefined) ?? 'no away field' }));

  beforeEach(async () => {
    registerRemoteSeq(memento());
    fleet = new RelayFleet();
    A = makeDesk('Surface', fleet);
    B = makeDesk('5090', fleet);
    B.engine.add('b1', 'Agent message', 5);
    await admit(A, B);
    await until(() => ids(A).includes('b1'), 'A lists B\'s chat');
  });

  afterEach(() => {
    A.ctl.dispose();
    B.ctl.dispose();
    resetRemoteSeq();
  });

  it('recon: one release message, and nothing else, makes the old owner post the hand-over at once', async () => {
    await A.hub.openRead('b1');
    const before = B.posts.length;
    // ONLY the release frame, as A would send it: no nest/index from A follows.
    await B.hub.onPeer(idOf(A), { type: 'nest/release', sessionId: 'b1', newOwner: idOf(A), seq: 4, at: 1_700_000_000_000 });
    console.log('[recon] B posts after one release:', JSON.stringify(indexLog(B, 'b1', before)));
    expect(B.engine.sessions.get('b1')!.owner).toBe(idOf(A));
    expect(away(B)).toEqual([{ id: 'b1', desk: idOf(A), at: 1_700_000_000_000 }]);
  });

  it('A->B->A->B: Take back here is Continue here on the other desk; one chat, the right owner each step, no fork', async () => {
    const steps: Array<[Desk, Desk]> = [[A, B], [B, A], [A, B], [B, A]];
    for (const [taker, loser] of steps) {
      const from = loser.posts.length;
      await until(() => taker.hub.rows().some((r) => r.id === 'b1'), `${taker.hub.deviceId()} lists b1 in its Nest`);
      const r = await taker.hub.continueHere('b1');
      expect(r).toEqual({ result: 'taken', newId: 'b1' });
      await until(() => loser.engine.sessions.get('b1')!.owner === idOf(taker), 'the loser released');
      await until(() => indexRow(loser, 'b1')?.['owner'] === idOf(taker), 'the loser lists b1 as the taker\'s');
      console.log('[recon] loser index posts:', JSON.stringify(indexLog(loser, 'b1', from)));
      // The loser's pane learns it from its own post: the chat, the new desk.
      await until(() => away(loser).some((w) => w['id'] === 'b1' && w['desk'] === idOf(taker)), 'the loser posts the hand-over');
      expect(away(taker).some((w) => w['id'] === 'b1')).toBe(false);
      expect(taker.engine.sessions.get('b1')!.owner).toBe(idOf(taker));
      expect(taker.opened.at(-1)).toBe('b1');
    }
    expect([...forks(A), ...forks(B)]).toEqual([]);
    expect([...A.engine.sessions.keys()].filter((k) => k.startsWith('b1'))).toEqual(['b1']);
    expect([...B.engine.sessions.keys()].filter((k) => k.startsWith('b1'))).toEqual(['b1']);
  });

  it('offline at the take-over: the old owner posts the hand-over when it comes back, before any prompt', async () => {
    const a = idOf(A);
    const b = idOf(B);
    const kg = (A.ctl as unknown as { group: { current: { kg: Uint8Array } } }).group.current.kg;
    const relay = fleet.relay(await derivePairRid(kg, a, b));
    await A.hub.openRead('b1');
    B.hold.on = true;
    if (pairRole(b, a) === ROLE_DESKTOP) relay.dropDesktop();
    else relay.dropPhone();
    await until(() => lastIndex(A)!.desks.find((d) => d['id'] === b)?.['online'] === false, 'desk B is offline');
    await A.hub.continueHere('b1');
    expect(away(B)).toEqual([]);
    B.hold.on = false;
    for (const fn of B.hold.queued.splice(0)) fn();
    await until(() => away(B).some((w) => w['id'] === 'b1' && w['desk'] === a), 'B posts the hand-over after it reconnects');
    expect(B.engine.calls.filter(([m]) => m === 'nest_release')).toHaveLength(1);
  });
});

describe('the phone never speaks the nest verbs', () => {
  it('all four group verbs and the read-only open are named refusals', () => {
    for (const v of [...NEST_GROUP_VERBS, 'nestOpenRead', 'nestContinue']) expect(NAMED_REFUSALS).toContain(v);
  });
});
