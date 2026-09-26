// t-selspn (Nests L6) — the tail's rules, one real bug each:
//
// - a burst of 20 live chats never pulls more than the per-run bound, and the
//   minute window keeps the tail inside the relay's live lane (a bound that
//   only held per run would pass here and still flood the lane at 2 runs/s);
// - the newest chat is pulled first (lastAt order), and a chat cut off by the
//   budget resumes from what it holds, not from -1;
// - the pull source is the online desk with the HIGHEST seq of the same
//   writer's copy (an owner-first rule sends the pull to a desk that lacks it);
// - a new chat or a retitle sends the index within 2 s, once per burst, and
//   the 30 s tick stays armed;
// - the Nests view draws the tail per desk, and the rail shows a dot while a
//   tail runs (state + CSS source: jsdom has no layout).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestTail, TAIL_MINUTE_BYTES, TAIL_RUN_BYTES, localChange, tailQueue, type TailHost } from '../../../src/dashboard/nestTail';
import { pullSource } from '../../../src/dashboard/nestPull';
import { NEST_SYNC_MS, NEST_TOUCH_MS, NestHub } from '../../../src/dashboard/nestHub';
import type { NestExportResult, NestIndexRow } from '../../../src/dashboard/nestContract';
import type { GroupDeviceView } from '../../../src/remote/groupSnapshot';
import { readTail, tailLine } from '../components/nestsStatus';
import BoardRail from '../panes/BoardRail.svelte';
import NestDeskTile from '../components/NestDeskTile.svelte';
import { VIEWS } from '../panes/boardViews';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8');

const SELF = 'deskBBBBBBB';
const OWNER = 'deskAAAAAAA';
const desk = (id: string, over: Partial<GroupDeviceView> = {}): GroupDeviceView => ({
  id, name: id, self: id === SELF, online: true, motherBase: false, os: 'windows', lastSeen: 0, ...over,
});
const row = (id: string, over: Partial<NestIndexRow> = {}): NestIndexRow => ({
  id, title: id, desk: OWNER, deskName: 'MacBook', state: 'running', owner: OWNER, lastAt: 1_000, size: 0, seq: 24, ...over,
});

