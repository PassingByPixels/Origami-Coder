// remotePane.test.ts — the Remote rail view, both halves.
//
// Host side (src/dashboard/remotePane.ts): the six messages the pane can send.
// The ones that matter are the ones with a security consequence — switching
// Remote OFF must REVOKE, not just unset a flag, and the pairing QR must carry
// the rendezvous id the controller actually minted rather than a constant that
// happens to render.
//
// Webview side (panes/RemotePane.svelte): jsdom has no layout engine, so this
// asserts text, class and posted messages, never a computed colour or size.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

const { fake } = vi.hoisted(() => ({
  fake: {
    errors: [] as string[],
    infos: [] as string[],
    settings: new Map<string, unknown>(),
    updates: [] as Array<{ key: string; value: unknown; target: number }>,
    updateThrows: null as string | null,
  },
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: (m: string) => void fake.errors.push(m),
    showInformationMessage: (m: string) => void fake.infos.push(m),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => (fake.settings.has(key) ? fake.settings.get(key) : fallback),
      update: async (key: string, value: unknown, target: number) => {
        if (fake.updateThrows) throw new Error(fake.updateThrows);
        fake.settings.set(key, value);
        fake.updates.push({ key, value, target });
      },
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

import { REMOTE_PANE_MESSAGE_TYPES, handleRemotePaneMessage, remotePayload } from '../../../src/dashboard/remotePane';
import { registerRemoteControl, resetRemoteControl, noteRemoteStatus } from '../../../src/remote/control';
import {
  DEVICE_NAME_MAX,
  deviceNameFor,
  registerDeviceNames,
  resetDeviceNames,
  setDeviceName,
} from '../../../src/remote/deviceNames';
import { encodeQr, qrSvg } from '../../../src/remote/qr';
import { PairingManager, parseQrPayload } from '../../../src/remote/pairing';
import RemotePane from '../panes/RemotePane.svelte';
import { REMOTE_APP_URL, REMOTE_SELF_HOST_URL } from '../components/remoteLinks';
import { isKeyFoldOpen, withKeyFold, REMOTE_FOLD_KEY } from '../components/remoteFoldState';
import { ago, relayHost, ridPrefix, DEVICE_NAME_MAX as PANE_DEVICE_NAME_MAX } from '../components/remoteFormat';

const RID = 'rid-from-the-controller';
const QR_PAYLOAD = `https://relay.example/app/#v1.${RID}.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`;

interface Recorded {
  pairs: number;
  revokes: string[];
  restores: number;
}

function useFakeController(
  over: Partial<{
    connected: boolean;
    rid: string | null;
    confirmed: boolean;
    confirmedAt: number | null;
    device: { name: string; fp: string; platform: string; app: string; backend: string } | null;
    modes: Array<{ sessionId: string; mode: 'yolo'; device: string; fp: string; at: number }>;
  }> = {},
): Recorded {
  const recorded: Recorded = { pairs: 0, revokes: [], restores: 0 };
  registerRemoteControl({
    enabled: () => fake.settings.get('enabled') === true,
    target: () => ({
      get connected() {
        return over.connected ?? false;
      },
      get device() {
        return over.device ?? null;
      },
      get modes() {
        return over.modes ?? [];
      },
      get rid() {
        return over.rid === undefined ? RID : over.rid;
      },
      // Defaults to a phone that HAS said hello, so every test above that only
      // cares about settings keeps meaning what it meant.
      get confirmedAt() {
        if (over.confirmedAt !== undefined) return over.confirmedAt;
        return (over.confirmed ?? true) ? 1_700_000_000_000 : null;
      },
      pair: async () => {
        recorded.pairs += 1;
        return { rid: RID, qr: QR_PAYLOAD, expiresAt: 1_700_000_060_000 };
      },
      revoke: async (reason?: string) => void recorded.revokes.push(reason ?? ''),
      restore: async () => void (recorded.restores += 1),
    }),
  });
  return recorded;
}

const posts: Array<Record<string, unknown>> = [];
const host = { post: (m: Record<string, unknown>) => void posts.push(m) };
const lastOf = (type: string) => [...posts].reverse().find((p) => p['type'] === type);

beforeEach(() => {
  posts.length = 0;
  fake.errors.length = 0;
  fake.infos.length = 0;
  fake.updates.length = 0;
  fake.updateThrows = null;
  fake.settings.clear();
  resetRemoteControl();
});
afterEach(() => cleanup());

describe('remotePane host — the message table', () => {
  it('reports OFF with no controller registered at all — a window that never activated Remote', async () => {
    await handleRemotePaneMessage(host, { type: 'remoteRequest' });
    expect(lastOf('remoteData')).toMatchObject({ enabled: false, connection: 'off', rid: null });
  });
});

describe('remotePane host — the settings writes', () => {
  it('the enabled toggle writes the setting GLOBAL and re-reads it', async () => {
    useFakeController();
    await handleRemotePaneMessage(host, { type: 'remoteSetEnabled', enabled: true });

    expect(fake.updates).toEqual([{ key: 'enabled', value: true, target: 1 }]);
    expect(lastOf('remoteData')).toMatchObject({ enabled: true });
  });

  it('MUTATION PROOF — switching Remote OFF also revokes the live pairing', async () => {
    const recorded = useFakeController();
    fake.settings.set('enabled', true);

    await handleRemotePaneMessage(host, { type: 'remoteSetEnabled', enabled: false });

    // Unsetting the flag alone would pass the first assertion and leave a phone
    // paired months ago reachable the moment the switch went back on.
    expect(fake.updates.at(-1)).toEqual({ key: 'enabled', value: false, target: 1 });
    expect(recorded.revokes).toEqual(['Origami Remote was switched off']);
  });

  it('switching Remote ON does not revoke — only OFF does', async () => {
    const recorded = useFakeController();
    await handleRemotePaneMessage(host, { type: 'remoteSetEnabled', enabled: true });
    expect(recorded.revokes).toEqual([]);
  });

  it('a failed settings write re-posts the LIVE value and surfaces the reason', async () => {
    useFakeController();
    fake.updateThrows = 'setting is locked by policy';

    await handleRemotePaneMessage(host, { type: 'remoteSetEnabled', enabled: true });

    expect(fake.errors[0]).toContain('setting is locked by policy');
    // Not the attempted value: the pane must snap back to what VS Code has.
    expect(lastOf('remoteData')).toMatchObject({ enabled: false });
    expect((lastOf('remoteData') as { error?: string }).error).toContain('locked by policy');
  });

  it('a relay URL that is not a websocket is refused before it is written', async () => {
    useFakeController();
    await handleRemotePaneMessage(host, { type: 'remoteSetRelayUrl', url: 'https://relay.example' });

    expect(fake.updates).toEqual([]);
    expect((lastOf('remoteData') as { error?: string }).error).toContain('wss://');
  });

  it('an empty relay URL restores the default rather than writing an empty string', async () => {
    const recorded = useFakeController();
    await handleRemotePaneMessage(host, { type: 'remoteSetRelayUrl', url: '   ' });
    expect(fake.updates).toEqual([{ key: 'relayUrl', value: 'wss://relay.origamilabs.nl', target: 1 }]);
    // The live transport keeps the URL it was built with: a written relay must
    // reopen the socket, or the pane shows one relay while the desktop sits on another.
    expect(recorded.restores).toBe(1);
  });

});

describe('remotePane host — pairing', () => {
  it('MUTATION PROOF — the QR encodes the payload carrying THIS pairing rid', async () => {
    const recorded = useFakeController();
    fake.settings.set('enabled', true);

    await handleRemotePaneMessage(host, { type: 'remotePair' });

    expect(recorded.pairs).toBe(1);
    const posted = lastOf('remoteQr') as { svg: string; rid: string; expiresAt: number };
    expect(posted.rid).toBe(RID);
    expect(posted.expiresAt).toBe(1_700_000_060_000);
    // The SVG is what the encoder makes of THIS payload...
    expect(posted.svg).toBe(qrSvg(encodeQr(QR_PAYLOAD)));
    // ...and not of a payload with a different rid. Encoding a constant, or
    // dropping the rid on the way through, passes nothing here.
    const otherRid = QR_PAYLOAD.replace(RID, 'a-completely-different-rid');
    expect(posted.svg).not.toBe(qrSvg(encodeQr(otherRid)));
  });

  it('the QR offer carries the relay origin, in the SAME form the app shows after a scan', async () => {
    useFakeController();
    fake.settings.set('enabled', true);
    await handleRemotePaneMessage(host, { type: 'remotePair' });
    // Default relay, no port — relayHttpUrl's own rule, not a re-implementation.
    expect((lastOf('remoteQr') as { relayOrigin: string }).relayOrigin).toBe('https://relay.origamilabs.nl');
  });

  it('the relay origin keeps a non-default port', async () => {
    useFakeController();
    fake.settings.set('enabled', true);
    fake.settings.set('relayUrl', 'wss://relay.example.org:8443');
    await handleRemotePaneMessage(host, { type: 'remotePair' });
    expect((lastOf('remoteQr') as { relayOrigin: string }).relayOrigin).toBe('https://relay.example.org:8443');
  });

  it('the payload the controller mints really does carry its own rid (real PairingManager)', async () => {
    const secrets = new Map<string, string>();
    const manager = new PairingManager({
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    });
    const offer = await manager.begin('wss://relay.example');
    expect(parseQrPayload(offer.qr).rid).toBe(offer.rid);
  });

  // NOTHING IS TYPED FIRST (2026-09-06). The pairing PIN is gone, so a bare
  // remotePair with no fields is the whole gesture and must reach the
  // controller — a leftover validator would refuse the only message the pane
  // now sends.
  it('a remotePair carrying no fields at all still mints a code', async () => {
    const recorded = useFakeController();
    fake.settings.set('enabled', true);
    await handleRemotePaneMessage(host, { type: 'remotePair' });

    expect(recorded.pairs).toBe(1);
    expect(lastOf('remoteQr')).toBeTruthy();
    expect((lastOf('remoteData') as { error?: string }).error).toBeUndefined();
  });

  it("a controller refusal is shown in the controller's own words", async () => {
    registerRemoteControl({
      enabled: () => true,
      target: () => ({
        connected: false,
        rid: null,
        modes: [],
        pair: async () => {
          throw new Error('origami remote: enable origamicoder.remote.enabled first');
        },
        revoke: async () => {},
      }),
    });
    await handleRemotePaneMessage(host, { type: 'remotePair' });
    expect((lastOf('remoteData') as { error?: string }).error).toBe(
      'origami remote: enable origamicoder.remote.enabled first',
    );
  });

  it('revoke calls the controller and re-posts', async () => {
    const recorded = useFakeController();
    fake.settings.set('enabled', true);
    await handleRemotePaneMessage(host, { type: 'remoteRevoke' });

    expect(recorded.revokes).toEqual(['revoked from the Remote pane']);
    expect(lastOf('remoteData')).toBeDefined();
  });
});

describe('remotePane host — the connection snapshot', () => {
  it('distinguishes off / unpaired / pending / connecting / paired', () => {
    fake.settings.set('enabled', false);
    useFakeController({ rid: null });
    expect(remotePayload().connection).toBe('off');

    fake.settings.set('enabled', true);
    expect(remotePayload().connection).toBe('unpaired');

    // THE BUG. A code has been shown, so there is a rid, and the desktop's own
    // relay socket is OPEN because that socket is how the phone will reach it.
    // Reading `connected` here said "paired" and hid the QR.
    resetRemoteControl();
    useFakeController({ rid: RID, connected: true, confirmed: false });
    expect(remotePayload().connection).toBe('pending');

    resetRemoteControl();
    useFakeController({ rid: RID, connected: false });
    expect(remotePayload().connection).toBe('connecting');

    resetRemoteControl();
    useFakeController({ rid: RID, connected: true });
    expect(remotePayload().connection).toBe('paired');
  });

  it('pairedAt is the CONFIRM time from the controller, never the offer-mint time', () => {
    fake.settings.set('enabled', true);
    useFakeController({ rid: RID, connected: true, confirmed: false });
    // An unanswered code has no pairing time. "paired 0s ago" was this lie.
    expect(remotePayload().pairedAt).toBeNull();

    resetRemoteControl();
    useFakeController({ rid: RID, connected: true, confirmed: true, confirmedAt: 1_699_999_000_000 });
    expect(remotePayload().pairedAt).toBe(1_699_999_000_000);
  });

  it('the controller status line is carried through verbatim, and stamps last-seen', () => {
    fake.settings.set('enabled', true);
    useFakeController({ rid: RID, connected: true });
    expect(remotePayload().lastSeen).toBeNull();

    noteRemoteStatus('remote: rejected a frame (replay)');
    const payload = remotePayload();
    expect(payload.detail).toBe('remote: rejected a frame (replay)');
    expect(payload.lastSeen).not.toBeNull();
  });
});

// -------------------------------------------------------------- webview --
//
// Mock F2 (Downloads/remote-ui-mockups/f2-candidate.html, the one the owner
// picked): a status strip, then a grid — the story card with the master switch,
// the pair column beside it running the full height, and two reference cards
// under the story. jsdom has no layout engine, so this asserts TEXT, CLASS and
// POSTED MESSAGES — never a computed colour, size or position. What the shape
// looks like is a screenshot's job, and the harness scene `remote` is where it
// is done (webview/dashboard/__tests__/screenshotHarness.ts).

/** The device key an app phone enrolled. `fp` is a real 43-character base64url
 *  SHA-256, because the pane's whole promise is that the owner can compare
 *  every character of it with the app's Settings screen. */
const DEVICE = {
  name: "Sam's iPhone",
  fp: 'k3Y8mS1vQ4hZ2pR7tX0bN6cJ9wL5aD3fG8uE1iO4yTc',
  platform: 'ios',
  app: '1.0 (1)',
  backend: 'secure-enclave',
};

const DATA = {
  type: 'remoteData',
  enabled: true,
  relayUrl: 'wss://relay.example',
  connection: 'paired' as const,
  rid: 'abcdef0123456789',
  deviceName: '',
  pairedAt: Date.now() - 10_800_000,
  lastSeen: Date.now() - 120_000,
  detail: 'remote: phone paired',
  device: null as typeof DEVICE | null,
  capability: 'full' as 'watch' | 'ask' | 'full',
  modes: [] as Array<{ sessionId: string; mode: string; device: string; fp: string; at: number }>,
};
const OFF = { ...DATA, enabled: false, connection: 'off' as const, rid: null, pairedAt: null, lastSeen: null };
const UNPAIRED = { ...DATA, connection: 'unpaired' as const, rid: null, pairedAt: null, lastSeen: null };
/** A code is on screen. There IS a rid and the desktop's own relay socket is
 *  open — that socket is how the phone will find it — and no phone has
 *  answered. This is the state the pane had no name for. */
const PENDING = { ...DATA, connection: 'pending' as const, pairedAt: null, lastSeen: null };
/** The pairing is real and ANOTHER VS Code window holds the relay socket. The
 *  pane had no name for this either, and rendered it as "reconnecting" for ever
 *  — a network fault, for a state that is not one. */
const ELSEWHERE = { ...DATA, connection: 'other-window' as const };

function send(msg: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
  return tick();
}
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('RemotePane — the status strip', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('asks for its state on mount', () => {
    render(RemotePane);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'remoteRequest' });
  });

  // MUTATION PROOF — the strip is the ONE line that answers "can my phone reach
  // this machine". A pane that renders the same pill in every state, or that
  // shows a green "Paired" while the socket is down, passes nothing here.
  it('MUTATION PROOF — says the whole state in one pill, differently per state', async () => {
    const { container } = render(RemotePane);

    await send(OFF);
    expect(text(container.querySelector('.pill[data-state]'))).toBe('Off');
    expect(container.querySelector('.pill[data-state="off"]')!.className).toContain('off');

    await send(UNPAIRED);
    expect(text(container.querySelector('.pill[data-state]'))).toBe('On · not paired');
    // Waiting, not achieved: an unpaired pane must not wear the paired tone.
    expect(container.querySelector('.pill[data-state="unpaired"]')!.className).toContain('wait');
    expect(container.querySelector('.pill[data-state="unpaired"]')!.className).not.toContain('ok');

    // A code that is merely SHOWING is not a device. The old model had no word
    // for this and borrowed "paired", which is the whole bug.
    await send(PENDING);
    expect(text(container.querySelector('.pill[data-state]'))).toBe('On · waiting for a phone');
    expect(container.querySelector('.pill[data-state="pending"]')!.className).not.toContain('ok');

    await send(DATA);
    expect(text(container.querySelector('.pill[data-state]'))).toBe('Paired · abcdef01… · 2 min ago');
    expect(container.querySelector('.pill[data-state="paired"]')!.className).toContain('ok');

    // A pairing whose socket is DOWN is not a green pill. It is the one state
    // where "paired" and "reachable" disagree, and the pill says which.
    await send({ ...DATA, connection: 'connecting' });
    expect(text(container.querySelector('.pill[data-state]'))).toBe('Paired · abcdef01… · reconnecting');
    expect(container.querySelector('.pill[data-state="connecting"]')!.className).toContain('wait');
  });

  // The shield pill states the ENVELOPE. It used to state the approvals policy;
  // that setting went with the PIN, and the envelope is now the only thing that
  // bounds what a phone may do, so it is what the strip has to say.
  it('states the relay HOST, the desk envelope and the device count beside it', async () => {
    const { container } = render(RemotePane);
    await send(DATA);
    const pills = Array.from(container.querySelectorAll('.pills .pill')).map(text);
    expect(pills).toEqual(['Paired · abcdef01… · 2 min ago', 'relay.example', 'Full', '1 device']);

    await send({ ...UNPAIRED, capability: 'watch' });
    const off = Array.from(container.querySelectorAll('.pills .pill')).map(text);
    expect(off).toEqual(['On · not paired', 'relay.example', 'Watch', 'No device']);

    // "1 device" while a code waits unanswered is the phantom, counted.
    await send(PENDING);
    expect(Array.from(container.querySelectorAll('.pills .pill')).map(text).at(-1)).toBe('No device');
  });

  it("carries the controller's own status line verbatim — it names the real failure", async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, detail: 'remote: rejected a frame (replay)' });
    expect(text(container.querySelector('.remote-detail'))).toBe('remote: rejected a frame (replay)');
  });
});

