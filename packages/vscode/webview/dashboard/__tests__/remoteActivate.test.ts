// Origami Remote — the activation gate and the settings contract.
//
// remoteController.test.ts proves the CONTROLLER does nothing when the feature
// is off. This file proves the line above it: with
// `origamicoder.remote.enabled` false, activateRemote never constructs a
// controller at all, so SecretStorage is never even read. Driven against a
// faked `vscode` module, the harness pattern browserAutoApproveControl.test.ts
// established.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { fake } = vi.hoisted(() => ({
  fake: {
    settings: {} as Record<string, unknown>,
    commands: [] as Array<{ id: string; handler: (...a: unknown[]) => unknown }>,
    warnings: [] as string[],
    infos: [] as string[],
    panels: 0,
    executed: [] as string[],
    // setContext calls, kept apart from `executed` so the many existing
    // assertions on plain command ids (`fake.executed`) see no new entries.
    contextSets: [] as Array<[string, unknown]>,
    configListeners: [] as Array<(e: { affectsConfiguration: (s: string) => boolean }) => void>,
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    name: 'test-workspace',
    getConfiguration: (section: string) => ({
      get: (key: string, fallback: unknown) => fake.settings[`${section}.${key}`] ?? fallback,
    }),
    onDidChangeConfiguration: (cb: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
      fake.configListeners.push(cb);
      return { dispose: () => { fake.configListeners = fake.configListeners.filter((l) => l !== cb); } };
    },
  },
  window: {
    showWarningMessage: (m: string) => {
      fake.warnings.push(m);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (m: string) => {
      fake.infos.push(m);
      return Promise.resolve(undefined);
    },
    createWebviewPanel: () => {
      fake.panels++;
      return {
        webview: {
          asWebviewUri: (u: unknown) => u,
          cspSource: 'vscode-resource:',
          html: '',
          postMessage: () => Promise.resolve(true),
          onDidReceiveMessage: () => ({ dispose: () => {} }),
        },
        reveal: () => {},
        onDidDispose: () => ({ dispose: () => {} }),
      };
    },
  },
  commands: {
    registerCommand: (id: string, handler: (...a: unknown[]) => unknown) => {
      fake.commands.push({ id, handler });
      return { dispose: () => {} };
    },
    executeCommand: (id: string, ...args: unknown[]) => {
      if (id === 'setContext') fake.contextSets.push(args as [string, unknown]);
      else fake.executed.push(id);
      return Promise.resolve(undefined);
    },
  },
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  ViewColumn: { Active: 1 },
}));

const { activateRemote, readRemoteConfig } = await import('../../../src/remote/activate');
const { remoteSnapshot, resetRemoteControl } = await import('../../../src/remote/control');
const { SECRET_CONFIRMED, SECRET_KS, LEGACY_PIN_SECRET } = await import('../../../src/remote/pairing');
const { requestBoardSection } = await import('../../../src/dashboard/boardSection');
const { handleBotMessage } = await import('../../../src/dashboard/botsManager');

/**
 * THE `ws` LEAK, and why every wait in this file is now a poll.
 *
 * `activateRemote` starts `restore()` as a FLOATING promise, and restore does
 * several async SecretStorage reads and two HKDF derivations before it opens a
 * socket. A fixed `setTimeout(20)` is a guess about how long that takes: under
 * full-suite load it expired first, the `finally` put jsdom's real WebSocket
 * back, and the socket restore then opened was jsdom's — which is the `ws`
 * package's browser shim and throws "ws does not work in the browser" from a
 * promise nobody is holding. That unhandled rejection landed in whichever file
 * vitest happened to be running (t-w4w7ih), and this file's own assertion saw
 * zero sockets. Waiting for the OBSERVABLE end of restore() removes both.
 */
async function waitFor(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function context(secretsGet: () => Promise<string | undefined>) {
  return {
    extensionUri: { fsPath: '/ext' },
    secrets: { get: vi.fn(secretsGet), store: vi.fn(), delete: vi.fn() },
  } as never;
}

/** Everything `activateRemote` returns, so nothing outlives its test — the
 *  lease heartbeat is a `setInterval` and the controller holds a socket. */
let disposables: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const d of disposables) d.dispose();
  disposables = [];
});

