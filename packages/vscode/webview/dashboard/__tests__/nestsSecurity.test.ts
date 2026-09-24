// The Nests view's security surface (t-sj32zl acceptance 4 and 6): the
// Security card and its self-host link, the Accept step on both desks, and
// the drift guard for the JoinCheck mirror.
//
// jsdom has no layout, so these assert text, hrefs and posted messages only.
// How the card looks on the five themes needs a human eye in VS Code.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import NestsSecurity from '../components/NestsSecurity.svelte';
import NestDesks from '../components/NestDesks.svelte';
import NestsPane from '../panes/NestsPane.svelte';
import { REMOTE_SELF_HOST_URL } from '../components/remoteLinks';
import { readJoinCheck } from '../components/nestJoinCheck';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(pkg, rel), 'utf8');
const posted = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());
afterEach(() => cleanup());

describe('Nests — the Security card', () => {
  it('links the self-host relay guide, the same URL as the Remote pane', () => {
    const view = render(NestsSecurity);
    const link = view.getByRole('link', { name: 'Run your own relay — guide' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(REMOTE_SELF_HOST_URL);
    expect(REMOTE_SELF_HOST_URL).toMatch(/^https:\/\//);
  });

  it('says what the relay is, what the key is, the Accept step and how to remove a desk', () => {
    const text = (render(NestsSecurity).container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('It has no accounts.');
    expect(text).toContain('The relay keeps nothing on its disk.');
    expect(text).toContain('An invite key does not contain the nest key.');
    expect(text).toContain('it stops after 10 minutes');
    expect(text).toContain('Click Accept only if the name and the two codes are the same.');
    expect(text).toContain('The new nest has a new key.');
  });

  it('is in the Nests view when Nests is on', async () => {
    const view = render(NestsPane);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'groupData', nestsEnabled: true, devices: [], inviteKey: null } }));
    await tick();
    const card = view.container.querySelector('[data-name="security"]');
    expect(card).not.toBeNull();
    expect(card!.querySelector('a')!.getAttribute('href')).toBe(REMOTE_SELF_HOST_URL);
  });

  it('is in the Nests view when Nests is off, so the owner reads it before turning Nests on', async () => {
    const view = render(NestsPane);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'groupData', nestsEnabled: false, devices: [], inviteKey: null } }));
    await tick();
    expect(view.container.querySelector('[data-name="security"]')).not.toBeNull();
    expect(view.container.querySelector('[data-name="desks"]')).toBeNull();
  });
});

describe('Nests — the Accept step in the Desks card', () => {
  const self = { id: 'AAAAAAAAAAA', name: 'The 5090', self: true, online: true, motherBase: false, os: 'windows' as const, lastSeen: 0 };
  const base = { inviteKey: null, inviteQr: '', inviteExpiresAt: null, error: null, joined: null, seq: 1, onDismissJoined: () => {} };

  it('inviter: names the desk, shows the code, hides the key panel; Accept and Decline post the answer', async () => {
    const view = render(NestDesks, { props: { ...base, desks: [self], inviteKey: 'origami-group-v2.k.AAAAAAAAAAA',
      joinCheck: { side: 'inviter', name: 'MacBook', code: '123 456' } } });
    expect(view.container.textContent).toContain('MacBook wants to join this nest.');
    expect(view.getByText('123 456')).toBeTruthy();
    expect(view.queryByText('origami-group-v2.k.AAAAAAAAAAA')).toBeNull();
    await fireEvent.click(view.getByText('Accept'));
    expect(posted().at(-1)).toEqual({ type: 'groupAnswerJoin', accept: true });
    await fireEvent.click(view.getByText('Decline'));
    expect(posted().at(-1)).toEqual({ type: 'groupAnswerJoin', accept: false });
  });

  it('joiner: waits with the same code and its own name; Cancel closes the wait; no Start/Join choices', async () => {
    const view = render(NestDesks, { props: { ...base, desks: [], joinCheck: { side: 'joiner', name: 'MacBook', code: '123 456' } } });
    expect(view.getByText('Waiting for the other desk to accept.')).toBeTruthy();
    expect(view.getByText('123 456')).toBeTruthy();
    expect(view.container.textContent).toContain('"MacBook"');
    expect(view.queryByLabelText('Nest key')).toBeNull();
    await fireEvent.click(view.getByText('Cancel'));
    expect(posted().at(-1)).toEqual({ type: 'groupCancelInvite' });
  });

  it('shows why the last join ended', () => {
    const view = render(NestDesks, { props: { ...base, desks: [], joinNotice: 'The other desk declined. Ask for a new invite.' } });
    expect(view.getByText('The other desk declined. Ask for a new invite.')).toBeTruthy();
  });

  it('reads a check off the wire strictly: a malformed one is none', () => {
    expect(readJoinCheck({ side: 'inviter', name: 'M', code: '123 456' })).toEqual({ side: 'inviter', name: 'M', code: '123 456' });
    expect(readJoinCheck({ side: 'x', name: 'M', code: '123 456' })).toBe(null);
    expect(readJoinCheck({ side: 'joiner', name: 'M', code: '<b>1</b>' })).toBe(null);
    expect(readJoinCheck(null)).toBe(null);
  });

  it('the webview JoinCheck mirrors the host one field for field (drift guard)', () => {
    const fields = (src: string) => {
      const body = /export interface JoinCheck \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
      return body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('/**') && !l.startsWith('*') && !l.startsWith('//'));
    };
    const host = fields(read('src/remote/groupHandshake.ts'));
    expect(host.length).toBe(3);
    expect(fields(read('webview/dashboard/components/nestJoinCheck.ts'))).toEqual(host);
  });
});
