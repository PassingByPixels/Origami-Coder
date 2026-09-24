// t-sj39jx — the rules under artifacts in the nest, without a relay: the row
// mirror of the engine, which copy the pane shows, which desk a pull asks, and
// the per-minute byte bound. The two-desk wiring is nestArtifactsWiring.test.ts.
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import ArtifactsPane from '../panes/ArtifactsPane.svelte';
import { deviceLabel } from '../panes/artifactRows';
import { handleArtifactsPaneMessage } from '../../../src/dashboard/artifactsPane';
import type { GroupDeviceView } from '../../../src/remote/groupSnapshot';
import { artifactSource, mergeNestArtifacts, NEST_ARTIFACT_ROW_FIELDS, type NestArtifactRow } from '../../../src/dashboard/nestArtifactRows';
import { ARTIFACT_MINUTE_BYTES, ARTIFACT_WAIT_MS, NestArtifacts } from '../../../src/dashboard/nestArtifacts';
import type { NestArtifactMessage } from '../../../src/remote/nestArtifactWire';
import { NEST_GROUP_VERBS } from '../../../src/remote/nestWire';

const here = nodePath.dirname(fileURLToPath(import.meta.url));

const desk = (id: string, name: string, extra: Partial<GroupDeviceView> = {}): GroupDeviceView =>
  ({ id, name, self: false, online: true, motherBase: false, os: 'win32', lastSeen: 5, ...extra }) as GroupDeviceView;
const row = (id: string, version: number, holder: string, owner = holder, extra: Partial<NestArtifactRow> = {}): NestArtifactRow =>
  ({ id, title: `T ${id}`, version, digest: 'd'.repeat(64), desk: holder, deskName: holder.toUpperCase(), owner, updated: 10 + version, size: 1, ...extra });

describe('the index row mirror', () => {
  it('the host reads the same row fields the engine writes', () => {
    const engine = readFileSync(nodePath.resolve(here, '../../../../engine/src/artifact/nest-sync.ts'), 'utf8');
    const m = /export const ROW_FIELDS = \[([^\]]+)\]/.exec(engine);
    expect(m, 'ROW_FIELDS not found in nest-sync.ts').not.toBeNull();
    const fields = [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(fields).toEqual([...NEST_ARTIFACT_ROW_FIELDS]);
  });

  it('the three artifact verbs are desk-to-desk verbs the phone is refused', () => {
    for (const v of ['nest/artifact-index', 'nest/artifact-request', 'nest/artifact-chunk']) expect(NEST_GROUP_VERBS).toContain(v);
  });
});