beforeEach(() => {
  fake.settings = {};
  fake.commands = [];
  fake.warnings = [];
  fake.infos = [];
  fake.panels = 0;
  fake.executed = [];
  fake.contextSets = [];
  fake.configListeners = [];
  requestBoardSection('');
});

describe('remote activation — settings', () => {
  it('defaults to OFF, the origamilabs relay and the FULL envelope', () => {
    expect(readRemoteConfig()).toEqual({
      enabled: false,
      relayUrl: 'wss://relay.origamilabs.nl',
      // FULL by the owner's stated intent: the phone MAY ask for YOLO, behind
      // Face ID and a signature the relay cannot mint. The bound exists for a
      // desk that wants to narrow it, not as a default distrust.
      capability: 'full',
    });
  });

  it('reads each setting from origamicoder.remote.*', () => {
    fake.settings['origamicoder.remote.enabled'] = true;
    fake.settings['origamicoder.remote.relayUrl'] = 'ws://localhost:9000';
    fake.settings['origamicoder.remote.capability'] = 'watch';
    expect(readRemoteConfig()).toEqual({
      enabled: true,
      relayUrl: 'ws://localhost:9000',
      capability: 'watch',
    });
    // A typo is the DEFAULT, not a refusal: a mistyped envelope that silently
    // muted a paired phone would look like a broken relay.
    fake.settings['origamicoder.remote.capability'] = 'Watch Only';
    expect(readRemoteConfig().capability).toBe('full');
  });
});

