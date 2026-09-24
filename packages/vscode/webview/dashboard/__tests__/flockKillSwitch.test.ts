// flockKillSwitch.test.ts — `origamicoder.flock.enabled`, in the four places
// turning it off has to reach.
//
// The promise the setting makes is not "the pane is hidden". It is: no relay
// socket is opened for Flock, no owner lease is taken, the pane and the sidebar
// Front Desk are not shown, and questions from contacts are not received. Three
// of those four are proven here; the socket and the lease are the engine's, and
// packages/engine/test/flock/relay-service.test.ts proves them against a real
// `start()` with the variable set.
//
// Each half is asserted where it actually lives, because they fail apart: a
// board that hides the row while the engine still holds a relay socket is a
// feature that looks off and is on, and an engine told to stand down while the
// rail still offers the pane is a pane that will never load.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';

const { fake } = vi.hoisted(() => ({
  fake: { settings: {} as Record<string, unknown>, throws: false, updateThrows: false },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => {
      if (fake.throws) throw new Error('no settings store');
      return {
        get: (key: string) => fake.settings[`${section}.${key}`],
        update: (key: string, value: unknown) => {
          if (fake.updateThrows) throw new Error('settings file is read-only');
          fake.settings[`${section}.${key}`] = value;
          return Promise.resolve();
        },
      };
    },
  },
  ConfigurationTarget: { Global: 1 },
}));

import {
  FLOCK_DISABLE_VAR, FLOCK_ENABLED_SETTING, flockEnabled, flockSpawnEnv, setFlockEnabled,
} from '../../../src/flockEnabled';
import { engineSpawnEnv } from '../../../src/engineEnv';
import { resolveView, visibleViews } from '../panes/boardVisibility';
import BoardShell from '../panes/BoardShell.svelte';
import SidebarLauncher from '../../chat/SidebarLauncher.svelte';
import ChatView from '../../chat/ChatView.svelte';

const pkg = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string) => readFileSync(nodePath.join(pkg, rel), 'utf8');

beforeEach(() => {
  fake.settings = {};
  fake.throws = false;
  fake.updateThrows = false;
  globalThis.__vscodeApiMock.postMessage.mockClear();
});
afterEach(() => cleanup());

describe('flockEnabled — reading the setting', () => {
  it('is OFF by default: the owner has not chosen Flock yet', () => {
    expect(flockEnabled()).toBe(false);
    expect(FLOCK_ENABLED_SETTING).toBe('origamicoder.flock.enabled');
  });

  it('is on for an exact true and NOTHING else', () => {
    fake.settings[FLOCK_ENABLED_SETTING] = true;
    expect(flockEnabled()).toBe(true);
    // A string, a one, an older shape: all of them read as off — a feature
    // that opens a relay connection must never turn on by accident.
    for (const junk of ['true', 1, null, undefined, {}]) {
      fake.settings[FLOCK_ENABLED_SETTING] = junk;
      expect(flockEnabled(), String(junk)).toBe(false);
    }
  });

  it('is off when there is no settings store at all', () => {
    fake.settings[FLOCK_ENABLED_SETTING] = true;
    fake.throws = true;
    expect(flockEnabled()).toBe(false);
  });

  it('unset / true / false — the three settings.json shapes the acceptance case names', () => {
    expect(flockEnabled()).toBe(false); // unset
    fake.settings[FLOCK_ENABLED_SETTING] = true;
    expect(flockEnabled()).toBe(true); // explicit true
    fake.settings[FLOCK_ENABLED_SETTING] = false;
    expect(flockEnabled()).toBe(false); // explicit false
  });
});

describe('setFlockEnabled — writing the setting', () => {
  it('targets Global, and the value round-trips through flockEnabled()', async () => {
    expect(await setFlockEnabled(true)).toBeUndefined();
    expect(flockEnabled()).toBe(true);
    expect(await setFlockEnabled(false)).toBeUndefined();
    expect(flockEnabled()).toBe(false);
  });

  it('returns the error text on a throw, rather than pretending it wrote', async () => {
    fake.updateThrows = true;
    expect(await setFlockEnabled(true)).toContain('read-only');
    // Nothing was actually written.
    expect(flockEnabled()).toBe(false);
  });
});

