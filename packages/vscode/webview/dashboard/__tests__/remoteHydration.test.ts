// WHAT THE OWNER SEES ON HIS PHONE.
//
// Four snags came out of the first real iPhone session (2026-09-03, 22:18):
// a transcript that never appeared, no way to switch chats, a reload that
// showed the empty state over a running stream, and a blank page after a
// second VS Code window took the pairing. Three of them are one sentence
// each in the code, and none of them could be caught by a test that stopped
// at "the frame was sent".
//
// So this file runs BOTH real ends against a loopback relay: the production
// `DashboardPanel.attachView` (harness) sealing through the production
// `RemoteController`, and the production phone shell mounting the untouched
// chat bundle. The assertions are on the phone's DOM, because that is where
// the owner's complaint lives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: <T>(_k: string, d: T) => d, inspect: () => undefined }),
  },
  // `state.focused` is read by notifyEvents, which DashboardPanel.post calls on
  // a requestPermission — the ask the privilege tests below stream.
  // `showErrorMessage` because a chat now opens its editor tab DURING start()
  // (t-hb1b7e, sessionAnnounce.ts): this harness has no VS Code window, so
  // openSessionInEditor takes its own "could not open" branch, and a double that
  // cannot answer it turns that branch into an unhandled rejection.
  window: { activeTextEditor: undefined, state: { focused: true }, showErrorMessage: () => undefined },
}));

import { RemoteController } from '../../../src/remote/remoteController';
import { MODE_SET } from '../../../src/remote/privilege';
import type { RemoteSocket, TransportDeps } from '../../../src/remote/transport';
import { parseQrPayload, type SecretStore } from '../../../src/remote/pairing';
import { registerRemoteSeq, resetRemoteSeq, type SeqMemento } from '../../../src/remote/seqStore';
import { LoopbackRelay, settle } from './remoteLoopback';
import { makePanelHarness, type HarnessSession } from './remotePanelHarness';
import { bootPhone, type Phone } from './remotePhoneHarness';

const OLD = 'chat-old';
const CUR = 'chat-current';

const TRANSCRIPT = [
  { kind: 'user', text: 'summarise the wrap arc', timestamp: 1 },
  { kind: 'agent', text: 'Three commits, one revert.', timestamp: 2 },
];

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => Promise.resolve(map.get(k)),
    store: (k, v) => Promise.resolve(void map.set(k, v)),
    delete: (k) => Promise.resolve(void map.delete(k)),
  };
}

function loopbackDeps(relay: LoopbackRelay): TransportDeps {
  return {
    connect: (url) => relay.connect(url) as unknown as RemoteSocket,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** Two chats, oldest first, the ACTIVE one second and the only one with a
 *  transcript — the shape of the owner's window. */
function twoChats(): HarnessSession[] {
  return [
    { id: OLD, number: 1, title: 'yesterday', log: [] },
    { id: CUR, number: 2, title: 'Cortex-0836', log: [...TRANSCRIPT] },
  ];
}

interface Desk {
  controller: RemoteController;
  secrets: ReturnType<typeof memorySecrets>;
  statuses: string[];
  /** One entry per completed hydration — `attachView` really ran. */
  attaches: number[];
}

async function bootDesktop(
  relay: LoopbackRelay,
  sessions: HarnessSession[],
  activeId: string,
  secrets = memorySecrets(),
): Promise<{ desk: Desk; ks: Uint8Array; rid: string; harness: ReturnType<typeof makePanelHarness> }> {
  const harness = makePanelHarness(sessions, activeId);
  const statuses: string[] = [];
  const attaches: number[] = [];
  const controller = new RemoteController({
    config: () => ({ enabled: true, relayUrl: 'wss://loopback' }),
    secrets,
    deps: loopbackDeps(relay),
    attach: (host) => {
      attaches.push(Date.now());
      harness.panel.attachView(host, 'chat');
    },
    onStatus: (s) => statuses.push(s),
    deviceName: 'harness desktop',
  });
  const offer = await controller.pair();
  const scanned = parseQrPayload(offer.qr);
  return { desk: { controller, secrets, statuses, attaches }, ks: scanned.ks, rid: offer.rid, harness };
}

/** Poll rather than sleep: the whole suite runs in parallel, and a fixed
 *  number of ticks is a fixed guess about how busy the machine is. */
async function until(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * WAIT FOR THE WIRE AND THE DOM TO STOP MOVING, not for a tick count.
 *
 * `settle(12)` is twelve `setTimeout(0)` rounds — about twelve milliseconds of
 * wall clock, which is LESS than the MountGate's 30 ms grace timer and far less
 * than the seal/open chain needs on a machine running the other 370 test files
 * at the same time. That is the whole of this file's "passes alone, fails under
 * load" flake: the assertions were reading a hydration that was still in
 * flight, and which frame had made it decided which case failed.
 *
 * So: the phone must have MOUNTED, and nothing may have crossed the relay or
 * changed the DOM for a real quiet window. Time-bounded, and it throws with the
 * reason rather than letting the next assertion report a mystery empty array.
 */
async function quiet(relay: LoopbackRelay, phone?: Phone, ms = 10_000): Promise<void> {
  const shot = (): string =>
    `${relay.forwarded.length}|${relay.controls.length}|` +
    (phone ? `${phone.pinned}|${phone.cells()}|${phone.rows().join(',')}|${phone.chips().join(',')}` : '');
  const end = Date.now() + ms;
  let last = '';
  let still = 0;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 12));
    const now = shot();
    still = now === last ? still + 1 : 0;
    last = now;
    // Four consecutive quiet polls — ~48 ms of nothing happening at all.
    if (still >= 4 && (!phone || phone.pinned !== '')) return;
  }
  throw new Error(`the wire never went quiet (last: ${last})`);
}