describe('remote activation — the enabled gate', () => {
  it('with the feature OFF, registers the commands and constructs nothing else', async () => {
    const ctx = context(() => Promise.resolve('never-read'));
    disposables.push(...activateRemote(ctx));
    expect(fake.commands.map((c) => c.id)).toEqual(['origami.remotePair', 'origami.remoteRevoke']);
    await Promise.resolve();
    expect((ctx as unknown as { secrets: { get: ReturnType<typeof vi.fn> } }).secrets.get).not.toHaveBeenCalled();
  });

  it('the pair command warns instead of pairing while the feature is off', async () => {
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    await fake.commands.find((c) => c.id === 'origami.remotePair')!.handler();
    expect(fake.warnings).toEqual([
      'Origami Remote is off. Turn on origamicoder.remote.enabled to pair a phone.',
    ]);
    expect(fake.executed).toEqual([]);
  });

  it('the revoke command says so plainly when nothing is paired', async () => {
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    await fake.commands.find((c) => c.id === 'origami.remoteRevoke')!.handler();
    expect(fake.infos).toEqual(['Origami: no remote device is paired.']);
  });

  // THE PHANTOM DEVICE, at the activation line. Pressing Show code and never
  // scanning leaves Ks and the PIN hash in the keychain. A window that reads
  // those two as a pairing announces a device the owner never paired AND opens
  // a relay socket for it. The confirmation marker is the difference, and the
  // stale material is forgotten on the way past.
  it('an offer no phone ever confirmed does NOT come back as a device on the next window', async () => {
    fake.settings['origamicoder.remote.enabled'] = true;
    const store = new Map<string, string>([
      [SECRET_KS, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'],
      [LEGACY_PIN_SECRET, 'a-pin-hash'],
    ]);
    const sockets: string[] = [];
    const priorWs = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      constructor(url: string) {
        sockets.push(url);
        throw new Error(`a relay socket was opened for an unconfirmed offer: ${url}`);
      }
    };
    try {
      resetRemoteControl();
      disposables.push(...activateRemote({
        extensionUri: { fsPath: '/ext' },
        secrets: {
          get: (k: string) => Promise.resolve(store.get(k)),
          store: (k: string, v: string) => Promise.resolve(void store.set(k, v)),
          delete: (k: string) => Promise.resolve(void store.delete(k)),
        },
        globalState: { get: () => undefined, update: () => Promise.resolve() },
      } as never));
      // The observable end of restore() on THIS path: the unconfirmed material
      // is wiped. A fixed sleep here would either flake or hide the wipe.
      await waitFor(() => store.size === 0, 'the unconfirmed offer to be forgotten');

      expect(sockets).toEqual([]);
      expect(remoteSnapshot()).toMatchObject({ connection: 'unpaired', rid: null, pairedAt: null });
      // and the dead material is gone, so the window after this one is clean too
      expect([...store.keys()]).toEqual([]);
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = priorWs;
      resetRemoteControl();
    }
  });

  it('a CONFIRMED pairing does come back, socket and all', async () => {
    fake.settings['origamicoder.remote.enabled'] = true;
    const store = new Map<string, string>([
      [SECRET_KS, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'],
      [LEGACY_PIN_SECRET, 'a-pin-hash'],
      [SECRET_CONFIRMED, '1699999000000'],
    ]);
    const sockets: string[] = [];
    const priorWs = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      public binaryType = '';
      public onopen: unknown = null;
      public onmessage: unknown = null;
      public onclose: unknown = null;
      public onerror: unknown = null;
      constructor(url: string) {
        sockets.push(url);
      }
      public send(): void {}
      public close(): void {}
    };
    try {
      resetRemoteControl();
      disposables.push(...activateRemote({
        extensionUri: { fsPath: '/ext' },
        secrets: {
          get: (k: string) => Promise.resolve(store.get(k)),
          store: (k: string, v: string) => Promise.resolve(void store.set(k, v)),
          delete: (k: string) => Promise.resolve(void store.delete(k)),
        },
        globalState: { get: () => undefined, update: () => Promise.resolve() },
      } as never));
      // The observable end of restore() here is the socket itself. Held INSIDE
      // the try, so the fake WebSocket is still installed when it is built.
      await waitFor(() => sockets.length === 1, 'restore() to open the relay socket');

      expect(sockets).toHaveLength(1);
      expect(sockets[0]).toContain('wss://relay.origamilabs.nl/r/');
      // Not yet OPEN, so not green — but a real pairing, with its real age.
      expect(remoteSnapshot()).toMatchObject({ connection: 'connecting', pairedAt: 1_699_999_000_000 });
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = priorWs;
      resetRemoteControl();
    }
  });

  it('with the feature ON, it DOES read the stored pairing', async () => {
    fake.settings['origamicoder.remote.enabled'] = true;
    const ctx = context(() => Promise.resolve(undefined));
    disposables.push(...activateRemote(ctx));
    const secrets = (ctx as unknown as { secrets: { get: ReturnType<typeof vi.fn> } }).secrets;
    await waitFor(() => secrets.get.mock.calls.length > 0, 'restore() to read the stored pairing');
    expect(secrets.get).toHaveBeenCalled();
  });

  // The branded pairing webview is retired: it drew the same QR, the same clock
  // and the same PIN box in a second window. The command opens the PANE.
  it('with the feature ON, the pair command opens the board on the Remote pane', async () => {
    fake.settings['origamicoder.remote.enabled'] = true;
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    await fake.commands.find((c) => c.id === 'origami.remotePair')!.handler();

    expect(fake.executed).toEqual(['origami.openAgentManager']);
    expect(fake.warnings).toEqual([]);
    // No second webview of its own — the pane is the surface.
    expect(fake.panels).toBe(0);

    // ...and the board that mounts next is told which view to show, through the
    // same pending-section handshake the sidebar's Front Desk link uses.
    const posts: Array<Record<string, unknown>> = [];
    await handleBotMessage({ post: (m) => void posts.push(m) } as never, { type: 'boardReady' });
    expect(posts).toEqual([{ type: 'boardShowSection', section: 'remote' }]);
  });

  it('returns a disposable that tears the controller down', () => {
    fake.settings['origamicoder.remote.enabled'] = true;
    const returned = activateRemote(context(() => Promise.resolve(undefined)));
    expect(() => returned.at(-1)!.dispose()).not.toThrow();
    disposables.push(...returned.slice(0, -1));
  });
});

