// The device-group pane, both halves (t-rz1b14 acceptance 1 and 3).
//
// Host side (src/dashboard/groupPane.ts): the seven messages the card can send,
// and the two that carry a consequence — a join whose key is wrong must come
// back with words that name the fix, and the mother-base marker must be what
// the host stored rather than what the card hoped.
//
// Webview side (components/NestDesks.svelte — the card moved to the Nests view
// in t-s9jr6u): jsdom has no layout, so this asserts text, posted messages and
// class, never a computed size.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('vscode', () => ({
  window: { showErrorMessage: () => undefined, showInformationMessage: () => undefined },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d, update: async () => undefined }) },
  ConfigurationTarget: { Global: 1 },
}));

import { GROUP_PANE_MESSAGE_TYPES, handleGroupPaneMessage } from '../../../src/dashboard/groupPane';
import { REMOTE_PANE_MESSAGE_TYPES, handleRemotePaneMessage } from '../../../src/dashboard/remotePane';
import { registerGroupControl, resetGroupControl } from '../../../src/remote/groupControl';
import { registerGroupMembers, resetGroupMembers, roster } from '../../../src/remote/groupMembers';
import { GroupController } from '../../../src/remote/groupController';
import type { SecretStore } from '../../../src/remote/pairing';
import { b64urlEncode } from '../../../src/remote/crypto';
import { ephemeralKeys } from '../../../src/remote/groupWelcomeSeal';
import NestDesks from '../components/NestDesks.svelte';

function memento(): { get<T>(k: string, d: T): T; update(k: string, v: unknown): PromiseLike<void> } {
  const bag = new Map<string, unknown>();
  return {
    get: <T,>(k: string, d: T) => (bag.has(k) ? (bag.get(k) as T) : d),
    update: (k, v) => {
      bag.set(k, v);
      return Promise.resolve();
    },
  };
}

function secrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
  };
}