let phones: Phone[] = [];
let desks: RemoteController[] = [];

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
  // ONE MACHINE. Every window in a test shares this the way they share
  // `context.globalState`, which is where the frame sequence marks live.
  const raw = new Map<string, unknown>();
  const machine: SeqMemento = {
    get: <T,>(key: string, fallback: T): T => (raw.has(key) ? (raw.get(key) as T) : fallback),
    update: (key, value) => Promise.resolve(void raw.set(key, value)),
  };
  registerRemoteSeq(machine);
});

afterEach(() => {
  for (const p of phones) p.close();
  for (const d of desks) d.dispose();
  phones = [];
  desks = [];
  resetRemoteSeq();
});

/** `enrolKey` boots the phone as the APP rather than as a browser page. Since
 *  2026-09-06 a pairing with no enrolled device key may only watch, so any test
 *  whose claim is that the phone DRIVES the desktop has to pass it. */
async function pair(sessions: HarnessSession[], activeId: string, enrolKey = false) {
  const relay = new LoopbackRelay();
  const { desk, ks, rid, harness } = await bootDesktop(relay, sessions, activeId);
  desks.push(desk.controller);
  const phone = await bootPhone({ relay, ks, rid, enrolKey });
  phones.push(phone);
  await quiet(relay, phone);
  return { relay, desk, phone, ks, rid, harness };
}

// ---------------------------------------------------------------- snag 1 --

describe('first paint — the phone opens on the chat the window is ON', () => {
  it('shows the ACTIVE session transcript, not the oldest chat empty state', async () => {
    const { phone } = await pair(twoChats(), CUR);
    await until(() => phone.rows().length === 2, 'the active transcript to paint');

    // The bug: `replaySessionsTo` walks the sessions map oldest-first and only
    // names the active chat at the END, so mounting on the first
    // `sessionCreated` pinned `chat-old` — which has no transcript, so
    // `visibleCells` filtered the real chat out and ChatEmptyState drew the
    // crane and a rotating tip over an empty pane.
    expect(phone.pinned).toBe(CUR);
    expect(phone.rows()).toEqual(['row user', 'row agent']);
    expect(phone.hasEmptyState()).toBe(false);
    expect(phone.cells()).toBe(1);
  }, 20_000);

  it('still opens a chat when the window names no active session at all', async () => {
    // A window whose only chat was created live sends `sessionCreated` with no
    // `restoreActiveSession` behind it. The grace timer must not leave the
    // phone unmounted for ever.
    const { phone } = await pair([{ id: OLD, number: 1, log: [...TRANSCRIPT] }], '');
    await until(() => phone.rows().length === 2, "the grace timer to mount the window's only chat");
    expect(phone.pinned).toBe(OLD);
    expect(phone.rows()).toEqual(['row user', 'row agent']);
  }, 20_000);
});