/** A mother base whose peer holds `chats` chats of 25 events of ~4 KB each. */
function fakeTail(chats: NestIndexRow[]) {
  const store = new Map<string, number>();
  const requests: Array<{ id: string; after: number }> = [];
  let wire = 0;
  let clock = 0;
  const host: TailHost = {
    deviceId: () => SELF,
    devices: () => [desk(SELF, { motherBase: true }), desk(OWNER)],
    others: chats,
    mine: [],
    changed: () => undefined,
    touch: () => undefined,
    async call<T>(method: string, p: Record<string, unknown> = {}): Promise<T> {
      const c = p['chunk'] as { sessionId: string; to: number; last: number; events: unknown[] };
      const have = store.get(c.sessionId) ?? -1;
      if (method !== 'nest_import') throw new Error(method);
      if (c.events.length) store.set(c.sessionId, c.to);
      const now = store.get(c.sessionId) ?? -1;
      return { sessionId: c.sessionId, have: now, applied: now - have, done: now >= c.last } as T;
    },
    async request(_peer: string, id: string, after: number): Promise<NestExportResult> {
      requests.push({ id, after });
      const events = [];
      for (let seq = after + 1; seq <= 24 && events.length < 6; seq++)
        events.push({ id: `${id}-${seq}`, aggregateID: id, seq, type: 'message.part.updated.1', data: { text: 'x'.repeat(4_000) } });
      const to = events.length ? events[events.length - 1]!.seq : after;
      const chunk = { sessionId: id, owner: OWNER, from: after + 1, to, last: 24, done: to >= 24, events };
      wire += new TextEncoder().encode(JSON.stringify(chunk)).length;
      return chunk;
    },
  };
  const tail = new NestTail(host, () => clock);
  return { tail, store, requests, bytes: () => wire, advance: (ms: number) => (clock += ms) };
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('tail budget and order (acceptance 3)', () => {
  const burst = Array.from({ length: 20 }, (_, i) => row(`c${String(i).padStart(2, '0')}`, { lastAt: 1_000 + ((i * 7) % 20) }));

  it('a burst of 20 chats stays inside the per-run bound, newest lastAt first, and the next run resumes from `have`', async () => {
    const t = fakeTail(burst);
    await t.tail.run();
    const first = t.bytes();
    expect(first).toBeGreaterThan(TAIL_RUN_BYTES / 2);
    expect(first).toBeLessThanOrEqual(TAIL_RUN_BYTES);
    const order = [...new Set(t.requests.map((r) => r.id))];
    const newest = [...burst].sort((x, y) => y.lastAt - x.lastAt).map((r) => r.id);
    expect(order).toEqual(newest.slice(0, order.length));
    // The last chat the budget reached stopped short; the next run asks from what it holds.
    const cut = order[order.length - 1]!;
    const held = t.store.get(cut)!;
    expect(held).toBeLessThan(24);
    t.advance(1_000);
    const seen = t.requests.length;
    await t.tail.run();
    expect(t.requests.slice(seen).find((r) => r.id === cut)).toEqual({ id: cut, after: held });
  });

  it('the minute window caps the tail at half the 2 MiB/min lane, and opens again after 60 s', async () => {
    const t = fakeTail(burst);
    for (let i = 0; i < 4; i++) { await t.tail.run(); t.advance(5_000); }
    expect(t.bytes()).toBeLessThanOrEqual(TAIL_MINUTE_BYTES);
    const stalled = t.requests.length;
    await t.tail.run();
    expect(t.requests.length).toBe(stalled);
    t.advance(60_000);
    await t.tail.run();
    expect(t.requests.length).toBeGreaterThan(stalled);
  });

  it('only the mother base tails; closed chats only when they changed since the last look or a copy is held', async () => {
    const off = fakeTail([row('a')]);
    (off.tail as unknown as { host: TailHost }).host.devices = () => [desk(SELF), desk(OWNER, { motherBase: true })];
    await off.tail.run();
    expect(off.requests).toEqual([]);
    const host = { deviceId: () => SELF, devices: () => [desk(SELF, { motherBase: true }), desk(OWNER)], mine: [] as NestIndexRow[], others: [row('old', { state: 'closed' }), row('live', { state: 'open' })] };
    expect(tailQueue(host, new Map()).map((r) => r.id)).toEqual(['live']);
    expect(tailQueue(host, new Map([['old', 20]])).map((r) => r.id).sort()).toEqual(['live', 'old']);
    expect(tailQueue({ ...host, mine: [row('old', { desk: SELF, seq: 3 })] }, new Map()).map((r) => r.id).sort()).toEqual(['live', 'old']);
    // A chat this desk writes (it took it over) is never tailed.
    expect(tailQueue({ ...host, mine: [row('live', { desk: SELF, owner: SELF })] }, new Map()).map((r) => r.id)).toEqual([]);
  });
});

describe('pull source: the online desk with the highest seq (acceptance 2)', () => {
  const desks = [desk('me'), desk(OWNER), desk('home', { motherBase: true }), desk('other')];
  it('owner shut: the mother base copy at seq 9 wins over another desk at seq 4', () => {
    const rows = [row('s', { desk: OWNER, seq: 12 }), row('s', { desk: 'home', seq: 9 }), row('s', { desk: 'other', seq: 4 })];
    const shut = desks.map((d) => (d.id === OWNER ? { ...d, online: false } : d));
    expect(pullSource(rows, shut, 's', OWNER, 'me')).toBe('home');
    expect(pullSource(rows, desks, 's', OWNER, 'me')).toBe(OWNER);
    // A higher seq on a non-home desk wins; a copy under another writer never serves.
    expect(pullSource([...rows, row('s', { desk: 'other', seq: 11 })], shut, 's', OWNER, 'me')).toBe('other');
    expect(pullSource([row('s', { desk: 'other', seq: 50, owner: 'other' })], shut, 's', OWNER, 'me')).toBeNull();
  });
});

describe('local changes send the index within 2 s (acceptance 4)', () => {
  it('a new chat or a retitle arms one send at NEST_TOUCH_MS; other posts do not; the 30 s tick stays', async () => {
    vi.useFakeTimers();
    const sent: Array<Record<string, unknown>> = [];
    const delays: number[] = [];
    const hub = new NestHub({
      enabled: () => true,
      setTimer: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms); },
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    hub.attachGroup({ deviceId: () => SELF, deskName: '5090', devices: () => [desk(SELF), desk(OWNER)], send: (_p, m) => void sent.push(m) });
    hub.attachView({ engine: () => ({ extMethod: async () => ({ rows: [row('new', { desk: SELF, owner: SELF })], others: [] }) }), post: () => undefined, open: () => undefined });
    expect(delays).toEqual([NEST_SYNC_MS]);
    expect(localChange({ type: 'modelStatus' })).toBe(false);
    hub.onLocalPost({ type: 'modelStatus' });
    hub.onLocalPost({ type: 'sessionCreated' });
    hub.onLocalPost({ type: 'sessionTitle' });
    expect(delays).toEqual([NEST_SYNC_MS, NEST_TOUCH_MS]);
    expect(NEST_TOUCH_MS).toBeLessThanOrEqual(2_000);
    await vi.advanceTimersByTimeAsync(NEST_TOUCH_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // t-sj39jx: the artifact index rides the same send.
    expect(sent.map((m) => m['type'])).toEqual(['nest/index', 'nest/artifact-index']);
    // The next change after the send arms a new one.
    hub.onLocalPost({ type: 'turnDone' });
    await vi.advanceTimersByTimeAsync(NEST_TOUCH_MS);
    expect(sent).toHaveLength(4);
    hub.attachGroup(null);
  });

  it('the panel post path calls the hook (the only place every session event passes)', () => {
    expect(read('src/dashboard/DashboardPanel.ts')).toMatch(/noteTodoSnapshot\(this\.sessions, msg\); nestHub\.onLocalPost\(cs\);/);
  });
});

describe('two pulls of one chat from one desk at once (the tail and a click)', () => {
  it('one nest/chunk answers both waiters; neither hangs until the timeout', async () => {
    const hub = new NestHub({ enabled: () => true, setTimer: (fn, ms) => setTimeout(fn, ms === NEST_SYNC_MS ? 1e9 : 200), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
    const asked: Array<Record<string, unknown>> = [];
    hub.attachGroup({ deviceId: () => SELF, deskName: '5090', devices: () => [desk(SELF), desk(OWNER)], send: (_p, m) => void asked.push(m) });
    hub.attachView({ engine: () => ({ extMethod: async () => ({}) }), post: () => undefined, open: () => undefined });
    const tailPull = hub.request(OWNER, 's1', 3);
    const clickPull = hub.request(OWNER, 's1', 3);
    expect(asked.map((m) => m['type'])).toEqual(['nest/export-request', 'nest/export-request']);
    const chunk = { sessionId: 's1', owner: OWNER, from: 4, to: 5, last: 5, done: true, events: [] };
    await hub.onPeer(OWNER, { type: 'nest/chunk', chunk });
    await expect(Promise.all([tailPull, clickPull])).resolves.toEqual([chunk, chunk]);
    hub.attachGroup(null);
  });
});

describe('the Nests view draws the tail (acceptance 5)', () => {
  it('reads the wire and says it per desk', () => {
    const t = readTail({ running: true, desks: { [OWNER]: { tailed: 3, behind: 1 }, bad: { tailed: 'x' } } });
    expect(t).toEqual({ running: true, desks: { [OWNER]: { tailed: 3, behind: 1 } } });
    expect(readTail(null)).toBeNull();
    expect(tailLine(t!.desks[OWNER])).toBe('tailed: 3 chats, behind by 1');
    expect(tailLine({ tailed: 1, behind: 0 })).toBe('tailed: 1 chat, up to date');
    expect(tailLine(undefined)).toBe('');
  });

  it('a desk tile shows its tail line; without one it shows none', async () => {
    const d = { id: OWNER, name: 'MacBook', self: false, online: true, motherBase: false, os: 'macos' as const, lastSeen: 0 };
    const noop = () => undefined;
    const { container, unmount } = render(NestDeskTile, { desk: d, now: 0, onRename: noop, onHome: noop, onRemove: noop, tail: 'tailed: 2 chats, behind by 1' });
    expect(container.querySelector('[data-tail]')?.textContent).toContain('tailed: 2 chats, behind by 1');
    // t-vikozs: the separator kept its trailing space but lost the leading one ("ago· tailed").
    expect(container.querySelector('.ell')?.textContent).toMatch(/\S · tailed: 2 chats/);
    unmount();
    const bare = render(NestDeskTile, { desk: d, now: 0, onRename: noop, onHome: noop, onRemove: noop });
    expect(bare.container.querySelector('[data-tail]')).toBeNull();
  });

  it('the rail shows a dot on Nests while a tail runs, and drops it when it ends', async () => {
    const { container } = render(BoardRail, { views: VIEWS, active: 'flock', onSelect: () => undefined });
    const dot = () => container.querySelector('[data-view-id="nests"] [data-tailing]');
    expect(dot()).toBeNull();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'origami/nestIndex', rows: [], desks: [], tail: { running: true, desks: {} } } }));
    await tick();
    expect(dot()).not.toBeNull();
    expect(container.querySelectorAll('[data-tailing]')).toHaveLength(1);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'origami/nestIndex', rows: [], desks: [], tail: { running: false, desks: {} } } }));
    await tick();
    expect(dot()).toBeNull();
  });

  it('CSS source: the dot is a theme token on a positioned rail button; the tile and pane pass the tail through', () => {
    const rail = read('webview/dashboard/panes/BoardRail.svelte');
    expect(rail).toMatch(/\.sync-dot \{[^}]*position: absolute;[^}]*background: var\(--og-success\);/);
    expect(rail).toMatch(/\.nav-btn \{\s*position: relative;/);
    expect(read('webview/dashboard/components/NestDesks.svelte')).toMatch(/tail=\{desk\.self \? '' : tailLine\(tail\?\.desks\[desk\.id\]\)\}/);
    expect(read('webview/dashboard/panes/NestsPane.svelte')).toMatch(/msg\.type === 'origami\/nestIndex' \|\| msg\.type === 'groupData'\) tail = readTail\(msg\.tail\)/);
  });
});