describe('RemotePane — the pair column', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('changes its face with the state, and offers ONE primary action in each', async () => {
    const { container } = render(RemotePane);

    await send(OFF);
    expect(text(container.querySelector('.hero-h'))).toBe('No phone paired');
    expect(text(container.querySelector('[data-primary]'))).toBe('Pair a phone');

    await send(UNPAIRED);
    expect(text(container.querySelector('.hero-h'))).toBe('No phone paired');
    expect(text(container.querySelector('[data-primary]'))).toBe('Pair a phone');

    await send(DATA);
    expect(text(container.querySelector('.hero-h'))).toBe('A phone is paired');
    expect(text(container.querySelector('[data-primary]'))).toBe('Pair another phone');

    // The accent fill is spent on exactly one control, in every state.
    for (const state of [OFF, UNPAIRED, DATA]) {
      await send(state);
      expect(container.querySelectorAll('[data-primary]')).toHaveLength(1);
    }
  });

  // THE BOX NEVER GOES BLANK. It is the tallest thing on the page, and an empty
  // one in the state a reader is MOST likely to arrive in — nothing paired — is
  // the dead space two rounds of mockups were rejected for.
  it('MUTATION PROOF — the code box says something in every state, and it is not the same something', async () => {
    const { container } = render(RemotePane);

    await send(UNPAIRED);
    expect(container.querySelector('.code .qr.ghost')).not.toBeNull();
    expect(text(container.querySelector('.code .caps'))).toBe('How pairing goes');
    expect(container.querySelectorAll('.code .steps li')).toHaveLength(3);
    expect(text(container.querySelector('.code .note'))).toContain('Pair a phone to show a code');

    // Attached with no code live: the same box carries WHICH phone, so the
    // column is not a placeholder for a code nobody is waiting for.
    await send({ ...DATA, device: DEVICE });
    expect(text(container.querySelector('.code .said .who'))).toBe('abcdef01…');
    expect(text(container.querySelector('.code .said .kmeta'))).toBe('ios · 1.0 (1)');
    expect(text(container.querySelector('.code .note'))).toContain('Pair another phone');

    // A live code takes the box back, and the ghost square goes with it.
    await send({ type: 'remoteQr', svg: '<svg id="pairing-code"></svg>', expiresAt: Date.now() + 60_000 });
    expect(container.querySelector('.code .qr.ghost')).toBeNull();
    expect(container.querySelector('.code .qr svg')).not.toBeNull();
    expect(container.querySelector('.code .said')).toBeNull();
  });

  // THE GATE IN FRONT OF THE QR IS GONE. Until 2026-09-06 the button was
  // disabled until four digits had been typed into a box beside it. There is no
  // box and no disabled state: pressing the button IS the gesture, in every
  // state that offers it.
  it('offers the code with nothing typed first, and no PIN box anywhere', async () => {
    const { container } = render(RemotePane);
    await send(UNPAIRED);
    const primary = container.querySelector('[data-primary]') as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    expect(container.querySelector('.pin')).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();

    await send(DATA);
    expect((container.querySelector('[data-primary]') as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('.pin')).toBeNull();
  });

  // MUTATION PROOF — the live sequence, in order. handleRemotePaneMessage posts
  // `remoteQr` and then IMMEDIATELY re-posts `remoteData`; against a live relay
  // the desktop's own socket is already open by then. Under the old mapping
  // that second message said `paired`, the column swapped to the summary face
  // and the QR the owner was about to scan vanished in the same frame. Any
  // regression that lets a mere offer read as attached fails here.
  it('MUTATION PROOF — the QR SURVIVES the remoteData that follows it', async () => {
    const { container } = render(RemotePane);
    await send(UNPAIRED);
    await fireEvent.click(container.querySelector('[data-primary]')!);

    await send({ type: 'remoteQr', svg: '<svg id="pairing-code"></svg>', expiresAt: Date.now() + 60_000 });
    await send(PENDING); // <- the state the host really reports a millisecond later

    expect(container.querySelector('.code .qr svg')).not.toBeNull();
    expect(text(container.querySelector('.hero-h'))).toBe('No phone paired');
    // No device anywhere: not in the code box, not in the Your phone card.
    expect(container.querySelector('.code .said')).toBeNull();
    expect(text(container.querySelector('.card .empty'))).toContain('No device is paired');

    // ...and the moment a phone DOES answer, the face changes under the code.
    await send(DATA);
    expect(text(container.querySelector('.hero-h'))).toBe('A phone is paired');
    expect(container.querySelector('.row .name')).not.toBeNull();
  });

  it('keeps asking while a code is unanswered, so a scan is not missed', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(RemotePane);
      await send(PENDING);
      globalThis.__vscodeApiMock.postMessage.mockClear();
      await vi.advanceTimersByTimeAsync(4_100);
      await tick();
      expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'remoteRequest' });

      // Once a phone is on, the polling stops: it exists only for the window.
      await send(DATA);
      globalThis.__vscodeApiMock.postMessage.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      await tick();
      expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
      expect(container).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the pair button posts remotePair, and the returned QR renders with a clock', async () => {
    const { container } = render(RemotePane);
    await send(UNPAIRED);

    await fireEvent.click(container.querySelector('[data-primary]')!);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'remotePair' });

    await send({ type: 'remoteQr', svg: '<svg id="pairing-code"></svg>', expiresAt: Date.now() + 60_000 });
    expect(container.querySelector('.code .qr svg')).not.toBeNull();
    expect(text(container.querySelector('.code .live'))).toBe('A code is live · expires in 1:00');
  });

  // m:ss, not a bare number: a minute-long window is a clock, and "8" alone
  // does not say whether it is seconds or something else.
  it('the sixty-second clock really counts down in m:ss — fake timers, real ticks', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(RemotePane);
      await send(UNPAIRED);
      await send({ type: 'remoteQr', svg: '<svg id="pairing-code"></svg>', expiresAt: Date.now() + 60_000 });
      expect(text(container.querySelector('.code .live'))).toBe('A code is live · expires in 1:00');

      await vi.advanceTimersByTimeAsync(5_000);
      await tick();
      expect(text(container.querySelector('.code .live'))).toBe('A code is live · expires in 0:55');

      // Past the window the code is not a dead QR left on screen; it says so,
      // and the box falls back to the face it had before the press.
      await vi.advanceTimersByTimeAsync(56_000);
      await tick();
      expect(container.querySelector('.code .live')).toBeNull();
      expect(container.textContent).toContain('The code expired');
      expect(container.querySelector('.code .qr.ghost')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The owner asked for a by-eye check against what the app shows after
  // scanning: the same host[:port] string, next to the QR, nowhere else.
  it('shows the relay origin next to the QR, and only while a code is live', async () => {
    const { container } = render(RemotePane);
    await send(UNPAIRED);
    expect(container.querySelector('.relay-check')).toBeNull();

    await send({
      type: 'remoteQr', svg: '<svg id="pairing-code"></svg>', expiresAt: Date.now() + 60_000,
      relayOrigin: 'https://relay.origamilabs.nl',
    });
    expect(text(container.querySelector('.relay-check'))).toContain('https://relay.origamilabs.nl');
    expect(text(container.querySelector('.relay-check'))).toContain(
      'This must match the relay the app shows after the scan.',
    );

    // A non-default relay with a port keeps it, verbatim.
    await send({
      type: 'remoteQr', svg: '<svg id="pairing-code"></svg>', expiresAt: Date.now() + 60_000,
      relayOrigin: 'https://relay.example.org:8443',
    });
    expect(text(container.querySelector('.relay-check'))).toContain('https://relay.example.org:8443');
  });

  it('the step that names the app links out to it, as a constant and not a setting', async () => {
    const { container } = render(RemotePane);
    await send(UNPAIRED);
    const app = container.querySelector('.code .applink') as HTMLAnchorElement;
    expect(text(app)).toBe('Origami Remote');
    expect(app.getAttribute('href')).toBe(REMOTE_APP_URL);
    // Until the App Store listing is live the step says so beside the link (t-2e9wjt).
    expect(text(container.querySelector('.code .soon'))).toBe('coming soon');
    expect(app.getAttribute('rel')).toContain('noopener');
    expect(REMOTE_APP_URL).toMatch(/^https:\/\//);
  });
});

// ---------------------------------------------------------- the story card --
//
// The owner's ask: "we need to make clear what's being offered here and its
// limitations". The card is the four explainer pages of the phone app cut to a
// line each, two lists of the same length, and the switch the whole feature
// hangs off — on the card's own head row, because this card is the argument for
// pressing it.

describe('RemotePane — the story card', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('carries the master switch, its label and the consequence of each position', async () => {
    const { container } = render(RemotePane);

    await send(DATA);
    const toggle = container.querySelector('.story .sw input') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(text(container.querySelector('.story .sw-label'))).toBe('Remote is on');
    expect(text(container.querySelector('.story .sw-state'))).toBe(
      'One sealed socket to your relay. No account, no telemetry, nothing leaves but sealed frames.',
    );

    await send(OFF);
    expect((container.querySelector('.story .sw input') as HTMLInputElement).checked).toBe(false);
    expect(text(container.querySelector('.story .sw-label'))).toBe('Remote is off');
    expect(text(container.querySelector('.story .sw-state'))).toBe(
      'Nothing is constructed, no socket is opened, no secret is read.',
    );
  });

  it('the switch posts remoteSetEnabled with the new value', async () => {
    const { container } = render(RemotePane);
    await send(DATA);
    const toggle = container.querySelector('.story .sw input') as HTMLInputElement;

    await fireEvent.click(toggle);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'remoteSetEnabled', enabled: false });
  });

  it('states the four things Remote is, in the app’s own order', async () => {
    const { container } = render(RemotePane);
    await send(DATA);
    const rows = Array.from(container.querySelectorAll('.story .st-row'));
    expect(rows.map((r) => text(r.querySelector('.st-t')))).toEqual([
      'Your desktop, in your pocket.',
      'A locked box, passed hand to hand.',
      'A key that cannot be copied.',
      'You decide how much it may do.',
    ]);
    expect(text(rows[2])).toContain('never leaves it, not even for the app');
  });

  // MUTATION PROOF — the exact lists. A pane that quietly drops "no tools run
  // on the phone" is a pane that oversells a remote control, and one that keeps
  // "a phone browser, not an app" is a pane that is lying: the iOS app shipped.
  it('MUTATION PROOF — states what it does and what it does not, in full', async () => {
    const { container } = render(RemotePane);
    await send(DATA);

    const heads = Array.from(container.querySelectorAll('.story .cols2 h4')).map((h) => h.textContent?.trim());
    expect(heads).toEqual(['It does', 'It does not']);

    const lists = container.querySelectorAll('.story .cols2 ul');
    expect(Array.from(lists[0].querySelectorAll('li')).map((li) => li.textContent?.trim())).toEqual([
      'The live chat, mirrored — the same transcript the desktop is showing.',
      'Send a prompt from the phone.',
      'Stop a turn that is going wrong.',
      "Approve a permission the desktop waits on, signed by the phone's key.",
      'Switch a chat between Ask and YOLO.',
      'Switch the model and the session.',
    ]);
    expect(Array.from(lists[1].querySelectorAll('li')).map((li) => li.textContent?.trim())).toEqual([
      'No file access and no editor on the phone — you read the chat, you do not open the repo.',
      'No tools run on the phone — every command, edit and search runs on the desktop.',
      'Away from your own network it needs a relay — two devices behind NAT cannot meet without one.',
      'One phone per pairing — a second phone needs a new code.',
      'A lost key means pairing again.',
    ]);
  });

  it('is shown in FULL with Remote off — it is how you decide to turn it on', async () => {
    const { container } = render(RemotePane);
    await send(OFF);
    expect(container.querySelectorAll('.story .st-row')).toHaveLength(4);
    expect(container.querySelectorAll('.story .cols2 li')).toHaveLength(11);
  });
});