describe('mergeNestArtifacts', () => {
  const self = 'deskSELF000';
  const desks = [desk(self, 'Here', { self: true }), desk('deskAAAAAAA', 'Surface'), desk('deskBBBBBBB', '5090', { motherBase: true })];

  it('a row this desk made is returned as the engine listed it', () => {
    const mine = { id: 'art_1', title: 'Mine', latest: 2, ownerDevice: 'this machine', here: true };
    const out = mergeNestArtifacts([mine], [row('art_1', 2, 'deskAAAAAAA', self)], desks, self);
    expect(out[0]).toBe(mine);
  });

  it('an artifact only another desk holds is listed, not here, with its OWNER desk as the chip', () => {
    const out = mergeNestArtifacts([], [row('art_2', 3, 'deskBBBBBBB', 'deskAAAAAAA')], desks, self);
    expect(out).toEqual([{
      id: 'art_2', title: 'T art_2', updated: 13, latest: 3, here: false, unopened: true, ownerDevice: 'Surface',
      desk: { id: 'deskAAAAAAA', name: 'Surface', os: 'win32', online: true, lastSeen: 5, motherBase: false },
    }]);
  });

  it('a newer version on another desk replaces the local row\'s version and marks it not here; an older one does not', () => {
    const local = { id: 'art_3', title: 'Pulled', latest: 1, ownerDevice: 'deskAAAAAAA', here: true };
    expect(mergeNestArtifacts([local], [row('art_3', 2, 'deskAAAAAAA')], desks, self)[0]).toMatchObject({ latest: 2, here: false, desk: { id: 'deskAAAAAAA' } });
    // Held here at v1 and v1 is all the nest has: local, with the owner's name and chip instead of its device id.
    expect(mergeNestArtifacts([local], [row('art_3', 1, 'deskAAAAAAA')], desks, self)[0]).toEqual({ ...local, ownerDevice: 'Surface', desk: expect.objectContaining({ id: 'deskAAAAAAA' }) });
  });

  it('this desk\'s own rows echoed back by a peer are ignored', () => {
    expect(mergeNestArtifacts([], [row('art_4', 1, self)], desks, self)).toEqual([]);
  });

  // t-v7i2au: a pull back of this desk's own artifact writes THIS desk's id as its
  // owner (nest-sync importManifest). The row reads as this machine's, never the id.
  const label = (r: Record<string, unknown> | undefined) => deviceLabel(r?.['ownerDevice'] as string | undefined, 'this machine');
  it('a local row owned by this desk\'s own id reads as this machine, with no desk chip', () => {
    const local = { id: 'art_6', title: 'Mine, pulled back', latest: 2, ownerDevice: self, here: true };
    const out = mergeNestArtifacts([local], [], desks, self)[0];
    expect(label(out)).toBe(deviceLabel('this machine', 'this machine'));
    expect(label(out)).not.toBe(self);
    expect(out?.['desk']).toBeUndefined();
  });

  it('with Nests off the row still never shows this desk\'s raw id', () => {
    const nest = new NestArtifacts({
      deviceId: () => self, devices: () => desks, sendTo: () => undefined, call: async <T,>() => ({}) as T,
    }, { enabled: () => false, setTimer: () => 0, clearTimer: () => undefined });
    const other = { id: 'art_7', title: 'Theirs', latest: 1, ownerDevice: 'Surface', here: true };
    const out = nest.merge([{ id: 'art_6', title: 'Mine', latest: 2, ownerDevice: self, here: true }, other]);
    expect(label(out[0])).toBe(deviceLabel('this machine', 'this machine'));
    expect(out[1]).toBe(other);
  });

  it('an owner id no desk here names (left the group) reads as another desk with a short id, never the bare id', () => {
    const gone = 'J713ZXxTJVQ';
    const local = mergeNestArtifacts([{ id: 'art_8', title: 'Old', latest: 1, ownerDevice: gone, here: true }], [], desks, self)[0];
    expect(label(local)).toBe('another desk (J713ZX…)');
    // Only another desk holds it, and that desk is not the owner: the owner is named the same way.
    const only = mergeNestArtifacts([], [row('art_9', 1, 'deskAAAAAAA', gone)], desks, self)[0];
    expect(label(only)).toBe('another desk (J713ZX…)');
    expect(JSON.stringify(only?.['desk'])).not.toContain(`"name":"${gone}"`);
  });
});

describe('t-v7i2au: the versions list never shows a raw device id', () => {
  const self = 'deskSELF000';
  const desks = [desk(self, 'Here', { self: true }), desk('deskAAAAAAA', 'Surface')];
  const engine = async (method: string) =>
    method === 'artifact_versions'
      ? { versions: [{ number: 4, device: self }, { number: 3, device: 'deskAAAAAAA' }, { number: 2, device: 'J713ZXxTJVQ' }, { number: 1 }] }
      : {};

  it('this desk reads as this machine, a desk in the roster by name, an unknown id as another desk', async () => {
    const nest = new NestArtifacts({
      deviceId: () => self, devices: () => desks, sendTo: () => undefined, call: async <T,>() => ({}) as T,
    }, { enabled: () => true, setTimer: () => 0, clearTimer: () => undefined });
    const out: Array<Record<string, unknown>> = [];
    await handleArtifactsPaneMessage({ client: { extMethod: engine }, post: (m) => void out.push(m), nest }, { type: 'artifactVersionsRequest', artifactId: 'art_1' });
    const versions = out[0]!['versions'] as Array<Record<string, unknown>>;
    expect(versions.map((v) => deviceLabel(v['device'] as string | undefined, 'this machine')))
      .toEqual(['this desk', 'Surface', 'another desk (J713ZX…)', 'this desk']);
  });
});