describe('device group — host side', () => {
  const posts: Array<Record<string, unknown>> = [];
  const host = { post: (m: Record<string, unknown>) => void posts.push(m) };
  let controller: GroupController;

  beforeEach(() => {
    posts.length = 0;
    registerGroupMembers(memento());
    controller = new GroupController({
      config: () => ({ enabled: true, relayUrl: 'wss://relay.test' }),
      secrets: secrets(),
      deps: { connect: () => { throw new Error('no socket in this test'); }, setTimer: () => 0, clearTimer: () => undefined },
      deviceName: 'The 5090',
    });
    registerGroupControl({ target: () => controller, enabled: () => true });
  });

  afterEach(() => {
    controller.dispose();
    resetGroupControl();
    resetGroupMembers();
  });

  it('is routed through the remote pane, so the panel keeps one entry point', () => {
    for (const type of GROUP_PANE_MESSAGE_TYPES) expect(REMOTE_PANE_MESSAGE_TYPES.has(type)).toBe(true);
  });

  it('an invitation posts the key AND the same string drawn as a QR', async () => {
    await handleRemotePaneMessage(host, { type: 'groupInvite' });
    const data = posts.at(-1)!;
    expect(data['type']).toBe('groupData');
    expect(String(data['inviteKey'])).toMatch(/^origami-group-v2\./);
    expect(String(data['inviteQr'])).toContain('<svg');
    // The desk lists itself the moment it holds a group, so the owner sees
    // where they are before anybody has joined.
    expect((data['devices'] as unknown[]).length).toBe(1);
  });

  it('a bad key comes back with the words that name the fix, and changes nothing', async () => {
    await handleGroupPaneMessage(host, { type: 'groupJoin', key: 'not-a-key' });
    expect(String(posts.at(-1)!['error'])).toMatch(/starts with "origami-group-v2\."/);
    expect(roster().members).toEqual([]);
  });

  it('marks and clears the mother base through the host, never optimistically', async () => {
    await handleGroupPaneMessage(host, { type: 'groupInvite' });
    const self = String(posts.at(-1)!['deviceId']);
    await handleGroupPaneMessage(host, { type: 'groupSetMotherBase', id: self });
    expect((posts.at(-1)!['devices'] as Array<{ motherBase: boolean }>)[0]!.motherBase).toBe(true);
    expect(roster().motherBase).toBe(self);
    await handleGroupPaneMessage(host, { type: 'groupSetMotherBase', id: '' });
    expect(roster().motherBase).toBe(null);
  });

  it('with Nests switched off the roster is still READABLE and nothing is live', async () => {
    registerGroupControl({ target: () => controller, enabled: () => false });
    await handleGroupPaneMessage(host, { type: 'groupRequest' });
    expect(posts.at(-1)!['active']).toBe(false);
    expect(posts.at(-1)!['inviteKey']).toBe(null);
    expect(posts.at(-1)!['nestsEnabled']).toBe(false);
  });

  it('with Nests off an invite is REFUSED in words, not opened', async () => {
    registerGroupControl({ target: () => controller, enabled: () => false });
    await handleGroupPaneMessage(host, { type: 'groupInvite' });
    expect(String(posts.at(-1)!['error'])).toMatch(/Nests is off/);
    expect(posts.at(-1)!['inviteKey']).toBe(null);
  });

  it('a desk asking to join PUSHES the Accept step; Accept closes the invite and lists the desk', async () => {
    controller.dispose();
    const { notifyGroupChange } = await import('../../../src/remote/groupChange');
    controller = new GroupController({
      config: () => ({ enabled: true, relayUrl: 'wss://relay.test' }),
      secrets: secrets(),
      deps: { connect: () => { throw new Error('no socket in this test'); }, setTimer: () => 0, clearTimer: () => undefined },
      deviceName: 'The 5090',
      onChange: notifyGroupChange,
    });
    // Subscribe as the pane does, then make the join happen on the controller.
    await handleGroupPaneMessage(host, { type: 'groupRequest' });
    await handleGroupPaneMessage(host, { type: 'groupInvite' });
    expect(posts.at(-1)!['inviteKey']).not.toBe(null);
    const before = posts.length;
    const self = String(posts.at(-1)!['deviceId']);
    const joiner = self === 'CCCCCCCCCCC' ? 'DDDDDDDDDDD' : 'CCCCCCCCCCC';
    const hs = (controller as unknown as { handshake: { onJoin(m: Record<string, unknown>): Promise<void> } }).handshake;
    await hs.onJoin({ type: 'group/join', from: joiner, name: 'MacBook', pub: b64urlEncode((await ephemeralKeys()).pub) });
    const pushed = posts.slice(before);
    expect(pushed.length).toBeGreaterThan(0);
    // t-sj32zl: the invite STAYS open and the desk is NOT listed until the owner answers.
    expect(pushed.at(-1)!['joinCheck']).toMatchObject({ side: 'inviter', name: 'MacBook' });
    expect(String((pushed.at(-1)!['joinCheck'] as { code: string }).code)).toMatch(/^\d{3} \d{3}$/);
    expect(pushed.at(-1)!['inviteKey']).not.toBe(null);
    expect((pushed.at(-1)!['devices'] as Array<{ id: string }>).map((d) => d.id)).not.toContain(joiner);
    await handleGroupPaneMessage(host, { type: 'groupAnswerJoin', accept: true });
    expect(posts.at(-1)!['inviteKey']).toBe(null);
    expect(posts.at(-1)!['joinCheck']).toBe(null);
    expect((posts.at(-1)!['devices'] as Array<{ id: string }>).map((d) => d.id)).toContain(joiner);
  });

  it('an Accept with no desk waiting comes back in words', async () => {
    await handleGroupPaneMessage(host, { type: 'groupInvite' });
    await handleGroupPaneMessage(host, { type: 'groupAnswerJoin', accept: true });
    expect(String(posts.at(-1)!['error'])).toMatch(/no desk is waiting to join/);
  });
});