describe('RemotePane — the relay card', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('prints the relay sees / does-not-see table VERBATIM, under the relay field', async () => {
    const { container } = render(RemotePane);
    await send(DATA);

    const cells = Array.from(container.querySelectorAll('.remote-relay-table td')).map((c) => c.textContent?.trim());
    expect(cells).toEqual([
      'A random rendezvous id, connect and disconnect times, padded frame counts',
      'Prompts, replies, file paths, diffs, tool names, repo names, model names, who the user is',
    ]);
    const heads = Array.from(container.querySelectorAll('.remote-relay-table th')).map((c) => c.textContent?.trim());
    expect(heads).toEqual(['Sees', 'Does not see']);
    // Under the field, not above it: the table exists to inform the decision
    // the field IS, so reading order matters.
    const table = container.querySelector('.remote-relay-table')!;
    const input = container.querySelector('.relay-row .inp')!;
    expect(input.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The picture says the same thing as the table, before the table is read. Its
  // captions are REAL TEXT beside decorative glyphs — the 670px role="img" this
  // replaces read as one paragraph to a screen reader.
  it('draws the sealed path as three stages, with the relay as the blind one', async () => {
    const { container } = render(RemotePane);
    await send(DATA);

    const caps = Array.from(container.querySelectorAll('.hdia .hcap')).map(text);
    expect(caps).toEqual([
      'Your phonekey in the chip',
      'Relaycannot open them',
      'Your desktopchecks the key',
    ]);
    expect(Array.from(container.querySelectorAll('.hdia .hseal')).map(text)).toEqual(['sealed', 'sealed']);
    const tiles = Array.from(container.querySelectorAll('.hdia .htile'));
    expect(tiles.map((t) => t.className.includes('blind'))).toEqual([false, true, false]);
  });

  // ONE link, and no command. The first round of mockups printed the self-host
  // command with our own ports on it and the owner rejected the round: an
  // address, a picture, two rows and a guide link is the whole card.
  it('links out to the self-host guide and to nothing else, with no ports on the page', async () => {
    const { container } = render(RemotePane);
    await send(DATA);

    const links = Array.from(container.querySelectorAll('.rx-link')) as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([REMOTE_SELF_HOST_URL]);
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Run your own relay — guide']);
    // Opened by VS Code in the real browser, never navigated inside the panel.
    for (const a of links) expect(a.getAttribute('rel')).toContain('noopener');
    expect(container.textContent).not.toMatch(/docker|--daily|--ring|:8\d{3}/);
  });

  it('the destination is a constant, not a setting that could be blank', () => {
    expect(REMOTE_SELF_HOST_URL).toBe('https://github.com/PassingByPixels/origami-relay');
  });

  it('a relay edit is not clobbered by an unrelated re-broadcast, and Save posts the draft', async () => {
    const { container } = render(RemotePane);
    await send(DATA);
    const input = container.querySelector('.relay-row .inp') as HTMLInputElement;
    expect(input.value).toBe('wss://relay.example');
    expect((container.querySelector('.relay-row .btn') as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.input(input, { target: { value: 'wss://my-own-relay.test' } });
    await send(DATA); // some other control caused a re-read
    expect((container.querySelector('.relay-row .inp') as HTMLInputElement).value).toBe('wss://my-own-relay.test');

    await fireEvent.click(container.querySelector('.relay-row .btn')!);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'remoteSetRelayUrl',
      url: 'wss://my-own-relay.test',
    });
  });
});

describe('RemotePane — the Your phone card', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('shows the paired device with a Revoke that posts remoteRevoke', async () => {
    const { container } = render(RemotePane);
    await send(DATA);

    expect(text(container.querySelector('.row .name'))).toBe('abcdef01…');
    expect(text(container.querySelector('.row .meta'))).toBe('paired 3h ago · last seen 2 min ago');
    await fireEvent.click(container.querySelector('.row .btn.danger')!);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'remoteRevoke' });
  });

  it('with nothing paired it says so instead of rendering an empty device row', async () => {
    const { container } = render(RemotePane);
    await send(UNPAIRED);
    expect(container.querySelector('.row .name')).toBeNull();
    expect(container.textContent).toContain('No device is paired');
  });
});