// ------------------------------------------------- snag 1, second helping --

describe('hydrate is idempotent — a second snapshot changes nothing', () => {
  it('replays the same transcript once, with no duplicate rows or cells', async () => {
    const { relay, phone } = await pair(twoChats(), CUR);
    await until(() => phone.rows().length === 2, 'the transcript to paint');
    const before = phone.rows();

    // What a phone sends on every reconnect, and what the Refresh button on
    // the pane amounts to: ask for the whole hydration again.
    await phone.transport.send({ type: 'remote/snapshot' });
    await quiet(relay, phone);

    expect(phone.rows()).toEqual(before);
    expect(phone.cells()).toBe(1);
    expect(phone.hasEmptyState()).toBe(false);
  }, 20_000);
});

// -------------------------------------------- snag 3, the crane over a chat --

describe('the empty state never sits over a chat that has one', () => {
  it('is gone the moment a transcript is on screen, replayed or streamed', async () => {
    const { phone, harness } = await pair(twoChats(), CUR);
    await until(() => phone.rows().length === 2, 'the transcript to paint');
    expect(phone.hasEmptyState()).toBe(false);

    // A live turn on top of the replay — the state the owner was in when he
    // reloaded and found the crane sitting above a running stream.
    harness.stream({ type: 'agentText', sessionId: CUR, text: 'still working' });
    await until(() => phone.rows().length > 2, 'the streamed row to paint');
    expect(phone.hasEmptyState()).toBe(false);
    expect(phone.rows().filter((r) => r.includes('agent')).length).toBeGreaterThanOrEqual(1);
  }, 20_000);
});

// ---------------------------------------------------------------- snag 3 --

describe('refresh — a reloaded shell hydrates from the desktop again', () => {
  it('the desktop replays for the reloaded shell, and the shell can talk back', async () => {
    const { relay, desk, phone, ks, rid } = await pair(twoChats(), CUR);
    await until(() => phone.rows().length === 2, 'the transcript to paint');
    const hydrationsBefore = desk.attaches.length;

    // A browser refresh: the page is gone, localStorage survives, and a NEW
    // transport starts its own sequence numbers from 1. The desktop's replay
    // guard is still at the old high-water mark, so it threw away the reloaded
    // shell's `remote/hello` AND its `remote/snapshot` — the phone then showed
    // whatever the relay's ring happened to still hold and could not send.
    phone.close();
    document.body.innerHTML = '';
    const reloaded = await bootPhone({ relay, ks, rid });
    phones.push(reloaded);
    await until(() => reloaded.rows().length === 2, 'the reloaded shell to paint the transcript');
    await quiet(relay, reloaded);

    // 1. The desktop answered the reloaded shell with a FRESH hydration.
    expect(desk.attaches.length).toBeGreaterThan(hydrationsBefore);
    // 2. Which the shell rendered, in one cell, with no empty state over it.
    expect(reloaded.pinned).toBe(CUR);
    expect(reloaded.rows()).toEqual(['row user', 'row agent']);
    expect(reloaded.hasEmptyState()).toBe(false);
    expect(reloaded.cells()).toBe(1);
  }, 20_000);
});

// ---------------------------------------------------------------- snag 4 --