// t-vbj8xu: the pane may say "mother base" only for the desk the roster marks.
describe('the mother base the Artifacts pane is told about', () => {
  const self = 'deskSELF000';
  const make = (desks: GroupDeviceView[], on: boolean) => new NestArtifacts({
    deviceId: () => self, devices: () => desks, sendTo: () => undefined, call: async <T,>() => ({}) as T,
  }, { enabled: () => on, setTimer: () => 0, clearTimer: () => undefined });
  const marked = (who: string) => [desk(self, 'Here', { self: true, motherBase: who === self }), desk('deskAAAAAAA', 'Surface', { motherBase: who === 'deskAAAAAAA' })];

  it('the artifactsData post carries the roster\'s mark: another desk, this desk, or none', async () => {
    const list = async () => ({ artifacts: [], homeDevice: 'this machine' });
    const posted = async (nest: NestArtifacts) => {
      const out: Array<Record<string, unknown>> = [];
      await handleArtifactsPaneMessage({ client: { extMethod: list }, post: (m) => void out.push(m), nest }, { type: 'artifactsRequest' });
      return out[0]!['motherBase'];
    };
    expect(await posted(make(marked('deskAAAAAAA'), true))).toEqual({ self: false, name: 'Surface' });
    expect(await posted(make(marked(self), true))).toEqual({ self: true, name: 'Here' });
    expect(await posted(make(marked('none'), true))).toBeUndefined();
    // Nests off: there is no mother base, whatever the stored roster says.
    expect(await posted(make(marked('deskAAAAAAA'), false))).toBeUndefined();
  });
});

describe('artifactSource', () => {
  const desks = [desk('deskAAAAAAA', 'Surface'), desk('deskBBBBBBB', '5090', { motherBase: true }), desk('deskCCCCCCC', 'Mac')];
  it('asks the owner first, then the mother base, never an offline desk or a holder of another version', () => {
    const rows = [row('art_5', 2, 'deskCCCCCCC', 'deskAAAAAAA'), row('art_5', 2, 'deskBBBBBBB', 'deskAAAAAAA'), row('art_5', 2, 'deskAAAAAAA')];
    expect(artifactSource(rows, desks, 'art_5', 2, null)).toBe('deskAAAAAAA');
    const ownerOff = desks.map((d) => (d.id === 'deskAAAAAAA' ? { ...d, online: false } : d));
    expect(artifactSource(rows, ownerOff, 'art_5', 2, null)).toBe('deskBBBBBBB');
    expect(artifactSource(rows, ownerOff, 'art_5', 3, null)).toBeNull();
  });
});

