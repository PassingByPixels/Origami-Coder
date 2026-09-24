// t-sj39jx — artifacts in the nest, end to end: TWO desks, ONE process.
//
// Real: both GroupControllers (keychains, derivation, sealed frames), the frame
// chunker, the two NestHubs with their NestArtifacts, and the Artifacts pane's
// host module (artifactsPane.ts). Faked: the relay (LoopbackRelay, the same one
// nestsWiring.test.ts uses) and each desk's ENGINE, by FakeArtifactEngine
// below, which answers nest_artifact_* in the reply shapes of
// packages/engine/src/artifact/nest-sync.ts (proved against a real store in
// packages/engine/test/artifact/nest-sync.test.ts). The harness helpers are
// copied from nestsWiring.test.ts rather than imported: a test file cannot be
// imported without running its suites.
//
// The claims: desk A publishes, desk B lists it with A's chip and opens v1 (the
// binary body crosses in pieces); A publishes v2, B sees v2 and opens it, and
// only the changed file crosses. With Nests off on B nothing is read and the
// pane's list is what the engine said.
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopbackRelay, settle } from './remoteLoopback';
import { GroupController } from '../../../src/remote/groupController';
import { GroupRosterStore } from '../../../src/remote/groupMembers';
import { registerRemoteSeq, resetRemoteSeq } from '../../../src/remote/seqStore';
import type { SecretStore } from '../../../src/remote/pairing';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';
import { NEST_SYNC_MS, NestHub } from '../../../src/dashboard/nestHub';
import { handleArtifactsPaneMessage, type ArtifactsPaneHost, type NestArtifactSource } from '../../../src/dashboard/artifactsPane';

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
  public connect = (url: string): RemoteSocket => {
    const rid = decodeURIComponent(/\/r\/([^?]+)/.exec(url)?.[1] ?? '');
    let found = this.byRid.get(rid);
    if (!found) this.byRid.set(rid, (found = new LoopbackRelay()));
    return found.connect(url) as unknown as RemoteSocket;
  };
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Entry = { path: string; size: number; sha256: string; mediaType: string };
type Art = { id: string; title: string; owner: string | null; updated: number; versions: Map<number, { digest: string; entries: Entry[]; token: string }> };

/** One desk's engine: the artifact store and the nest_artifact_* methods, in the engine's shapes. */
class FakeArtifactEngine {
  public readonly arts = new Map<string, Art>();
  public readonly blobs = new Map<string, Uint8Array>();
  private readonly parts = new Map<string, Uint8Array>();
  private readonly foreign = new Map<string, unknown[]>();
  public readonly calls: Array<[string, Record<string, unknown>]> = [];