// ------------------------------------------------- what the rebuild removed --
//
// Each of these was on the pane before mock F2 and is gone on purpose. A test
// per removal, because the way any of them comes back is a merge that "restores"
// a card nobody meant to restore.

describe('RemotePane — what mock F2 removed stays removed', () => {
  it('has no Privilege card, no chat-mode audit and no disclosure folds', async () => {
    const { container } = render(RemotePane);
    await send({
      ...DATA,
      device: DEVICE,
      modes: [{ sessionId: 'sess-42', mode: 'yolo', device: "Sam's iPhone", fp: 'IDui2o9L', at: 1_700_000_000_000 }],
    });

    // The envelope is the status pill's job now, and only the pill's.
    expect(text(container.querySelector('.pills .pill:nth-child(3)'))).toBe('Full');
    expect(container.querySelector('.env-text')).toBeNull();
    expect(container.querySelector('.mode-row')).toBeNull();
    expect(container.querySelector('.no-modes')).toBeNull();
    // The two "What you get / what it is not" folds became the story card's
    // two plain lists; the ONLY <details> left is the key fingerprint.
    expect(container.querySelector('.rx-disc')).toBeNull();
    const folds = Array.from(container.querySelectorAll('details'));
    expect(folds).toHaveLength(1);
    expect(folds[0]!.classList.contains('fpd')).toBe(true);
  });

  it('never calls the phone a browser page, and never asks for a PIN', async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, device: DEVICE });
    const words = (container.textContent ?? '').toLowerCase();
    expect(words).not.toContain('browser');
    expect(words).not.toMatch(/\bpins?\b/);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  // OFF is not a different page: the three cards that only mean something while
  // a socket can exist go quiet, and the story card — which holds the switch
  // that turns this back on — keeps its full contrast.
  it('quiets the pair, phone and relay cards with Remote off, and leaves the story alone', async () => {
    const { container } = render(RemotePane);

    await send(DATA);
    expect(container.querySelector('.remote-pane')!.classList.contains('off')).toBe(false);

    await send(OFF);
    expect(container.querySelector('.remote-pane')!.classList.contains('off')).toBe(true);
    expect(container.querySelector('.story')).not.toBeNull();
    expect(container.querySelector('.hero')).not.toBeNull();
  });
});