describe('device group — the Desks card (NestDesks.svelte)', () => {
  const desk = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, self: false, online: true, motherBase: false, os: 'windows' as const, lastSeen: 0, ...extra,
  });
  const base = { inviteKey: null, inviteQr: '', inviteExpiresAt: null, error: null, joined: null, seq: 1, onDismissJoined: () => {} };

  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
  afterEach(() => cleanup());
  const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);

  it('names every desk by host name with one status line, and shows no device id', async () => {
    const view = render(NestDesks, { props: { ...base, desks: [
      desk('AAAAAAAAAAA', 'Surface', { self: true }),
      desk('BBBBBBBBBBB', '5090', { motherBase: true }),
    ] } });
    expect(view.getByText('2 desks in the nest, both online. This is Surface. 5090 is the mother base.')).toBeTruthy();
    expect(view.getByText('Surface')).toBeTruthy();
    expect(view.getByText('online · this desk')).toBeTruthy();
    // Owner rule: no key chips and no ids on a row.
    expect(view.container.textContent).not.toContain('AAAAAA');
    expect(view.container.querySelectorAll('.home')).toHaveLength(1);
  });

  it('asks before making a desk the mother base, and CLEARS it at once on the desk that holds it', async () => {
    const view = render(NestDesks, { props: { ...base, desks: [
      desk('AAAAAAAAAAA', 'Surface', { self: true }),
      desk('BBBBBBBBBBB', '5090', { motherBase: true }),
    ] } });
    await fireEvent.click(view.getByLabelText('Make Surface the mother base'));
    expect(posted().some((m) => m['type'] === 'groupSetMotherBase')).toBe(false);
    await fireEvent.click(view.getByText('Make mother base'));
    expect(posted().at(-1)).toEqual({ type: 'groupSetMotherBase', id: 'AAAAAAAAAAA' });
    await fireEvent.click(view.getByLabelText('Clear mother base'));
    expect(posted().at(-1)).toEqual({ type: 'groupSetMotherBase', id: '' });
  });

  it('the × on THIS desk leaves the nest; on another desk it removes that desk', async () => {
    const view = render(NestDesks, { props: { ...base, desks: [
      desk('AAAAAAAAAAA', 'Surface', { self: true }),
      desk('BBBBBBBBBBB', '5090'),
    ] } });
    await fireEvent.click(view.getByLabelText('Remove 5090'));
    expect(posted().at(-1)).toEqual({ type: 'groupRemoveDevice', id: 'BBBBBBBBBBB' });
    await fireEvent.click(view.getByLabelText('Take this desk out of the nest'));
    expect(posted().at(-1)).toEqual({ type: 'groupForget' });
  });

  it('renames in place: Enter posts ONE rename, Escape posts none', async () => {
    const view = render(NestDesks, { props: { ...base, desks: [desk('AAAAAAAAAAA', 'Surface', { self: true })] } });
    await fireEvent.click(view.getByLabelText('Rename'));
    const box = view.getByLabelText('Desk name') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: 'Laptop' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(posted().filter((m) => m['type'] === 'groupRenameDevice')).toEqual([{ type: 'groupRenameDevice', id: 'AAAAAAAAAAA', name: 'Laptop' }]);
    await fireEvent.click(view.getByLabelText('Rename'));
    await fireEvent.keyDown(view.getByLabelText('Desk name'), { key: 'Escape' });
    expect(posted().filter((m) => m['type'] === 'groupRenameDevice')).toHaveLength(1);
  });

  it('empty: Start and Join, refusing to post an empty key and showing the host error verbatim', async () => {
    const view = render(NestDesks, { props: { ...base, desks: [], error: 'origami group: a group key starts with "origami-group-v2."' } });
    expect(view.getByText('This desk is not in a nest yet.')).toBeTruthy();
    const box = view.getByLabelText('Nest key') as HTMLInputElement;
    await fireEvent.click(view.getByText('Join'));
    expect(posted().some((m) => m['type'] === 'groupJoin')).toBe(false);
    await fireEvent.input(box, { target: { value: '  origami-group-v2.abc.AAAAAAAAAAA  ' } });
    await fireEvent.click(view.getByText('Join'));
    expect(posted().at(-1)).toEqual({ type: 'groupJoin', key: 'origami-group-v2.abc.AAAAAAAAAAA' });
    expect(view.getByRole('alert').textContent).toContain('starts with');
    await fireEvent.click(view.getByText('Start and add a desk'));
    expect(posted().at(-1)).toEqual({ type: 'groupInvite' });
  });

  it('the Add a desk panel carries the key and a Cancel that closes the invitation host-side', async () => {
    const view = render(NestDesks, { props: { ...base, inviteKey: 'origami-group-v2.k.AAAAAAAAAAA', inviteQr: '<svg></svg>',
      desks: [desk('AAAAAAAAAAA', 'Surface', { self: true })] } });
    expect(view.getByText('origami-group-v2.k.AAAAAAAAAAA')).toBeTruthy();
    // While the panel is open there is no second "Add a desk" button.
    expect(view.queryByRole('button', { name: /Add a desk/ })).toBeNull();
    await fireEvent.click(view.getByText('Cancel'));
    expect(posted().at(-1)).toEqual({ type: 'groupCancelInvite' });
  });
});