  public publish(id: string | undefined, title: string, files: Array<{ path: string; bytes: Uint8Array }>): { id: string; version: number } {
    const entries = files.map((f) => ({ path: f.path, size: f.bytes.length, sha256: sha(f.bytes), mediaType: 'text/html' })).sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const f of files) this.blobs.set(sha(f.bytes), f.bytes);
    const art = id ? this.arts.get(id)! : { id: `art_${randomBytes(12).toString('hex')}`, title, owner: null, updated: 0, versions: new Map() };
    const version = art.versions.size ? Math.max(...art.versions.keys()) + 1 : 1;
    art.versions.set(version, { digest: sha(new TextEncoder().encode(JSON.stringify(entries))), entries, token: `tok-${art.id}-${version}` });
    Object.assign(art, { owner: null, updated: 1_000 + version });
    this.arts.set(art.id, art);
    return { id: art.id, version };
  }

  public extMethod = async (method: string, p: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    this.calls.push([method, p]);
    if (method.startsWith('nest_') && p['enabled'] !== true) throw Object.assign(new Error(`${method} refused: Nests is off on this desk`), { code: -32602 });
    const self = String(p['deviceId']);
    const latest = (a: Art) => Math.max(...a.versions.keys());
    switch (method) {
      case 'nest_index': return { rows: [], others: [] };
      case 'nest_apply_index': return {};
      case 'nest_artifact_index': {
        const rows = [...this.arts.values()].map((a) => ({
          id: a.id, title: a.title, version: latest(a), digest: a.versions.get(latest(a))!.digest, desk: self,
          deskName: String(p['deskName']), owner: a.owner ?? self, updated: a.updated, size: 0,
        }));
        return { rows, others: [...this.foreign.values()].flat() };
      }
      case 'nest_artifact_apply':
        this.foreign.set(String(p['desk']), (p['rows'] as Array<Record<string, unknown>>).filter((r) => r['desk'] === p['desk']));
        return { inserted: 1 };
      case 'nest_artifact_export': {
        const a = this.arts.get(String(p['artifactId']));
        const v = a?.versions.get(Number(p['version']));
        if (!a || !v) return { refused: 'not-found' };
        if (p['sha256'] === undefined)
          return { kind: 'manifest', artifactId: a.id, version: Number(p['version']), title: a.title, owner: a.owner ?? self, digest: v.digest, created: 1, entries: v.entries };
        const body = this.blobs.get(String(p['sha256']))!;
        const offset = Number(p['offset']);
        const piece = body.subarray(offset, offset + Number(p['maxBytes']));
        return { kind: 'blob', artifactId: a.id, version: Number(p['version']), sha256: p['sha256'], offset, size: body.length, data: Buffer.from(piece).toString('base64'), done: offset + piece.length >= body.length };
      }
      case 'nest_artifact_import': {
        const c = p['chunk'] as Record<string, unknown>;
        if (c['kind'] === 'blob') {
          const s = String(c['sha256']);
          const have = this.parts.get(s) ?? new Uint8Array(0);
          if (c['offset'] !== have.length) return { sha256: s, have: have.length, done: false, refused: 'gap' };
          const next = new Uint8Array([...have, ...Buffer.from(String(c['data']), 'base64')]);
          if (next.length < Number(c['size'])) { this.parts.set(s, next); return { sha256: s, have: next.length, done: false }; }
          this.parts.delete(s);
          if (sha(next) !== s) return { sha256: s, have: 0, done: false, refused: 'hash' };
          this.blobs.set(s, next);
          return { sha256: s, have: next.length, done: true };
        }
        const entries = c['entries'] as Entry[];
        const missing = entries.filter((e) => !this.blobs.has(e.sha256)).map((e) => ({ sha256: e.sha256, size: e.size, have: this.parts.get(e.sha256)?.length ?? 0 }));
        const id = String(c['artifactId']);
        const version = Number(c['version']);
        if (missing.length) return { result: 'missing', artifactId: id, version, missing };
        const art = this.arts.get(id) ?? { id, title: String(c['title']), owner: String(c['owner']), updated: 0, versions: new Map() };
        if (art.versions.get(version)?.digest === c['digest']) return { result: 'unchanged', artifactId: id, version };
        art.versions.set(version, { digest: String(c['digest']), entries, token: `tok-${id}-${version}-here` });
        Object.assign(art, { owner: String(c['owner']), updated: 2_000 + version });
        this.arts.set(id, art);
        return { result: 'added', artifactId: id, version };
      }
      case 'artifact_list':
        return {
          artifacts: [...this.arts.values()].map((a) => ({ id: a.id, title: a.title, latest: latest(a), updated: a.updated, ownerDevice: a.owner ?? 'this machine', here: true, unopened: false })),
          homeDevice: 'this machine',
        };
      case 'artifact_open': {
        const a = this.arts.get(String(p['artifactId']));
        if (!a) throw new Error(`no artifact ${p['artifactId']}`);
        const v = a.versions.get(typeof p['version'] === 'number' ? p['version'] : latest(a))!;
        return { url: `http://127.0.0.1:4096/artifact/${v.token}/index.html` };
      }
    }
    throw Object.assign(new Error('Method not found'), { code: -32601 });
  };
}

interface Desk {
  ctl: GroupController;
  hub: NestHub;
  engine: FakeArtifactEngine;
  posts: Array<Record<string, unknown>>;
  on: { nests: boolean };
}