describe('the engine spawn env', () => {
  it('carries ORIGAMI_DISABLE_FLOCK=1 unless the setting is explicitly on', () => {
    expect(flockSpawnEnv()).toEqual({ [FLOCK_DISABLE_VAR]: '1' });
    fake.settings[FLOCK_ENABLED_SETTING] = true;
    expect(flockSpawnEnv()).toEqual({});
  });

  it('reaches the REAL overlay every engine child is spawned with', () => {
    // Asserted through engineSpawnEnv, not through flockSpawnEnv alone: the
    // switch that is never spread into the spawn is a switch that does nothing,
    // and a unit test of the leaf could not tell.
    expect(engineSpawnEnv({ codeMode: false })[FLOCK_DISABLE_VAR]).toBe('1');
    fake.settings[FLOCK_ENABLED_SETTING] = true;
    expect(FLOCK_DISABLE_VAR in engineSpawnEnv({ codeMode: false })).toBe(false);
    // And it does not disturb what the shell already sets.
    expect(engineSpawnEnv({ codeMode: false })['ORIGAMI_EXPERIMENTAL_BACKGROUND_SUBAGENTS']).toBe('true');
  });

  it('DRIFT GUARD — the variable name is still the one the engine reads', () => {
    // A mirror across a process boundary. Renamed in the engine and unguarded
    // here, this switch would silently stop switching anything off, with every
    // test on both sides green.
    const engine = readFileSync(
      nodePath.resolve(pkg, '..', 'engine', 'src', 'flock', 'service.ts'),
      'utf8',
    );
    expect(engine, `${FLOCK_DISABLE_VAR} is not the engine's kill switch any more`).toContain(
      `DISABLE_ENV = "${FLOCK_DISABLE_VAR}"`,
    );
    // And the engine's idle sentence names the SETTING, so an owner reading it
    // in a chat is not sent looking for a shell they never opened.
    expect(engine).toContain('origamicoder.flock.enabled');
  });
});

// t-d9473q — the schema is the fourth place a default can drift. Every test
// above proves the CODE reads an unset/missing setting as off; none of them
// touch package.json, so a schema edit that flipped `"default": false` to
// `true` would leave this whole file green while a fresh install shipped
// Flock and Remote ON. Asserted together because "either" is the ticket's own
// wording — one guard, both keys, so a fresh-install regression on either
// setting fails here first.
describe('the package.json contract — both kill-switch defaults', () => {
  it('origamicoder.flock.enabled AND origamicoder.remote.enabled default to false', () => {
    const manifest = JSON.parse(read('package.json')) as {
      contributes: { configuration: { properties: Record<string, { type: string; default: unknown }> } };
    };
    const props = manifest.contributes.configuration.properties;

    const flock = props[FLOCK_ENABLED_SETTING];
    expect(flock, `${FLOCK_ENABLED_SETTING} is missing from the schema`).toBeDefined();
    expect(flock.type).toBe('boolean');
    expect(flock.default).toBe(false);

    const REMOTE_ENABLED_SETTING = 'origamicoder.remote.enabled';
    const remote = props[REMOTE_ENABLED_SETTING];
    expect(remote, `${REMOTE_ENABLED_SETTING} is missing from the schema`).toBeDefined();
    expect(remote.type).toBe('boolean');
    expect(remote.default).toBe(false);
  });
});

describe('the board rail', () => {
  it('keeps the Flock row on the rail even while the setting is off — the switch lives on it, like Remote', () => {
    const on = visibleViews(true, true).map((v) => v.id);
    const off = visibleViews(true, false).map((v) => v.id);
    expect(on).toContain('friends');
    expect(off).toContain('friends');
    expect(off).toEqual(on);
  });

  it('defaults to visible, whatever the setting reads — the row never hides', () => {
    expect(visibleViews(true).map((v) => v.id)).toContain('friends');
  });

  it('resolves a persisted Flock view to itself whether the setting is on or off', () => {
    expect(resolveView('friends', false, true)).toBe('friends');
    expect(resolveView('friends', false, false)).toBe('friends');
  });

  it('renders the Flock button on the real rail even while the setting is off, so the switch stays reachable', async () => {
    const labels = (el: HTMLElement) => Array.from(el.querySelectorAll('.nav-btn .nav-label')).map((n) => n.textContent);
    const on = render(BoardShell, { props: { flockEnabled: true } });
    expect(labels(on.container)).toContain('Flo');
    cleanup();

    const off = render(BoardShell, { props: { flockEnabled: false } });
    expect(labels(off.container)).toContain('Flo');
    // Not disabled either: a greyed row still reads as reachable, but the
    // owner's actual off/on control is the switch on the desk card, not this.
    expect(off.container.querySelector('.nav-btn[disabled]')).toBeNull();
  });
});