// ------------------------------------------------------- the pane's words --
//
// Pure functions, asserted without a DOM. Every one of them is a sentence the
// owner reads as the whole truth about the feature, so the wording is held
// here rather than only inside a render.

describe('remoteFormat', () => {
  it('relayHost shows the host, and a half-typed URL as itself', () => {
    expect(relayHost('wss://relay.origamilabs.nl')).toBe('relay.origamilabs.nl');
    expect(relayHost('wss://relay.example:8443/x')).toBe('relay.example:8443');
    // Half-typed, no scheme yet: `new URL` throws and the box must still
    // show what the user is typing rather than going blank.
    expect(relayHost('relay.exa')).toBe('relay.exa');
    expect(relayHost('')).toBe('');
  });

  it('ago counts in seconds, then minutes, then hours — and says never for nothing', () => {
    const now = Date.now();
    expect(ago(null)).toBe('never');
    expect(ago(0)).toBe('never');
    expect(ago(now - 5_000)).toBe('5s ago');
    expect(ago(now - 120_000)).toBe('2 min ago');
    expect(ago(now - 10_800_000)).toBe('3h ago');
    // A clock that went backwards must not print a negative age.
    expect(ago(now + 10_000)).toBe('0s ago');
  });

  it('ridPrefix says it IS a prefix, and is empty when there is no pairing', () => {
    expect(ridPrefix('abcdef0123456789')).toBe('abcdef01…');
    expect(ridPrefix(null)).toBe('');
  });
});