function makeDesk(name: string, fleet: RelayFleet): Desk {
  const on = { nests: true };
  const hub = new NestHub({
    enabled: () => on.nests,
    // The 30 s tick is never fired here; the 2 s touch runs in 60 ms; a 20 s answer wait
    // runs in 2 s, long enough for a sealed round trip on a loaded test machine.
    setTimer: (fn, ms) => (ms === NEST_SYNC_MS ? 0 : setTimeout(fn, ms >= 20_000 ? 2_000 : 60)),
    clearTimer: (h) => { if (typeof h !== 'number') clearTimeout(h as ReturnType<typeof setTimeout>); },
  });
  const deps: TransportDeps = { connect: fleet.connect, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const ctl = new GroupController({
    config: () => ({ enabled: true, relayUrl: RELAY }), secrets: secrets(), deps, deviceName: name,
    roster: new GroupRosterStore(memento()),
    onChange: () => hub.onGroupChange(),
    onPeerMessage: (peer, msg) => void hub.onPeer(peer, msg),
  });
  const engine = new FakeArtifactEngine();
  const posts: Array<Record<string, unknown>> = [];
  hub.attachGroup({ deviceId: () => ctl.deviceId, deskName: name, devices: () => ctl.snapshot().devices, send: (p, m) => ctl.send(p, m) });
  hub.attachView({ engine: () => engine, post: (m) => void posts.push(m), open: () => undefined });
  return { ctl, hub, engine, posts, on };
}

// t-tbyb2c: same fix as nestsWiring.test.ts — a Date.now() deadline reads as
// "failed" under CPU contention alone. Bound the poll by attempts instead;
// vitest's own test timeout (raised below) is the backstop against a
// genuinely stuck test.
const UNTIL_ATTEMPTS = 4_000;
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < UNTIL_ATTEMPTS && !cond(); i++) await settle(2);
  expect(cond(), what).toBe(true);
}

/** The Artifacts pane's host, on desk `d`: what it posts and what it opens. */
function pane(d: Desk, nest: NestArtifactSource | null = d.hub.artifacts) {
  const out: Array<Record<string, unknown>> = [];
  const opened: string[] = [];
  const host: ArtifactsPaneHost = { client: d.engine, post: (m) => void out.push(m), openUrl: (url) => void opened.push(url), ...(nest ? { nest } : {}) };
  const list = async () => {
    await handleArtifactsPaneMessage(host, { type: 'artifactsRequest' });
    return [...out].reverse().find((m) => m['type'] === 'artifactsData')!['artifacts'] as Array<Record<string, unknown>>;
  };
  const open = async (artifactId: string) => {
    await handleArtifactsPaneMessage(host, { type: 'artifactOpen', artifactId });
    return [...out].reverse().find((m) => m['type'] === 'artifactOpened')!;
  };
  return { out, opened, list, open };
}