describe('hand-over — the window that takes the pairing hydrates the phone', () => {
  it('the phone accepts the new owner frames and is hydrated by it', async () => {
    const relay = new LoopbackRelay();
    const secrets = memorySecrets();
    const first = await bootDesktop(relay, twoChats(), CUR, secrets);
    desks.push(first.desk.controller);
    const phone = await bootPhone({ relay, ks: first.ks, rid: first.rid });
    phones.push(phone);
    await until(() => phone.rows().length === 2, 'the transcript to paint');
    await quiet(relay, phone);
    const seenBefore = phone.received.length;

    // Window A goes away (closed, or it lost the lease). Window B restores the
    // SAME pairing out of the shared keychain and opens its own socket — with
    // a fresh frame counter starting at 1, which the phone's replay guard
    // rejected as an attack. Every frame from the new owner vanished: the
    // owner saw the status pill say `open` over a blank page.
    first.desk.controller.dispose();
    relay.dropDesktop();
    await quiet(relay, phone);

    const harnessB = makePanelHarness(twoChats(), CUR);
    const attachesB: number[] = [];
    const windowB = new RemoteController({
      config: () => ({ enabled: true, relayUrl: 'wss://loopback' }),
      secrets,
      deps: loopbackDeps(relay),
      attach: (host) => {
        attachesB.push(Date.now());
        harnessB.panel.attachView(host, 'chat');
      },
      deviceName: 'window B',
    });
    desks.push(windowB);
    await windowB.restore();
    await until(() => attachesB.length > 0, 'the new owner to hydrate the phone');
    await quiet(relay, phone);

    // 1. The new owner hydrated the phone without being asked twice.
    expect(attachesB.length).toBeGreaterThan(0);
    // 2. And the phone ACCEPTED what it sent — no frame was eaten as a replay.
    const after = phone.received.slice(seenBefore) as Array<{ type?: string }>;
    expect(after.map((m) => m.type)).toContain('sessionCreated');
    expect(phone.rejects.filter((r) => r.includes('replayed'))).toEqual([]);
    // 3. The owner still has his transcript on screen.
    expect(phone.rows()).toEqual(['row user', 'row agent']);
    expect(phone.hasEmptyState()).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------- snag 2 --

describe('the chat strip — the phone can move between chats and start one', () => {
  const bothWithLogs = (): HarnessSession[] => [
    { id: OLD, number: 1, title: 'yesterday', log: [{ kind: 'user', text: 'the older question', timestamp: 1 }] },
    { id: CUR, number: 2, title: 'Cortex-0836', log: [...TRANSCRIPT] },
  ];

  it('lists both chats and swaps the transcript on a tap, with no round trip', async () => {
    const { phone, harness, desk } = await pair(bothWithLogs(), CUR);
    await until(() => phone.rows().length === 2 && phone.chips().length === 3, 'the strip and the transcript');
    expect(phone.chips()).toEqual(['1 · yesterday', '2 · Cortex-0836', '+']);
    expect(phone.rows()).toEqual(['row user', 'row agent']);
    const hydrationsBefore = desk.attaches.length;
    const askedBefore = harness.inbound.length;

    phone.tap('[data-session-id="chat-old"]');
    await until(() => phone.rows().length === 1, "the older chat's transcript to paint");

    // The other chat's own transcript — which the pane had all along, because
    // replaySessionsTo sends every session's restoreMessages.
    expect(phone.rows()).toEqual(['row user']);
    expect(phone.cells()).toBe(1);
    // NOTHING was fetched for it: no new hydration, and nothing the pane sent
    // was a request for content (the pane does tell the host which chat it is
    // on, which is the same thing a desktop tab switch does).
    expect(desk.attaches.length).toBe(hydrationsBefore);
    // What the pane DOES post is its per-session control refresh (models,
    // provider auth, spend, browser approval, collab defs) — the same thing a
    // desktop tab switch posts. Not one of them asks for a transcript.
    await settle(6);
    expect(desk.attaches.length).toBe(hydrationsBefore);
    const asked = (harness.inbound.slice(askedBefore) as Array<{ type?: string }>).map((m) => m.type);
    for (const type of ['remote/snapshot', 'recallSession', 'loadSession', 'newSession']) {
      expect(asked).not.toContain(type);
    }

    phone.tap('[data-session-id="chat-current"]');
    await until(() => phone.rows().length === 2, 'the active chat to paint again');
    expect(phone.rows()).toEqual(['row user', 'row agent']);
  }, 20_000);

  it('+ reaches the host as the composer own newSession', async () => {
    const { phone, harness } = await pair(bothWithLogs(), CUR, true);
    await until(() => phone.chips().length === 3, 'the strip to carry the + button');
    phone.tap('.remote-chip-new');
    await until(
      () => harness.inbound.some((m) => (m as { type?: string }).type === 'newSession'),
      'the newSession the + button posts to reach the host',
    );
  }, 20_000);

  it('the strip is there with ONE chat, so the + is reachable at all', async () => {
    // It used to appear only at the second chat, which meant a phone paired
    // into a one-chat window had no strip and therefore no way to start a
    // second — the owner had to open one on the desktop first.
    const { phone } = await pair([{ id: CUR, number: 1, title: 'Cortex-0836', log: [...TRANSCRIPT] }], CUR);
    await until(() => phone.chips().length === 2, 'the strip to carry the one chat and the +');
    expect(phone.chips()).toEqual(['1 · Cortex-0836', '+']);
    expect(document.getElementById('remoteSessions')?.getAttribute('data-open')).toBe('true');
  }, 20_000);
});

// ------------------------------------------------------------ closing one --

describe('closing a chat from the phone', () => {
  const bothWithLogs = (): HarnessSession[] => [
    { id: OLD, number: 1, title: 'yesterday', log: [{ kind: 'user', text: 'the older question', timestamp: 1 }] },
    { id: CUR, number: 2, title: 'Cortex-0836', log: [...TRANSCRIPT] },
  ];

  it('the x reaches the host as the desktop own closeSession, for the chat on screen', async () => {
    const { phone, harness } = await pair(bothWithLogs(), CUR, true);
    await until(() => phone.chips().length === 3, 'the strip to list both chats');
    // Only the chat the phone is reading carries one.
    const strip = document.getElementById('remoteSessions') as HTMLElement;
    expect([...strip.querySelectorAll('.remote-chip-close')].map((e) => e.getAttribute('aria-label')))
      .toEqual(['Close chat 2']);

    phone.tap(`[data-close-session-id="${CUR}"]`);
    await until(
      () => harness.inbound.some((m) => {
        const c = m as { type?: string; sessionId?: string };
        return c.type === 'closeSession' && c.sessionId === CUR;
      }),
      "the closeSession the x posts to reach the host's handleWebviewMessage",
    );
    // NOT STUBBED: that is the production `handleWebviewMessage`, and its
    // `case 'closeSession'` is the same arm the desktop's own tab close uses.
    // What the harness does NOT run is the body of `DashboardPanel.closeSession`
    // (it wants a permission banner, a live ACP client and the session archive,
    // none of which this panel has), so the half below plays the ONE message
    // that body broadcasts — `this.post({ type: 'sessionClosed', sessionId })`,
    // DashboardPanel.ts:1995 — and nothing more, because there is nothing more.
  }, 20_000);

  it('the answering sessionClosed lands the phone on the surviving chat transcript', async () => {
    const { phone, harness } = await pair(bothWithLogs(), CUR);
    await until(() => phone.rows().length === 2, 'the active transcript to paint');
    expect(phone.rows()).toEqual(['row user', 'row agent']);

    harness.stream({ type: 'sessionClosed', sessionId: CUR });
    await until(() => phone.rows().length === 1, 'the surviving chat to paint');

    // The host names no successor, so the phone applies the desktop's own rule
    // (activeSession.ts) and re-pins the mounted bundle itself. Without that the
    // pane stays solo on a session ChatPane has just dropped and paints the
    // empty-state crane over a window that still has a chat in it.
    expect(phone.rows()).toEqual(['row user']);
    expect(phone.cells()).toBe(1);
    expect(phone.chips()).toEqual(['1 · yesterday', '+']);
  }, 20_000);

  it('closing the LAST chat leaves the + on screen, and it still makes a chat', async () => {
    // The host creates nothing here: `closeSession` ends with
    // `liveActiveSessionId(...)` -> null and posts no further message. So the
    // most the phone can do is keep the one control that can make a chat.
    const { phone, harness } = await pair([{ id: CUR, number: 1, title: 'Cortex-0836', log: [...TRANSCRIPT] }], CUR, true);
    await until(() => phone.chips().length === 2, 'the strip to carry the one chat and the +');
    phone.tap(`[data-close-session-id="${CUR}"]`);
    harness.stream({ type: 'sessionClosed', sessionId: CUR });
    await until(() => phone.chips().length === 1, 'the strip to come down to the + alone');

    expect(phone.chips()).toEqual(['+']);
    expect(document.getElementById('remoteSessions')?.getAttribute('data-open')).toBe('true');
    phone.tap('.remote-chip-new');
    await until(
      () => harness.inbound.some((m) => (m as { type?: string }).type === 'newSession'),
      'the + to still reach the host after the last chat closed',
    );
  }, 20_000);
});

// --------------------------------------------------------------- privilege --

/** The ask the desk sends, which `privilege.outbound` stamps with the nonce its
 *  approval must sign on the way out. Shaped as `ChatPane.test.ts` shapes it,
 *  because the card under test is the bundle's own. */
function consentAsk(sessionId: string): object {
  return {
    type: 'requestPermission',
    sessionId,
    toolCallId: 'tc-yolo',
    title: 'bash',
    kind: 'execute',
    command: 'rm -rf ./build',
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

const posted = (inbound: readonly unknown[], type: string): Array<Record<string, unknown>> =>
  inbound.filter((m) => (m as { type?: unknown })?.type === type) as Array<Record<string, unknown>>;

describe('YOLO and approvals from the phone — the bundle own buttons, on the SIGNED road', () => {
  // R-1: `setApproveMode` is refused by name, so the chat bundle's YOLO button
  // answered one ask and left the chat in Ask — the next tool call asked again.
  // The page now translates it onto `remote/set-mode-request` -> challenge ->
  // signed `remote/set-mode`, and the desk drives its REAL permission ruleset
  // through the same host message the InputBar's own toggle posts. Both ends are
  // production here; the only thing the harness supplies is the Enclave.
  it('a tap on the ask card YOLO reaches the host as setApproveMode: bypass, and answers the ask', async () => {
    const { desk, phone, harness } = await pair(twoChats(), CUR, true);
    harness.stream(consentAsk(CUR));
    await until(() => phone.root.querySelector('.perm-btn.yolo') !== null, 'the bundle to draw the ask card');

    expect(phone.press('.perm-btn.yolo')).toBe(true);
    await until(() => posted(harness.inbound, 'setApproveMode').length > 0, 'the host to be told bypass');

    // The ONLY road this could have come by: the phone's own `setApproveMode` is
    // in NAMED_REFUSALS and never reaches the host, so seeing it here is the
    // signed handshake having completed.
    expect(posted(harness.inbound, 'setApproveMode')).toEqual([{ type: 'setApproveMode', mode: 'bypass', sessionId: CUR }]);
    expect(desk.statuses.some((t) => t.startsWith(MODE_SET))).toBe(true);
    expect(phone.mode(CUR)).toBe('yolo');
    // The challenge is the shell's to answer: the chat bundle has no arm for it,
    // so it must never have reached its message bus.
    expect(posted(phone.dispatched, 'remote/mode-challenge')).toEqual([]);

    // The ask on screen is still answered — signed, over the desk's own nonce,
    // or `permissionAnswer` would have dropped it before the host.
    await until(() => posted(harness.inbound, 'permission').length > 0, 'the signed approval to reach the host');
    expect(posted(harness.inbound, 'permission')[0]).toMatchObject({ toolCallId: 'tc-yolo', optionId: 'once' });
    await until(() => phone.root.querySelector('.permission-bar') === null, 'the card to clear');
  }, 20_000);

  it('is idempotent: a second tap opens no second handshake', async () => {
    const { relay, phone, harness } = await pair(twoChats(), CUR, true);
    harness.stream(consentAsk(CUR));
    await until(() => phone.root.querySelector('.perm-btn.yolo') !== null, 'the ask card');
    phone.press('.perm-btn.yolo');
    await until(() => phone.mode(CUR) === 'yolo', 'the handshake to finish');

    harness.stream({ ...consentAsk(CUR), toolCallId: 'tc-two' });
    await until(() => phone.root.querySelector('.perm-btn.yolo') !== null, 'the second ask card');
    phone.press('.perm-btn.yolo');
    await quiet(relay, phone);
    expect(posted(harness.inbound, 'setApproveMode')).toHaveLength(1);
  }, 20_000);

  // A page with no device key may WATCH. It cannot escalate, and it must not put
  // a request it could never answer on the wire either.
  it('a KEYLESS page raises no set-mode at all and reaches no bypass', async () => {
    const { desk, phone, harness } = await pair(twoChats(), CUR);
    harness.stream(consentAsk(CUR));
    await until(() => phone.root.querySelector('.perm-btn.yolo') !== null, 'the ask card');

    expect(phone.press('.perm-btn.yolo')).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    expect(posted(harness.inbound, 'setApproveMode')).toEqual([]);
    expect(desk.statuses.some((t) => t.startsWith(MODE_SET))).toBe(false);
    expect(phone.mode(CUR)).toBe('ask');
    // Its approval is dropped at the desk too — the second guard, for the page
    // that has no key to sign one with.
    expect(posted(harness.inbound, 'permission')).toEqual([]);
  }, 20_000);
});

// ------------------------------------------------------- the mode report --

const isReport = (m: unknown): boolean => (m as { type?: unknown } | null)?.type === 'remote/mode-state';

describe('the app is KILLED while a chat is in YOLO', () => {
  // The two ends kept the mode in two places and told each other nothing, so a
  // reopened app came back with an EMPTY map over a desk still holding the
  // bypass: the strip said Ask and the engine did not. The report closes it —
  // and it has to come off the WIRE, because the instant paint runs from disk
  // before the socket opens and a cached mode would be a stale one.
  it('the reopened page learns the yolo from the desk report, never from the paint', async () => {
    const { relay, phone, harness, ks, rid } = await pair(twoChats(), CUR, true);
    harness.stream(consentAsk(CUR));
    await until(() => phone.root.querySelector('.perm-btn.yolo') !== null, 'the ask card');
    phone.press('.perm-btn.yolo');
    await until(() => phone.mode(CUR) === 'yolo', 'the handshake to finish');
    await quiet(relay, phone);

    // KILLED. localStorage (the transcript) survives; the mode map does not, on
    // either end — `privilege.ts` on the desk persists nothing by design.
    phone.close();
    document.body.innerHTML = '';
    const reopened = await bootPhone({ relay, ks, rid, enrolKey: true });
    phones.push(reopened);

    // The flip may not happen before a report has landed. Read the count AT the
    // moment it flips rather than after, or a late report would rescue a page
    // that had already learned the yolo from somewhere it must not.
    let reportsWhenLearned = -1;
    await until(() => {
      if (reopened.mode(CUR) !== 'yolo') return false;
      reportsWhenLearned = reopened.received.filter(isReport).length;
      return true;
    }, 'the reopened page to learn the yolo');
    expect(reportsWhenLearned).toBeGreaterThan(0);
    await quiet(relay, reopened);

    // ONE report per hydration, naming both chats the burst named.
    const reports = reopened.received.filter(isReport) as Array<{ modes: Record<string, string> }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.modes).toMatchObject({ [CUR]: 'yolo', [OLD]: 'ask' });
    // The instant paint carried no mode of its own: the cache must never
    // synthesise this frame, and the chat bundle has no arm for it either.
    expect(posted(reopened.dispatched, 'remote/mode-state')).toEqual([]);
    // And the desk still holds the bypass it reported — nothing was re-granted.
    expect(posted(harness.inbound, 'setApproveMode')).toEqual([
      { type: 'setApproveMode', mode: 'bypass', sessionId: CUR },
    ]);
  }, 30_000);

  it('an UNSIGNED yolo on the wire is refused by the page, however well formed', async () => {
    const { relay, phone, harness } = await pair(twoChats(), CUR, true);

    // Everything the signed road carries except the one thing that counts: this
    // desk minted no challenge for it and this page signed nothing. It goes out
    // on the REAL desk -> phone path (the panel's own broadcast), because that
    // is the path anyone who could put bytes on this socket would use.
    harness.stream({
      type: 'remote/set-mode',
      v: 1,
      mode: 'yolo',
      sessionId: CUR,
      sig: 'looks-like-a-signature',
      pub: 'looks-like-a-key',
    });
    await until(() => phone.received.some((m) => (m as { type?: string }).type === 'remote/set-mode'),
      'the unsigned frame to reach the page');
    await quiet(relay, phone);

    expect(phone.mode(CUR)).toBe('ask');
    // Consumed by the shell, so the chat bundle never saw it either.
    expect(posted(phone.dispatched, 'remote/set-mode')).toEqual([]);
  }, 20_000);
});