// ------------------------------------------------------------ device names --
//
// The owner's ask: "just need to be able to name the device after the
// connection so it has its ID string but also its human-readable name."
//
// The phone never sends a name, so the whole feature is desktop-side: a string
// the owner typed, kept in globalState against the rid, shown BESIDE the rid.
// These assert that it is stored, that it comes back after the window that
// stored it is gone, and that it dies with the pairing it names.

function useFakeNames(seed: Record<string, string> = {}): Record<string, unknown> {
  // One backing object, standing in for the globalState FILE. Re-registering a
  // fresh store over it is what a window reload looks like from here.
  const disk: Record<string, unknown> = { 'origami.remote.deviceNames': { ...seed } };
  registerDeviceNames({
    get: <T,>(key: string, fallback: T): T => (key in disk ? (disk[key] as T) : fallback),
    update: async (key: string, value: unknown) => void (disk[key] = value),
  });
  return disk;
}

describe('remote device names — the host store', () => {
  beforeEach(() => resetDeviceNames());
  afterEach(() => resetDeviceNames());

  it('MUTATION PROOF — a rename is stored against THIS rid and comes back after a reload', async () => {
    const disk = useFakeNames();
    fake.settings.set('enabled', true);
    useFakeController({ rid: RID, connected: true });

    await handleRemotePaneMessage(host, { type: 'remoteSetDeviceName', rid: RID, name: '  Bertha  ' });

    // Stored under the rid, trimmed — not under a constant, and not verbatim.
    expect(disk['origami.remote.deviceNames']).toEqual({ [RID]: 'Bertha' });
    expect(lastOf('remoteData')).toMatchObject({ rid: RID, deviceName: 'Bertha' });
    // A name filed under some other rid is not this pairing's name. A store
    // that ignored the key, or kept one name for every device, fails here.
    expect(deviceNameFor('some-other-rid')).toBe('');

    // THE RELOAD. The module forgets everything it held; a new window registers
    // a new store over the same file and the name is still there.
    resetDeviceNames();
    expect(deviceNameFor(RID)).toBe('');
    registerDeviceNames({
      get: <T,>(key: string, fallback: T): T => (key in disk ? (disk[key] as T) : fallback),
      update: async (key: string, value: unknown) => void (disk[key] = value),
    });
    expect(deviceNameFor(RID)).toBe('Bertha');
  });

  it('the message table names the seven messages the pane sends, plus the group card routed through it', () => {
    // t-rz1b14: the device group is the same pane's second half, routed from
    // remotePane.ts into the groupPane.ts leaf so DashboardPanel keeps ONE
    // remote entry point. Its seven names are listed here for the same reason
    // the remote seven are: a type that appears without a decision is a route
    // nobody chose.
    // t-s9jr6u: the group's host half still routes here, and grew the Nests
    // switch and the invite Cancel — though its card now lives in the Nests view.
    expect([...REMOTE_PANE_MESSAGE_TYPES].sort()).toEqual([
      'groupAnswerJoin',
      'groupCancelInvite',
      'groupForget',
      'groupInvite',
      'groupJoin',
      'groupRemoveDevice',
      'groupRenameDevice',
      'groupRequest',
      'groupSetEnabled',
      'groupSetMotherBase',
      'remotePair',
      'remoteRequest',
      'remoteRevoke',
      'remoteSetDeviceName',
      'remoteSetEnabled',
      'remoteSetRelayUrl',
      'remoteTakeOver',
    ]);
  });

  it('an empty name FORGETS rather than storing a blank, so the row falls back to the rid', async () => {
    const disk = useFakeNames({ [RID]: 'Bertha' });
    fake.settings.set('enabled', true);
    useFakeController({ rid: RID, connected: true });

    await handleRemotePaneMessage(host, { type: 'remoteSetDeviceName', rid: RID, name: '   ' });
    expect(disk['origami.remote.deviceNames']).toEqual({});
    expect(lastOf('remoteData')).toMatchObject({ deviceName: '' });
  });

  it('a name is one trimmed line, capped, and the two trees agree on the cap', async () => {
    const disk = useFakeNames();
    await handleRemotePaneMessage(host, {
      type: 'remoteSetDeviceName',
      rid: RID,
      name: `  the\n  kitchen   phone  ${'x'.repeat(60)}`,
    });
    const stored = (disk['origami.remote.deviceNames'] as Record<string, string>)[RID];
    expect(stored).toBe(`the kitchen phone ${'x'.repeat(60)}`.slice(0, DEVICE_NAME_MAX));
    expect(stored).toHaveLength(DEVICE_NAME_MAX);
    expect(stored).not.toContain('\n');
    // The webview enforces the same limit on its own input, and cannot import
    // the host's constant (TS6059 across the rootDir boundary). Held equal here,
    // in the one file that can see both.
    expect(PANE_DEVICE_NAME_MAX).toBe(DEVICE_NAME_MAX);
  });

  it('revoking forgets the name — a rid is never reused, so a kept name is dead weight', async () => {
    const disk = useFakeNames({ [RID]: 'Bertha' });
    fake.settings.set('enabled', true);
    useFakeController({ rid: RID, connected: true });

    await handleRemotePaneMessage(host, { type: 'remoteRevoke' });
    expect(disk['origami.remote.deviceNames']).toEqual({});
  });

  it('switching Remote OFF revokes, and takes the name with it', async () => {
    const disk = useFakeNames({ [RID]: 'Bertha' });
    fake.settings.set('enabled', true);
    useFakeController({ rid: RID, connected: true });

    await handleRemotePaneMessage(host, { type: 'remoteSetEnabled', enabled: false });
    expect(disk['origami.remote.deviceNames']).toEqual({});
  });

  it('a window that never activated Remote answers "no name" instead of throwing', async () => {
    useFakeController();
    expect(deviceNameFor(RID)).toBe('');
    await expect(setDeviceName(RID, 'Bertha')).resolves.toBeUndefined();
    await handleRemotePaneMessage(host, { type: 'remoteRequest' });
    expect(lastOf('remoteData')).toMatchObject({ deviceName: '' });
  });

  it('a globalState value of the wrong shape is treated as absent, never trusted', () => {
    registerDeviceNames({
      get: <T,>(_key: string, _fallback: T): T => ['not', 'an', 'object'] as unknown as T,
      update: async () => {},
    });
    expect(deviceNameFor(RID)).toBe('');
  });
});