const html = (text: string) => new TextEncoder().encode(`<!doctype html><h1>${text}</h1>`);
/** 60 KB of every byte value: three 24 KB pieces, NUL and 0xFF included. */
const PNG = Uint8Array.from({ length: 60_000 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);

describe('Artifacts in the nest — two desks over a loopback relay (t-sj39jx)', () => {
  let fleet: RelayFleet;
  let A: Desk;
  let B: Desk;
  const online = (from: Desk, to: Desk) => from.hub.devices().some((d) => d.id === to.ctl.deviceId && d.online);

  beforeEach(async () => {
    registerRemoteSeq(memento());
    fleet = new RelayFleet();
    A = makeDesk('Surface', fleet);
    B = makeDesk('5090', fleet);
    // t-sj32zl: the inviting desk's owner must Accept before the group key travels.
    await B.ctl.join((await A.ctl.invite()).key);
    await until(() => A.ctl.snapshot().joinCheck?.side === 'inviter', 'A shows the join request');
    await A.ctl.answerJoin(true);
    await until(() => online(A, B) && online(B, A), 'A and B are linked');
  });

  afterEach(() => {
    A.ctl.dispose();
    B.ctl.dispose();
    resetRemoteSeq();
  });

  it('A publishes v1: B lists it with A\'s chip and opens it; A publishes v2: B sees v2 and only the changed file crosses', async () => {
    const { id } = A.engine.publish(undefined, 'Terrain dashboard', [{ path: 'index.html', bytes: html('v1') }, { path: 'img/logo.png', bytes: PNG }]);
    A.hub.touch(); // what DashboardPanel's onArtifactsChanged does after a publish
    await until(() => B.hub.artifacts.others.some((r) => r.id === id), 'B holds A\'s index row');
    expect(B.posts).toContainEqual({ type: 'origami/nestArtifacts' });

    const b = pane(B);
    const [row] = await b.list();
    expect(row).toMatchObject({ id, title: 'Terrain dashboard', latest: 1, here: false, ownerDevice: 'Surface', desk: { id: A.ctl.deviceId, name: 'Surface', online: true } });
    expect(B.engine.arts.has(id)).toBe(false);

    expect(await b.open(id)).toMatchObject({ artifactId: id, url: `http://127.0.0.1:4096/artifact/tok-${id}-1-here/index.html` });
    expect(b.opened).toEqual([`http://127.0.0.1:4096/artifact/tok-${id}-1-here/index.html`]);
    expect(B.engine.blobs.get(sha(PNG))).toEqual(PNG);
    const pieces = (d: Desk) => d.engine.calls.filter(([m, p]) => m === 'nest_artifact_export' && p['sha256'] !== undefined).map(([, p]) => [String(p['sha256']).slice(0, 6), p['offset']]);
    expect(pieces(A).map(String).sort()).toEqual([[sha(html('v1')).slice(0, 6), 0], [sha(PNG).slice(0, 6), 0], [sha(PNG).slice(0, 6), 24_000], [sha(PNG).slice(0, 6), 48_000]].map(String).sort());
    // Held here now: the row is local, still with A's chip (A owns it), and a second Open pulls nothing.
    expect((await b.list())[0]).toMatchObject({ id, latest: 1, here: true, ownerDevice: 'Surface', desk: { id: A.ctl.deviceId } });
    const before = A.engine.calls.length;
    await b.open(id);
    expect(A.engine.calls.slice(before).some(([m]) => m === 'nest_artifact_export')).toBe(false);

    A.engine.publish(id, 'Terrain dashboard', [{ path: 'index.html', bytes: html('v2') }, { path: 'img/logo.png', bytes: PNG }]);
    A.hub.touch();
    await until(() => B.hub.artifacts.others.some((r) => r.id === id && r.version === 2), 'B holds the v2 row');
    expect((await b.list())[0]).toMatchObject({ id, latest: 2, here: false, desk: { id: A.ctl.deviceId } });
    const mark = A.engine.calls.length;
    expect(await b.open(id)).toMatchObject({ url: `http://127.0.0.1:4096/artifact/tok-${id}-2-here/index.html` });
    const v2pieces = A.engine.calls.slice(mark).filter(([m, p]) => m === 'nest_artifact_export' && p['sha256'] !== undefined);
    expect(v2pieces.map(([, p]) => p['sha256'])).toEqual([sha(html('v2'))]);
    expect([...B.engine.arts.get(id)!.versions.keys()]).toEqual([1, 2]);
  });

  it('Nests off on B: B reads no artifact index, sends none, and its pane lists exactly what its engine listed', async () => {
    const mine = B.engine.publish(undefined, 'Local only', [{ path: 'index.html', bytes: html('here') }]);
    // While B is on it learns of one of A's artifacts; then Nests goes off on B.
    const first = A.engine.publish(undefined, 'From A', [{ path: 'index.html', bytes: html('a') }]);
    A.hub.touch();
    await until(() => B.hub.artifacts.others.some((r) => r.id === first.id), 'B held the row from A while on');
    await settle(20);
    B.on.nests = false;
    B.engine.calls.length = 0;
    A.engine.calls.length = 0;
    A.engine.publish(undefined, 'Also from A', [{ path: 'index.html', bytes: html('a2') }]);
    A.hub.touch();
    B.hub.touch();
    await settle(40);
    expect(B.engine.calls.filter(([m]) => m.startsWith('nest_'))).toEqual([]);
    expect(A.engine.calls.some(([m, p]) => m === 'nest_artifact_apply' && p['desk'] === B.ctl.deviceId)).toBe(false);
    const withNest = await pane(B).list();
    const plain = await pane(B, null).list();
    expect(withNest).toEqual(plain);
    expect(withNest).toEqual([{ id: mine.id, title: 'Local only', latest: 1, updated: 1_001, ownerDevice: 'this machine', here: true, unopened: false }]);
    // Open on A's artifact pulls nothing: the engine says it has no such artifact.
    expect(await pane(B).open(first.id)).toMatchObject({ error: `no artifact ${first.id}` });
    expect(B.engine.calls.filter(([m]) => m.startsWith('nest_'))).toEqual([]);
  });
});
