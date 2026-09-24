// Nests L4b (t-s9jr6u) — the Nests view, its hard switch, the Storage card's
// host half, and the Settings view that took the non-insight cards out of
// Insights. Each block names the real bug it would catch.
//
// jsdom has no layout, so the panes are asserted by text, posted messages and
// attributes; appearance is proven by the mock screenshots in the report.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { fake } = vi.hoisted(() => ({
  fake: { settings: {} as Record<string, unknown>, updates: [] as Array<[string, unknown]> },
}));
vi.mock('vscode', () => ({
  window: { showErrorMessage: () => undefined, showInformationMessage: () => undefined },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (k: string, d: unknown) => fake.settings[`${section}.${k}`] ?? d,
      update: async (k: string, v: unknown) => {
        fake.updates.push([`${section}.${k}`, v]);
        fake.settings[`${section}.${k}`] = v;
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import { activateDeviceGroup } from '../../../src/remote/activateGroup';
import { groupMarkMotherBase, resetGroupControl } from '../../../src/remote/groupControl';
import { groupInvite, groupJoin } from '../../../src/remote/groupJoinControl';
import { resetGroupMembers, roster } from '../../../src/remote/groupMembers';
import { handleNestStorageMessage, cleanWindows, isMissingMethod } from '../../../src/dashboard/nestStoragePane';
import { STORAGE_PANE_MESSAGE_TYPES } from '../../../src/dashboard/storagePane';
import { handleChatBackdropMessage } from '../../../src/dashboard/chatBackdropSetting';
import { handleGroupPaneMessage } from '../../../src/dashboard/groupPane';
import { NAMED_REFUSALS } from '../../../src/remote/remoteVerbs';
import { statusLine, deskMeta, joinedDesk, nestsSummary, type NestDesk } from '../components/nestsStatus';
import { dirtySummary, dirtyWindows, windowsShort, NEW_DESK_WINDOWS } from '../components/nestStorageModel';
import { SETTING_GROUPS, SETTING_COUNT, rowMatches, settingRow } from '../panes/settingsGroups';
import { watchChatBackdrop } from '../panes/chatBackdropClass';
import NestsPane from '../panes/NestsPane.svelte';
import NestStorage from '../components/NestStorage.svelte';
import SettingsPane from '../panes/SettingsPane.svelte';
import RemotePane from '../panes/RemotePane.svelte';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8');

function memento() {
  const bag = new Map<string, unknown>();
  return {
    get: <T,>(k: string, d: T) => (bag.has(k) ? (bag.get(k) as T) : d),
    update: (k: string, v: unknown) => { bag.set(k, v); return Promise.resolve(); },
  };
}
function secrets() {
  const map = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(map.get(k)),
    store: (k: string, v: string) => { map.set(k, v); return Promise.resolve(); },
    delete: (k: string) => { map.delete(k); return Promise.resolve(); },
  };
}
const desk = (id: string, name: string, extra: Partial<NestDesk> = {}): NestDesk => ({
  id, name, self: false, online: true, motherBase: false, os: 'windows', lastSeen: 0, ...extra,
});
const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
const fromHost = async (data: Record<string, unknown>) => {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
};

beforeEach(() => {
  fake.settings = {};
  fake.updates = [];
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => {
  cleanup();
  resetGroupControl();
  resetGroupMembers();
});

// ---------------------------------------------------------------------------
// The hard switch. Bug caught: a window with Nests off opening a relay socket.
describe('the Nests switch gates the device group (acceptance 2)', () => {
  function activate(on: { value: boolean }) {
    const connect = vi.fn(() => { throw new Error('no socket in this test'); });
    const handle = activateDeviceGroup({ secrets: secrets(), globalState: memento() } as never, {
      config: () => ({ enabled: true, relayUrl: 'wss://relay.test', capability: 'full' }),
      nestsEnabled: () => on.value,
      os: 'windows',
      deps: { connect, setTimer: () => 0, clearTimer: () => undefined },
      claim: async () => true,
      onStatus: () => undefined,
      deviceName: 'Surface',
    });
    return { connect, handle };
  }

  it('OFF (the default): restore, invite and join construct no transport, and the refusal says why', async () => {
    const on = { value: false };
    const { connect, handle } = activate(on);
    await handle.restore();
    await expect(groupInvite()).rejects.toThrow(/Nests is off/);
    await expect(groupJoin('origami-group-v2.abc.AAAAAAAAAAA')).rejects.toThrow(/Nests is off/);
    // A roster edit still works with the switch off, without a controller.
    await groupMarkMotherBase(null);
    expect(connect).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('ON: the L2 group code runs — an invite dials the relay', async () => {
    const on = { value: false };
    const { connect, handle } = activate(on);
    on.value = true;
    handle.nestsChanged(true);
    const offer = await groupInvite();
    expect(offer.key).toMatch(/^origami-group-v2\./);
    expect(connect).toHaveBeenCalled();
    expect(String((connect.mock.calls[0] as unknown[])[0])).toContain('wss://relay.test');
    expect(roster().members[0]!.os).toBe('windows');
    handle.dispose();
  });

  it('switching OFF again closes the links: the next invite is refused, no new socket', async () => {
    const on = { value: true };
    const { connect, handle } = activate(on);
    await groupInvite();
    const dialled = connect.mock.calls.length;
    on.value = false;
    handle.nestsChanged(false);
    await expect(groupInvite()).rejects.toThrow(/Nests is off/);
    expect(connect.mock.calls.length).toBe(dialled);
    handle.dispose();
  });

  it('the switch is written GLOBAL, and package.json contributes it OFF with the relay promise', async () => {
    const posts: Array<Record<string, unknown>> = [];
    await handleGroupPaneMessage({ post: (m) => void posts.push(m) }, { type: 'groupSetEnabled', enabled: true });
    expect(fake.updates).toEqual([['origamicoder.nests.enabled', true]]);
    expect(posts.at(-1)!['nestsEnabled']).toBe(true);
    const contributed = JSON.parse(read('package.json')).contributes.configuration.properties['origamicoder.nests.enabled'];
    expect(contributed.default).toBe(false);
    expect(contributed.description).toMatch(/Nothing dials the relay until this is on/);
  });

  it('keeps the new desk verbs off the phone', () => {
    for (const t of ['groupSetEnabled', 'groupCancelInvite', 'nestRetentionSet', 'chatBackdropSet']) {
      expect(NAMED_REFUSALS).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// The words. Bug caught: a status line that lies about who is online or home.
describe('nestsStatus — the one status line', () => {
  it('each case names the whole truth', () => {
    expect(statusLine([])).toBe('This desk is not in a nest yet.');
    expect(statusLine([desk('A', 'Surface', { self: true })])).toBe('Only this desk, Surface, is in the nest. Add a desk to share chats.');
    expect(statusLine([desk('A', 'Surface', { self: true, motherBase: true }), desk('B', '5090')]))
      .toBe('2 desks in the nest, both online. This is Surface, the mother base.');
    expect(statusLine([desk('A', 'Surface', { self: true }), desk('B', '5090'), desk('C', 'MacBook', { online: false })]))
      .toBe('3 desks in the nest, 2 of 3 online. This is Surface. No mother base yet.');
  });
  it('an offline desk says when it was last seen', () => {
    const now = 10 * 3_600_000;
    expect(deskMeta(desk('C', 'MacBook', { online: false, lastSeen: now - 3 * 3_600_000 }), now)).toBe('offline · last seen 3 h ago');
    expect(deskMeta(desk('A', 'Surface', { self: true }), now)).toBe('online · this desk');
  });
  it('a join is: invite open, invite gone, one new id', () => {
    const a = desk('A', 'Surface', { self: true });
    const m = desk('M', 'MacBook');
    expect(joinedDesk({ inviteKey: 'k', desks: [a] }, { inviteKey: null, desks: [a, m] })).toEqual(m);
    // Cancelled with nobody new: no note.
    expect(joinedDesk({ inviteKey: 'k', desks: [a] }, { inviteKey: null, desks: [a] })).toBeNull();
    // A desk arriving with no invite open is a hello, not a join.
    expect(joinedDesk({ inviteKey: null, desks: [a] }, { inviteKey: null, desks: [a, m] })).toBeNull();
  });
  it('the toolbar says OFF means nothing dials the relay', () => {
    expect(nestsSummary(false, [])).toBe('Off · nothing dials the relay');
    expect(nestsSummary(true, [])).toBe('On · no desks yet');
    expect(nestsSummary(true, [desk('A', 'S'), desk('B', 'T')])).toBe('2 desks in the nest · connected');
  });
});

// ---------------------------------------------------------------------------
// The view. Bug caught: the off state leaking the desk list or a storage read.
describe('NestsPane — off shows the pitch and the switch only (acceptance 1, 2)', () => {
  it('asks for the group once; OFF draws no Desks, Storage or Config, and asks the engine nothing', async () => {
    const view = render(NestsPane);
    expect(posted()).toEqual([{ type: 'groupRequest' }]);
    await fromHost({ type: 'groupData', nestsEnabled: false, devices: [], inviteKey: null });
    expect(view.container.textContent).toContain('Nothing dials the relay until you turn this on.');
    expect(view.container.querySelector('[data-name="desks"]')).toBeNull();
    expect(view.container.querySelector('[data-name="storage"]')).toBeNull();
    expect(view.container.querySelector('[data-name="config"]')).toBeNull();
    expect(posted().some((m) => m['type'] === 'requestNestStorage')).toBe(false);
    await fireEvent.click(view.getByRole('switch'));
    expect(posted().at(-1)).toEqual({ type: 'groupSetEnabled', enabled: true });
  });

  it('ON draws Desks, Storage and Config, and the join closes the Add a desk panel with a note', async () => {
    const view = render(NestsPane);
    const surface = { id: 'AAAAAAAAAAA', name: 'Surface', self: true, online: true, motherBase: false, os: 'windows', lastSeen: 0 };
    await fromHost({ type: 'groupData', nestsEnabled: true, devices: [surface], inviteKey: 'origami-group-v2.k.AAAAAAAAAAA', inviteQr: '<svg></svg>', relayUrl: 'wss://relay.test' });
    expect(view.container.querySelector('[data-name="desks"]')).not.toBeNull();
    expect(view.container.querySelector('[data-name="storage"]')).not.toBeNull();
    expect(view.container.querySelector('[data-name="config"]')!.textContent).toContain('wss://relay.test');
    expect(view.getByText('Add each desk once. It then reaches every other desk.')).toBeTruthy();
    const mac = { id: 'MMMMMMMMMMM', name: 'MacBook', self: false, online: true, motherBase: false, os: 'macos', lastSeen: 0 };
    await fromHost({ type: 'groupData', nestsEnabled: true, devices: [surface, mac], inviteKey: null });
    expect(view.queryByText('Add each desk once. It then reaches every other desk.')).toBeNull();
    expect(view.getByText('MacBook joined.')).toBeTruthy();
  });

  it('the Remote pane no longer carries the desk card, and asks nothing about the group', () => {
    const view = render(RemotePane);
    expect(view.container.querySelector('[data-name="desks"], [data-name="your desks"]')).toBeNull();
    expect(posted().some((m) => m['type'] === 'groupRequest')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Storage, host half. Bug caught: an engine without L4a breaking the card, or
// a webview window reaching the engine unvalidated.
describe('nestStoragePane — the L4a methods, tolerated when missing', () => {
  const host = (impl: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
    const out: Array<Record<string, unknown>> = [];
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    return { out, calls, h: { post: (m: Record<string, unknown>) => void out.push(m), client: { extMethod: (m: string, p?: Record<string, unknown>) => { calls.push([m, p]); return impl(m, p); } } } };
  };

  it('rides the storage route the panel already has', () => {
    expect(STORAGE_PANE_MESSAGE_TYPES.has('requestNestStorage')).toBe(true);
    expect(STORAGE_PANE_MESSAGE_TYPES.has('nestRetentionSet')).toBe(true);
  });

  // The L4a replies VERBATIM (packages/engine/src/storage/nests.ts StorageResult
  // and RetentionResult, t-sc093o): the card must read these, not a guess.
  const L4A_STORAGE = {
    deviceId: 'AAAAAAAAAAA',
    classes: { chats: 1_288_490_188, subagents: 751_619_276, toolOutput: 966_367_641, journal: 128_974_848, artifacts: 85_983_232 },
    fileBytes: 3_400_000_000,
    journalEventsPerPart: 1,
    method: 'length-sums',
    measuredMs: 412,
  };
  const L4A_RETENTION = { windows: { chats: 30, subagents: 14, toolOutput: 7, journal: null, artifacts: 90 }, unapplied: ['chats', 'subagents', 'artifacts'] };
  const PRUNE = { dryRun: true, olderThanDays: 14, cutoff: 1, parts: 3, toolOutputBytes: 2_000, imageBytes: 40, bytes: 2_040_109_465, rows: {} };

  it('an engine without nest_storage answers PENDING, not an error', async () => {
    const { h, out } = host(async () => { throw Object.assign(new Error('"Method not found"'), { code: -32601 }); });
    await handleNestStorageMessage({ ...h, deviceId: 'AAAAAAAAAAA' }, { type: 'requestNestStorage' });
    expect(out).toEqual([{ type: 'nestStorageData', pending: expect.stringMatching(/nest_storage is not in this build/) }]);
    expect(isMissingMethod(new Error('boom'))).toBe(false);
  });

  it('passes the gate L4a asks for (enabled AND deviceId), and hands both engine replies back as they came', async () => {
    fake.settings['origamicoder.nests.enabled'] = true;
    const { h, out, calls } = host(async (m) => (m === 'nest_storage' ? L4A_STORAGE : L4A_RETENTION));
    await handleNestStorageMessage({ ...h, deviceId: 'AAAAAAAAAAA', now: () => 99 }, { type: 'requestNestStorage' });
    // t-vbivj4: waitMs asks for the sums so far while a slow measure runs (nestStorageMeasure.ts).
    expect(calls).toEqual([['nest_storage', { enabled: true, deviceId: 'AAAAAAAAAAA', waitMs: 1000 }], ['nest_retention', { enabled: true, deviceId: 'AAAAAAAAAAA' }]]);
    expect(out.at(-1)).toEqual({ type: 'nestStorageData', stats: L4A_STORAGE, retention: L4A_RETENTION, measuredAt: 99 });
  });

  it('with no device id (a desk in no nest) it says so and calls nothing', async () => {
    const { h, out, calls } = host(async () => L4A_STORAGE);
    await handleNestStorageMessage({ ...h, deviceId: null }, { type: 'requestNestStorage' });
    expect(calls).toEqual([]);
    expect(out[0]!['pending']).toMatch(/no device id/);
  });

  it('a window edit is a DRY RUN (apply.windows, never set: set is a write), and junk windows never reach the engine', async () => {
    const { h, out, calls } = host(async () => ({ ...L4A_RETENTION, applied: { toolOutput: PRUNE } }));
    await handleNestStorageMessage({ ...h, deviceId: 'AAAAAAAAAAA' }, { type: 'nestRetentionSet', windows: { chats: 14, journal: 1, toolOutput: 3, artifacts: null, subagents: 'x' }, dryRun: 'no' });
    expect(calls).toEqual([['nest_retention', expect.objectContaining({ apply: { dryRun: true, windows: { chats: 14, toolOutput: 3, artifacts: null } } })]]);
    expect(calls[0]![1]).not.toHaveProperty('set');
    expect(out).toEqual([{ type: 'nestRetentionData', dryRun: true, frees: 2_040_109_465 }]);
    expect(cleanWindows({ chats: 7.9, subagents: 0, toolOutput: -1 })).toEqual({ chats: 7 });
  });

  it('Apply sends set + apply {dryRun:false} in the L4a shape, reports what the prune freed, then re-measures', async () => {
    fake.settings['origamicoder.nests.enabled'] = true;
    const applied = { ...L4A_RETENTION, applied: { toolOutput: { ...PRUNE, dryRun: false, bytes: 5_000 } } };
    const { h, out, calls } = host(async (m) => (m === 'nest_retention' ? applied : L4A_STORAGE));
    await handleNestStorageMessage({ ...h, deviceId: 'AAAAAAAAAAA' }, { type: 'nestRetentionSet', windows: { chats: 14, toolOutput: 7 }, dryRun: false });
    expect(calls[0]).toEqual(['nest_retention', { enabled: true, deviceId: 'AAAAAAAAAAA', set: { chats: 14, toolOutput: 7 }, apply: { dryRun: false } }]);
    expect(out[0]).toEqual({ type: 'nestRetentionData', retention: applied, dryRun: false, frees: 5_000 });
    expect(out.at(-1)!['type']).toBe('nestStorageData');
  });

  it('with no chat open it says so', async () => {
    const out: Array<Record<string, unknown>> = [];
    await handleNestStorageMessage({ post: (m) => void out.push(m) }, { type: 'requestNestStorage' });
    expect(out[0]!['pending']).toMatch(/Open a chat first/);
  });
});

// Storage, the card. Bug caught: an edit applied without a confirm, or a
// missing engine method shown as an empty store.
describe('NestStorage — measuring, edit, Apply', () => {
  const two = [desk('AAAAAAAAAAA', 'Surface', { self: true }), desk('BBBBBBBBBBB', '5090', { motherBase: true })];
  const stats = { deviceId: 'AAAAAAAAAAA', classes: { chats: 1_288_490_188, subagents: 751_619_276, toolOutput: 966_367_641, journal: 128_974_848, artifacts: 85_983_232 }, fileBytes: 1, journalEventsPerPart: 1, method: 'length-sums', measuredMs: 3 };
  const windows = { chats: 30, subagents: 14, toolOutput: 7, artifacts: 90 };

  it('pending: stays in its measuring state and shows the host reason', async () => {
    const view = render(NestStorage, { props: { desks: two } });
    expect(posted()).toContainEqual({ type: 'requestNestStorage' });
    await fromHost({ type: 'nestStorageData', pending: 'This engine cannot measure by class yet (nest_storage is not in this build).' });
    expect(view.container.querySelectorAll('.skel').length).toBeGreaterThan(0);
    expect(view.getByRole('status').textContent).toContain('nest_storage is not in this build');
  });

  it('an edit is a dry run first, then Apply asks, and only the confirm removes', async () => {
    const view = render(NestStorage, { props: { desks: two } });
    await fromHost({ type: 'nestStorageData', stats, retention: { windows } });
    expect(view.getByText('1.2 GB')).toBeTruthy();
    const chats = view.getByLabelText('Keep Chats') as HTMLSelectElement;
    await fireEvent.change(chats, { target: { value: '14' } });
    expect(posted().at(-1)).toEqual({ type: 'nestRetentionSet', windows: { ...windows, chats: 14 }, dryRun: true });
    await fromHost({ type: 'nestRetentionData', dryRun: true, frees: 2_040_109_465 });
    expect(view.container.textContent).toContain('1 change not applied. Chats: 30 days → 14 days.');
    expect(view.container.textContent).toContain('Frees 1.9 GB');
    await fireEvent.click(view.getByText('Apply…'));
    expect(posted().filter((m) => m['dryRun'] === false)).toHaveLength(0);
    await fireEvent.click(view.getByText('Remove'));
    expect(posted().at(-1)).toEqual({ type: 'nestRetentionSet', windows: { ...windows, chats: 14 }, dryRun: false });
  });

  it("reads the journal pill from the engine's journalEventsPerPart, and offers no 0-day window (the engine refuses 0)", async () => {
    const view = render(NestStorage, { props: { desks: two } });
    await fromHost({ type: 'nestStorageData', stats: { ...stats, journalEventsPerPart: 4.2 }, retention: { windows }, measuredAt: Date.now() });
    expect(view.getByText('not compact')).toBeTruthy();
    expect(view.container.textContent).toContain('measured');
    const opts = Array.from((view.getByLabelText('Keep Chats') as HTMLSelectElement).options).map((o) => o.value);
    expect(opts).toEqual(['all', '90', '30', '14', '7']);
  });

  it('the mother base keeps Everything and has no Keep select', async () => {
    const view = render(NestStorage, { props: { desks: two } });
    await fromHost({ type: 'nestStorageData', stats, retention: { windows } });
    await fireEvent.click(view.getByRole('tab', { name: /5090/ }));
    expect(view.queryByLabelText('Keep Chats')).toBeNull();
    expect(view.getAllByText('Everything').length).toBe(4);
  });

  it('a desk alone warns that a window deletes for good', async () => {
    const view = render(NestStorage, { props: { desks: [desk('AAAAAAAAAAA', 'Surface', { self: true })] } });
    expect(view.container.textContent).toContain('a window here deletes old content for good');
  });

  it('the pure rules behind the foot', () => {
    expect(dirtyWindows(windows, { chats: 30, toolOutput: null })).toEqual({ toolOutput: null });
    expect(dirtySummary(windows, { toolOutput: null })).toBe('1 change not applied. Tool output: 7 days → Everything.');
    expect(windowsShort(NEW_DESK_WINDOWS)).toBe('30 · 14 · 7 · 90 days');
  });
});

// ---------------------------------------------------------------------------
// Settings (acceptance 3). Bug caught: a setting that left Insights and landed
// nowhere, or a filter that hides a row but leaves its empty group behind.
describe('Settings — groups, rows, filter', () => {
  it('holds exactly the owner groups and the seven moved settings', () => {
    expect(SETTING_GROUPS.map((g) => g.name)).toEqual(['Chat', 'Agents', 'Browser', 'Cache', 'Appearance']);
    expect(SETTING_COUNT).toBe(7);
    expect(settingRow('cacheWarming').reload).toMatch(/Reload the window/);
    // The backdrop row flips live, so it carries no reload pill.
    expect(settingRow('backdrop').reload).toBeUndefined();
  });

  it('renders every row, and the filter hides rows AND the groups left empty', async () => {
    const view = render(SettingsPane);
    for (const g of SETTING_GROUPS) for (const r of g.rows) expect(view.container.querySelector(`[data-setting="${r.id}"]`)).not.toBeNull();
    const box = view.getByLabelText('Filter settings') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: 'viewport' } });
    expect(view.container.querySelector('[data-setting="browserViewport"]')!.hasAttribute('hidden')).toBe(false);
    expect(view.container.querySelector('[data-setting="browserBeside"]')!.hasAttribute('hidden')).toBe(true);
    expect(view.container.querySelector('[data-group="Chat"]')!.hasAttribute('hidden')).toBe(true);
    expect(view.container.querySelector('[data-group="Browser"]')!.hasAttribute('hidden')).toBe(false);
    expect(rowMatches(settingRow('density'), 'COMPACT')).toBe(true);
  });

  it('the dot-grid backdrop has a real control that writes the setting', async () => {
    const view = render(SettingsPane);
    expect(posted()).toContainEqual({ type: 'requestChatBackdrop' });
    await fromHost({ type: 'chatBackdropData', enabled: true });
    await fireEvent.click(view.getByRole('switch', { name: 'Dot-grid backdrop' }));
    expect(posted().at(-1)).toEqual({ type: 'chatBackdropSet', enabled: false });
    const out: Array<Record<string, unknown>> = [];
    await handleChatBackdropMessage({ post: (m) => void out.push(m) }, { type: 'chatBackdropSet', enabled: false });
    expect(fake.updates).toContainEqual(['origamicoder.chat.backdrop', false]);
    expect(out.at(-1)).toEqual({ type: 'chatBackdropData', enabled: false });
    await handleChatBackdropMessage({ post: (m) => void out.push(m) }, { type: 'chatBackdropSet', enabled: 'no' });
    expect(out.at(-1)!['error']).toMatch(/true or false/);
  });

  it('an open chat pane follows the broadcast without a reload', () => {
    const seen: boolean[] = [];
    const stop = watchChatBackdrop((on) => seen.push(on));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatBackdropData', enabled: false } }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatBackdropData', enabled: 'x' } }));
    stop();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'chatBackdropData', enabled: true } }));
    expect(seen).toEqual([false]);
    expect(read('webview/dashboard/panes/ChatPane.svelte')).toContain('watchChatBackdrop((on) => (chatBackdropSetting = on))');
  });

  it('Insights keeps only instructions, the cache ratio and the prompt capture', () => {
    const insights = read('webview/dashboard/panes/InstructionsPane.svelte');
    for (const moved of ['SubagentLimitCard', 'CacheWarmingCard', 'BrowserSettings', 'StorageCard', 'DensityCard', 'InsightsSettingsCards']) {
      expect(insights).not.toContain(`<${moved}`);
    }
    for (const kept of ['<CacheStatsCard />', '<PromptCaptureSection />', '<InstructionRow']) expect(insights).toContain(kept);
  });
});