describe('remotePane host — the enrolled device key', () => {
  it('carries the device through the snapshot, and null when no key is enrolled', async () => {
    fake.settings.set('enabled', true);
    useFakeController({ device: DEVICE });
    await handleRemotePaneMessage(host, { type: 'remoteRequest' });
    expect(lastOf('remoteData')).toMatchObject({ device: DEVICE });

    resetRemoteControl();
    posts.length = 0;
    useFakeController();
    await handleRemotePaneMessage(host, { type: 'remoteRequest' });
    expect(lastOf('remoteData')).toMatchObject({ device: null });
  });

  // The PUBLIC KEY never reaches the webview. The fingerprint is what a person
  // compares; the 65-byte point has no reader outside the verifier, and a value
  // the pane cannot use is a value the pane should not be handed.
  it('hands the webview a fingerprint and no public key', async () => {
    fake.settings.set('enabled', true);
    useFakeController({ device: DEVICE });
    await handleRemotePaneMessage(host, { type: 'remoteRequest' });
    const payload = lastOf('remoteData') as { device: Record<string, unknown> };
    expect(Object.keys(payload.device).sort()).toEqual(['app', 'backend', 'fp', 'name', 'platform']);
  });
});

describe('RemotePane — the enrolled device key', () => {
  beforeEach(() => {
    globalThis.__vscodeApiMock.getState.mockReturnValue(undefined);
    globalThis.__vscodeApiMock.setState.mockClear();
  });

  it('shows the phone name, platform, app, the backend badge and the FULL fingerprint', async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, device: DEVICE });

    expect(text(container.querySelector('.key .who'))).toBe("Sam's iPhone");
    expect(text(container.querySelector('.key .meta'))).toBe('ios · 1.0 (1)');
    expect(text(container.querySelector('.key .badge'))).toBe('Secure Enclave');
    // ALL 43 characters, not a prefix: a truncated fingerprint cannot be
    // compared, which is the only thing this block is for.
    const fp = container.querySelector('.key .fp')!;
    expect(text(fp)).toBe(DEVICE.fp);
    expect(text(fp)).toHaveLength(43);
  });

  it('names a software key as a software key, so the weaker backend is not silent', async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, device: { ...DEVICE, backend: 'software' } });
    expect(text(container.querySelector('.key .badge'))).toBe('software key');
    expect(container.querySelector('.key .badge')!.classList.contains('enclave')).toBe(false);
  });

  it('copies the whole fingerprint to the clipboard and says it did', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } },
    });
    const { container } = render(RemotePane);
    await send({ ...DATA, device: DEVICE });

    await fireEvent.click(container.querySelector('.key .icon-btn')!);
    await tick();
    expect(written).toEqual([DEVICE.fp]);
    expect(text(container.querySelector('.key .said'))).toBe('Copied');
  });

  it('draws no key block at all when nothing is enrolled — a pairing with no key has none', async () => {
    const { container } = render(RemotePane);
    await send(DATA);
    expect(container.querySelector('.key')).toBeNull();
    // ...and the row it lives in is still there.
    expect(container.querySelector('.row .name')).not.toBeNull();
  });

  // THE FOLD OPENS BY DEFAULT. Comparing 43 characters is a thing you do once
  // per phone; a fingerprint nobody ever opened is a fingerprint nobody ever
  // compared, so the fold has to earn its closure rather than start closed.
  it('opens the fingerprint fold by default, and says what folding it means', async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, device: DEVICE });
    const fold = container.querySelector('.key details') as HTMLDetailsElement;
    expect(fold.open).toBe(true);
    expect(text(fold.querySelector('summary'))).toBe('Key fingerprint fold after you have compared it');
  });

  it('writes the fold against THIS rid, beside every other pane key in the bag', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ 'board.tab': 'remote' });
    const { container } = render(RemotePane);
    await send({ ...DATA, device: DEVICE });

    const fold = container.querySelector('.key details') as HTMLDetailsElement;
    fold.open = false;
    await fireEvent(fold, new Event('toggle'));

    expect(globalThis.__vscodeApiMock.setState).toHaveBeenCalledWith({
      'board.tab': 'remote',
      [REMOTE_FOLD_KEY]: { 'abcdef0123456789': false },
    });
  });

  // MUTATION PROOF for the "per pairing" half: a fold remembered globally would
  // hide the NEXT phone's fingerprint before it had ever been compared, which
  // is the one thing this block exists to let the owner do.
  it('MUTATION PROOF — a folded pairing stays folded, and the next phone arrives open', async () => {
    globalThis.__vscodeApiMock.getState.mockReturnValue({ [REMOTE_FOLD_KEY]: { 'abcdef0123456789': false } });
    const { container } = render(RemotePane);

    await send({ ...DATA, device: DEVICE });
    expect((container.querySelector('.key details') as HTMLDetailsElement).open).toBe(false);

    await send({ ...DATA, rid: 'ffffffff11112222', device: DEVICE });
    expect((container.querySelector('.key details') as HTMLDetailsElement).open).toBe(true);
  });
});

