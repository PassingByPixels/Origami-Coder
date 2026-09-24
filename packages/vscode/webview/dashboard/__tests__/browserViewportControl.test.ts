// browserViewportControl.test.ts — the Settings section's Browser card, host side
// (src/dashboard/browserViewportControl.ts, t-ntmm93). Same faked-`vscode` harness
// as browserAutoApproveControl.test.ts, because it is the same kind of seam: a
// GLOBAL settings read/write with an optimistic client on the other end.
//
// What this pins:
//   1. A broadcast carries the LIVE settings, never cached state — a value changed
//      in VS Code's own Settings editor must not read back stale here.
//   2. A typed size is clamped BEFORE it is persisted, so the stored setting is
//      always one a page could actually have.
//   3. A rejected write still broadcasts, because the card sets its inputs
//      optimistically and has to be snapped back to what is on disk.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    settings: {} as Record<string, unknown>,
    updates: [] as Array<{ key: string; value: unknown }>,
    updateThrows: false,
    errors: 0,
  },
}));

vi.mock('vscode', () => ({
  window: { showErrorMessage: () => { fake.errors += 1; } },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => fake.settings[key],
      update: async (key: string, value: unknown) => {
        if (fake.updateThrows) throw new Error('workspace is untrusted');
        fake.settings[key] = value;
        fake.updates.push({ key, value });
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import {
  broadcastBrowserViewport,
  setBrowserOpenBeside,
  setBrowserReveal,
  setBrowserViewport,
} from '../../../src/dashboard/browserViewportControl';

function host() {
  const posted: Record<string, unknown>[] = [];
  return { posted, post: (msg: Record<string, unknown>) => { posted.push(msg); } };
}

beforeEach(() => {
  fake.settings = {};
  fake.updates = [];
  fake.updateThrows = false;
  fake.errors = 0;
});

describe('broadcastBrowserViewport', () => {
  it('broadcasts the 1920x1080 default, open-beside ON, out of the box', () => {
    const h = host();
    broadcastBrowserViewport(h);
    expect(h.posted).toEqual([
      { type: 'browserViewportUpdate', width: 1920, height: 1080, beside: true, reveal: 'first' },
    ]);
  });

  it('reads the settings LIVE, so an external change is never stale', () => {
    const h = host();
    fake.settings['origami.browser.viewportWidth'] = 1280;
    fake.settings['origami.browser.viewportHeight'] = 720;
    fake.settings['origami.browser.openBeside'] = false;
    fake.settings['origami.browser.reveal'] = 'never';
    broadcastBrowserViewport(h);
    expect(h.posted[0]).toEqual({
      type: 'browserViewportUpdate',
      width: 1280,
      height: 720,
      beside: false,
      reveal: 'never',
    });
  });
});

describe('setBrowserViewport', () => {
  it('writes both sides and broadcasts what landed', async () => {
    const h = host();
    await setBrowserViewport(h, 1366, 768);
    expect(fake.updates).toEqual([
      { key: 'origami.browser.viewportWidth', value: 1366 },
      { key: 'origami.browser.viewportHeight', value: 768 },
    ]);
    expect(h.posted.at(-1)).toMatchObject({ width: 1366, height: 768 });
  });

  it('clamps before it persists — a typo never becomes a stored viewport', async () => {
    const h = host();
    await setBrowserViewport(h, 3, 99999);
    expect(fake.updates.map((u) => u.value)).toEqual([50, 9999]);
  });

  it('broadcasts even when the write is REJECTED, to correct an optimistic card', async () => {
    const h = host();
    fake.updateThrows = true;
    await setBrowserViewport(h, 1366, 768);
    expect(fake.errors).toBeGreaterThan(0);
    // Nothing was stored, so the broadcast must still be the on-disk default.
    expect(h.posted.at(-1)).toMatchObject({ width: 1920, height: 1080 });
  });
});

describe('setBrowserOpenBeside', () => {
  it('writes the switch and broadcasts the new value', async () => {
    const h = host();
    await setBrowserOpenBeside(h, false);
    expect(fake.updates).toEqual([{ key: 'origami.browser.openBeside', value: false }]);
    expect(h.posted.at(-1)).toMatchObject({ beside: false });
  });
});

describe('setBrowserReveal (t-qcwpyy)', () => {
  it('writes the policy and broadcasts it back', async () => {
    const h = host();
    await setBrowserReveal(h, 'never');
    expect(fake.updates).toEqual([{ key: 'origami.browser.reveal', value: 'never' }]);
    expect(h.posted.at(-1)).toMatchObject({ reveal: 'never' });
  });

  it('a value outside the three is stored as the default, never raw', async () => {
    // The card is the only writer today, but a stored "sometimes" would read
    // back as "first" anyway — persisting it would be a setting the Settings
    // editor shows as invalid for no gain.
    const h = host();
    await setBrowserReveal(h, 'sometimes');
    expect(fake.updates).toEqual([{ key: 'origami.browser.reveal', value: 'first' }]);
  });
});