describe('ensure before an Open', () => {
  const make = (held: number) => {
    const sent: NestArtifactMessage[] = [];
    const nest = new NestArtifacts({
      deviceId: () => 'deskSELF000',
      devices: () => [desk('deskAAAAAAA', 'Surface', { online: false })],
      sendTo: (_p, m) => void sent.push(m),
      call: async <T,>(method: string): Promise<T> => (method === 'artifact_versions' ? { versions: held ? [{ number: held }] : [] } : {}) as T,
    }, { enabled: () => true, setTimer: () => 0, clearTimer: () => undefined });
    nest.others = [row('art_000000000000000000000007', 1, 'deskAAAAAAA')];
    return { nest, sent };
  };

  it('an Open from a chat card (the pane never listed it) of a version held here pulls nothing, even with the holder offline', async () => {
    const { nest, sent } = make(1);
    await expect(nest.ensure('art_000000000000000000000007', 1)).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('a version this desk lacks is pulled, and with no holder online the Open says so', async () => {
    const { nest } = make(0);
    await expect(nest.ensure('art_000000000000000000000007')).rejects.toThrow(/No desk that holds this artifact is online/);
  });
});

describe('the per-minute bound', () => {
  it('a pull that has spent the minute waits for the window, then goes on', async () => {
    let clock = 0;
    const waits: number[] = [];
    const big = 'x'.repeat(400_000);
    const size = 5 * 300_000;
    let nest!: NestArtifacts;
    const imported: number[] = [];
    let have = 0;
    const hub = {
      deviceId: () => 'deskSELF000',
      devices: () => [desk('deskAAAAAAA', 'Surface')],
      sendTo: (peer: string, m: NestArtifactMessage) => {
        if (m.type !== 'nest/artifact-request') return;
        const chunk = m.sha256
          ? { kind: 'blob', artifactId: m.artifactId, version: m.version, sha256: m.sha256, offset: m.offset, size, data: big, done: false }
          : { kind: 'manifest', artifactId: m.artifactId, version: m.version };
        queueMicrotask(() => void nest.onPeer(peer, { type: 'nest/artifact-chunk', chunk }));
      },
      call: async <T,>(method: string, p: Record<string, unknown> = {}): Promise<T> => {
        const c = p['chunk'] as Record<string, unknown> | undefined;
        if (c?.['kind'] === 'blob') { have += 300_000; imported.push(clock); return { have, done: have >= size } as T; }
        if (c?.['kind'] === 'manifest') return (have >= size ? { result: 'added' } : { result: 'missing', missing: [{ sha256: 'a'.repeat(64), size, have: 0 }] }) as T;
        return {} as T;
      },
    };
    nest = new NestArtifacts(hub, {
      enabled: () => true,
      now: () => clock,
      // The answer timeout never fires here; a budget wait moves the clock and resumes.
      setTimer: (fn, ms) => { if (ms !== ARTIFACT_WAIT_MS) { waits.push(ms); clock += ms; queueMicrotask(fn); } return 0; },
      clearTimer: () => undefined,
    });
    nest.others = [row('art_000000000000000000000006', 1, 'deskAAAAAAA')];
    await nest.pull('art_000000000000000000000006', 1, 'deskAAAAAAA');
    // ~400 KB per piece against 1 MiB a minute: three pieces, then a wait of the rest of the minute.
    expect(ARTIFACT_MINUTE_BYTES).toBe(1024 * 1024);
    expect(imported).toEqual([0, 0, 0, 60_000, 60_000]);
    expect(waits).toEqual([60_000]);
  });
});

describe('the Artifacts pane with nest rows', () => {
  afterEach(() => cleanup());
  const send = async (data: Record<string, unknown>) => { window.dispatchEvent(new MessageEvent('message', { data })); await tick(); };
  const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

  it('draws the desk chip only on a row the host gave a desk, and re-reads when the nest rows move', async () => {
    const { container } = render(ArtifactsPane);
    await send({ type: 'artifactsData', artifacts: [
      { id: 'art_local', title: 'Made here', latest: 1, ownerDevice: 'this machine', here: true },
      { id: 'art_nest', title: 'From Surface', latest: 2, ownerDevice: 'Surface', here: false, unopened: true,
        desk: { id: 'deskAAAAAAA', name: 'Surface', os: 'win32', online: false, lastSeen: 1, motherBase: false } },
    ] });
    expect(container.querySelector('[data-artifact-id="art_local"] .desk-chip')).toBeNull();
    const chip = container.querySelector('[data-artifact-id="art_nest"] .desk-chip')!;
    expect(chip.textContent!.trim()).toBe('Surface');
    expect(chip.classList.contains('off')).toBe(true);
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await send({ type: 'origami/nestArtifacts' });
    expect(posts()).toEqual([{ type: 'artifactsRequest' }]);
  });
});