// The persistence itself, without a DOM: which pairings were folded away, over
// the state bag every pane on this board shares.
describe('remoteFoldState', () => {
  it('is OPEN for an empty bag, a bag of the wrong shape and an unseen rid', () => {
    expect(isKeyFoldOpen(undefined, 'rid-1')).toBe(true);
    expect(isKeyFoldOpen({}, 'rid-1')).toBe(true);
    expect(isKeyFoldOpen({ [REMOTE_FOLD_KEY]: 'not an object' }, 'rid-1')).toBe(true);
    expect(isKeyFoldOpen({ [REMOTE_FOLD_KEY]: { 'rid-2': false } }, 'rid-1')).toBe(true);
    expect(isKeyFoldOpen({ [REMOTE_FOLD_KEY]: { 'rid-1': false } }, 'rid-1')).toBe(false);
  });

  it('with no pairing there is nothing to remember, and nothing is written', () => {
    expect(isKeyFoldOpen({ [REMOTE_FOLD_KEY]: { 'rid-1': false } }, null)).toBe(true);
    expect(withKeyFold({ other: 1 }, null, false)).toEqual({ other: 1 });
  });

  // MUTATION PROOF — the bag is SHARED. A write that replaced it would drop the
  // board tab, the Flock chips and the memory-graph settings on one fold.
  it('MUTATION PROOF — keeps every other pane key, and every other pairing', () => {
    const bag = { 'board.tab': 'flock', [REMOTE_FOLD_KEY]: { 'rid-2': false } };
    expect(withKeyFold(bag, 'rid-1', false)).toEqual({
      'board.tab': 'flock',
      [REMOTE_FOLD_KEY]: { 'rid-2': false, 'rid-1': false },
    });
    expect(withKeyFold(bag, 'rid-2', true)).toEqual({
      'board.tab': 'flock',
      [REMOTE_FOLD_KEY]: { 'rid-2': true },
    });
  });
});

describe('RemotePane — naming the device', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('shows the name in the strip, the code box and the row — with the rid still beside it', async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, deviceName: 'Bertha' });

    expect(text(container.querySelector('.pill[data-state="paired"]'))).toBe('Paired · Bertha · 2 min ago');
    expect(text(container.querySelector('.code .said .who'))).toBe('Bertha');
    expect(text(container.querySelector('.row .name'))).toBe('Bertha');
    // The rid does not disappear behind the name: it is the only value that can
    // be checked against what the phone is showing.
    expect(text(container.querySelector('.row .rid'))).toBe('abcdef01…');
    expect(text(container.querySelector('.avatar'))).toBe('be');
  });

  it('with no name it falls back to the rid prefix everywhere', async () => {
    const { container } = render(RemotePane);
    await send(DATA);
    expect(text(container.querySelector('.pill[data-state="paired"]'))).toBe('Paired · abcdef01… · 2 min ago');
    expect(text(container.querySelector('.row .name'))).toBe('abcdef01…');
    // No name, so no second copy of the same prefix.
    expect(container.querySelector('.row .rid')).toBeNull();
  });

  it('the pencil opens an inline box and Enter posts the name against the rid', async () => {
    const { container } = render(RemotePane);
    await send(DATA);

    await fireEvent.click(container.querySelector('.icon-btn')!);
    const box = container.querySelector('.name-edit') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.maxLength).toBe(PANE_DEVICE_NAME_MAX);

    await fireEvent.input(box, { target: { value: 'Bertha' } });
    await fireEvent.keyDown(box, { key: 'Enter' });
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'remoteSetDeviceName',
      rid: 'abcdef0123456789',
      name: 'Bertha',
    });
  });

  it('Escape abandons the edit and posts NOTHING — the blur it causes must not commit', async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, deviceName: 'Bertha' });

    await fireEvent.click(container.querySelector('.icon-btn')!);
    const box = container.querySelector('.name-edit') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: 'typo' } });
    await fireEvent.keyDown(box, { key: 'Escape' });
    await fireEvent.blur(box);

    expect(container.querySelector('.name-edit')).toBeNull();
    expect(text(container.querySelector('.row .name'))).toBe('Bertha');
    const posted = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(posted).not.toContain('remoteSetDeviceName');
  });

  it('clicking away commits what was typed', async () => {
    const { container } = render(RemotePane);
    await send(DATA);
    await fireEvent.click(container.querySelector('.icon-btn')!);
    const box = container.querySelector('.name-edit') as HTMLInputElement;
    await fireEvent.input(box, { target: { value: ' Bertha ' } });
    await fireEvent.blur(box);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'remoteSetDeviceName',
      rid: 'abcdef0123456789',
      name: 'Bertha',
    });
  });
});

// MULTI-WINDOW. The owner runs several VS Code windows and the relay allows one
// socket per role per rid, so exactly one window owns the phone. The other two
// must SAY so and offer the one thing worth doing about it.
describe('RemotePane — the pairing is active in another window', () => {
  beforeEach(() => globalThis.__vscodeApiMock.postMessage.mockClear());

  it('the strip says which window has it, and counts no device here', async () => {
    const { container } = render(RemotePane);
    await send(ELSEWHERE);
    expect(text(container.querySelector('.pill[data-state]'))).toBe('Paired · active in another window');
    // Waiting, never the paired tone: this window cannot reach the phone.
    expect(container.querySelector('.pill[data-state="other-window"]')!.className).toContain('wait');
    expect(container.querySelector('.pill[data-state="other-window"]')!.className).not.toContain('ok');
    expect(Array.from(container.querySelectorAll('.pills .pill')).map(text).at(-1)).toBe('No device');
  });

  it('the pair column says it in words and offers Take over as the ONE primary action', async () => {
    const { container } = render(RemotePane);
    await send(ELSEWHERE);
    expect(text(container.querySelector('.hero-h'))).toBe('Remote is active in another window');
    expect(text(container.querySelector('.hero .note'))).toBe(
      'Your phone is mirroring a different VS Code window. Take over to point it at this one instead.',
    );
    expect(text(container.querySelector('[data-primary]'))).toBe('Take over');
    expect(container.querySelectorAll('[data-primary]')).toHaveLength(1);
  });

  // Nothing to scan and nothing to summarise: a code here would be for a
  // pairing that already exists, held by a different window, so the whole code
  // box — ghost square included — stays away.
  it('shows no code box at all', async () => {
    const { container } = render(RemotePane);
    await send(ELSEWHERE);
    expect(container.querySelector('.qr')).toBeNull();
    expect(container.querySelector('.code')).toBeNull();
  });

  it('Take over posts remoteTakeOver, and nothing else', async () => {
    const { container } = render(RemotePane);
    await send(ELSEWHERE);
    await fireEvent.click(container.querySelector('[data-primary]')!);
    // `remoteRequest` is the pane's own read. No `groupRequest` any more: the
    // group card left this pane for the Nests view (t-s9jr6u). The BUTTON adds
    // exactly one more message, and it is not a revoke, a pair or a settings write.
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'remoteRequest' },
      { type: 'remoteTakeOver' },
    ]);
  });

  // MUTATION PROOF for the state itself: swap `other-window` back to the
  // `connecting` this used to render as and every line above changes.
  it('MUTATION PROOF — connecting and other-window are not the same screen', async () => {
    const { container } = render(RemotePane);
    await send({ ...DATA, connection: 'connecting' });
    expect(text(container.querySelector('.pill[data-state]'))).toBe('Paired · abcdef01… · reconnecting');
    expect(text(container.querySelector('[data-primary]'))).toBe('Pair another phone');

    await send(ELSEWHERE);
    expect(text(container.querySelector('.pill[data-state]'))).toBe('Paired · active in another window');
    expect(text(container.querySelector('[data-primary]'))).toBe('Take over');
  });
});