describe('the sidebar Front Desk', () => {
  it('is NOT mounted by default (off) and mounts only once the setting says true', () => {
    const off = render(SidebarLauncher);
    // Not mounted at all — not hidden. A mounted section would go on polling a
    // mailbox that nothing can fill, and the owner never consented to that.
    expect(off.container.querySelector('.fd-section')).toBeNull();
    expect(off.container.textContent).not.toContain('Front Desk');
    const asked = globalThis.__vscodeApiMock.postMessage.mock.calls
      .map((c: unknown[]) => (c[0] as { type?: string }).type)
      .filter((t: string | undefined) => t === 'flockMailboxRequest');
    expect(asked).toEqual([]);
    cleanup();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const on = render(SidebarLauncher, { props: { flockEnabled: true } });
    expect(on.container.querySelector('.fd-section')).not.toBeNull();
  });

  it('unmounts LIVE on a flockEnabled:false message, through the real ChatView listener', async () => {
    // The host always injects the global; a test simulating a host that HAS
    // read the setting as on sets it before mount, same as production.
    (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__ = true;
    const { container } = render(ChatView);
    await tick();
    expect(container.querySelector('.fd-section')).not.toBeNull();

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'flockEnabled', enabled: false } }));
    await tick();
    expect(container.querySelector('.fd-section')).toBeNull();

    // And it comes back the same way — no reload needed either direction.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'flockEnabled', enabled: true } }));
    await tick();
    expect(container.querySelector('.fd-section')).not.toBeNull();
    delete (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__;
  });

  it('never flashes on — a host that never posts the global renders OFF immediately, before and after mount settles', async () => {
    delete (window as unknown as { __ORIGAMI_FLOCK_ENABLED__?: boolean }).__ORIGAMI_FLOCK_ENABLED__;
    const { container } = render(ChatView);
    // Checked BEFORE the tick that flushes onMount: the pre-mount $state
    // default must already be off, or a genuinely absent-global host would
    // paint the Front Desk on for a frame no owner asked for.
    expect(container.querySelector('.fd-section')).toBeNull();
    await tick();
    expect(container.querySelector('.fd-section')).toBeNull();
  });
});

// THE MESSAGE NAMES. The messenger rewrite moved every one of these controls to
// a different component; a rename in transit would be invisible to a rendered
// test that clicked the new button and asserted the new name.
describe('no flock message type was renamed by the messenger wave', () => {
  const FILES = [
    'webview/dashboard/panes/FlockPane.svelte',
    'webview/dashboard/components/FlockSide.svelte',
    // The Edit popover posts `flockSetPolicy` now: the per-contact overrides
    // left the Permissions chip for the contact's own thread head.
    'webview/dashboard/components/FlockContactScope.svelte',
    'webview/dashboard/components/FlockRowActions.svelte',
    'webview/dashboard/panes/flockDeliverTargets.ts',
    'webview/chat/FrontDeskSection.svelte',
  ];
  const EXPECTED = [
    'flockAccept',
    'flockBrowseFolder',
    'flockDecide',
    'flockDeliver',
    'flockFollowUp',
    'flockFrontDesk',
    'flockInvite',
    'flockMailboxRequest',
    'flockMark',
    'flockOpenChat',
    'flockRequest',
    'flockRevoke',
    'flockScopeOptions',
    'flockSend',
    'flockSetEnabled',
    'flockSetIdentity',
    'flockSetPolicy',
    'flockSetSpecialties',
  ];

  it('every type these files post is one the host already routes', () => {
    const posted = new Set<string>();
    for (const rel of FILES) {
      for (const m of read(rel).matchAll(/type:\s*'(flock[A-Za-z]+)'/g)) posted.add(m[1]!);
    }
    // Guards the scan itself: a regex that matched nothing would pass the
    // subset assertion below on an empty set.
    expect(posted.size).toBeGreaterThan(10);
    expect([...posted].filter((t) => !EXPECTED.includes(t))).toEqual([]);
  });

  it('and every one of the pane’s own writes is still posted by SOME file on the path', () => {
    const all = FILES.map(read).join('\n');
    for (const type of EXPECTED) {
      if (type === 'flockScopeOptions' || type === 'flockRequest' || type === 'flockMailboxRequest') continue;
      expect(all, `${type} is posted by nothing any more`).toContain(`'${type}'`);
    }
  });
});