// remote-hide lane: package.json gates origami.remotePair/origami.remoteRevoke
// out of the command palette with `when: "origamicoder.remoteEnabled"`. This
// is the context key that `when` reads, kept live from here.
describe('remote activation — the command-palette context key', () => {
  it('sets origamicoder.remoteEnabled to false on activation when the setting is off (the default)', () => {
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    expect(fake.contextSets.at(-1)).toEqual(['origamicoder.remoteEnabled', false]);
  });

  it('sets origamicoder.remoteEnabled to true on activation when the setting is already on', () => {
    fake.settings['origamicoder.remote.enabled'] = true;
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    expect(fake.contextSets.at(-1)).toEqual(['origamicoder.remoteEnabled', true]);
  });

  it('re-syncs the context key when the setting changes after activation', () => {
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    expect(fake.contextSets.at(-1)).toEqual(['origamicoder.remoteEnabled', false]);

    fake.settings['origamicoder.remote.enabled'] = true;
    for (const cb of fake.configListeners) cb({ affectsConfiguration: (s) => s === 'origamicoder.remote.enabled' });
    expect(fake.contextSets.at(-1)).toEqual(['origamicoder.remoteEnabled', true]);
  });

  it('ignores a configuration change that is not the remote setting', () => {
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    const before = fake.contextSets.length;
    for (const cb of fake.configListeners) cb({ affectsConfiguration: (s) => s === 'origami.engineUrl' });
    expect(fake.contextSets).toHaveLength(before);
  });
});

describe('remote activation — the package.json contract', () => {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const pkg = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
      menus: { commandPalette: Array<{ command: string; when?: string }> };
      configuration: { properties: Record<string, { type: string; default: unknown; enum?: string[] }> };
    };
  };

  // THE HIDE IS REVERSED (remote-device-key lane). The iOS app makes Remote a
  // shipping feature, so the settings are back in the visible schema — with
  // `enabled` still FALSE by default, because visible is not on. The DEFAULTS
  // are asserted, not just the keys: every call site passes the same value to
  // `getConfiguration().get(key, default)`, and a schema default that drifted
  // from those would make Settings show one thing and the code do another.
  // THREE, not five (2026-09-06). The approvals policy went with the pairing
  // PIN, and the device-key requirement went with it: a page that proves no key
  // is now clamped to `watch`, so there is nothing left for a switch to say.
  // A row that came back here would be a settings surface the code no longer
  // reads.
  it('lists the three origamicoder.remote.* settings with the defaults the code passes', () => {
    const props = pkg.contributes.configuration.properties;
    const keys = Object.keys(props).filter((k) => k.startsWith('origamicoder.remote.'));
    expect(keys).toEqual([
      'origamicoder.remote.enabled',
      'origamicoder.remote.relayUrl',
      'origamicoder.remote.capability',
    ]);
    expect(props['origamicoder.remote.enabled']!.default).toBe(false);
    expect(props['origamicoder.remote.relayUrl']!.default).toBe('wss://relay.origamilabs.nl');
    // R-2a. FULL, and the enum is the code's own three values — a schema that
    // offered a fourth would put a value in Settings that `readCapability`
    // silently turns back into `full`.
    expect(props['origamicoder.remote.capability']!.default).toBe('full');
    expect(props['origamicoder.remote.capability']!.enum).toEqual(['watch', 'ask', 'full']);
  });

  it('contributes both commands, under the titles the brief names', () => {
    const byId = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
    expect(byId.get('origami.remotePair')).toBe('Origami: Pair a phone');
    expect(byId.get('origami.remoteRevoke')).toBe('Origami: Revoke remote devices');
  });

  // Hidden from the palette while off, never unregistered: a keybinding or a
  // script can still call either command regardless of the context key.
  it('gates both Remote commands out of the command palette behind origamicoder.remoteEnabled', () => {
    const byId = new Map(pkg.contributes.menus.commandPalette.map((e) => [e.command, e.when]));
    expect(byId.get('origami.remotePair')).toBe('origamicoder.remoteEnabled');
    expect(byId.get('origami.remoteRevoke')).toBe('origamicoder.remoteEnabled');
  });

  it('every contributed remote command is actually registered at activation', () => {
    disposables.push(...activateRemote(context(() => Promise.resolve(undefined))));
    const registered = new Set(fake.commands.map((c) => c.id));
    for (const c of pkg.contributes.commands) {
      if (!c.command.startsWith('origami.remote')) continue;
      expect(registered.has(c.command), `${c.command} is contributed but never registered`).toBe(true);
    }
  });
});
