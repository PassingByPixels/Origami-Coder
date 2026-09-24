// browserAutoApproveControl.test.ts — the composer's Browser Ask/Bypass
// control's host-side read/write (src/dashboard/browserAutoApproveControl.ts,
// t-kgsupy round 3). Driven against a faked `vscode` module, the same harness
// pattern browserToolsConsent.test.ts uses for the sibling reads/writes of
// this exact setting.
//
// What this pins: Bypass writes `true`; Ask writes an EXPLICIT `false`
// (t-obf3jw: since bypass is now the default, removing the entry would read
// back as bypass — the opposite of "Ask"); a broadcast always carries the
// LIVE value, read fresh off `vscode.workspace.getConfiguration()`
// rather than any cached local state, so a value changed outside Origami
// (Settings UI, another window) is never stale. A rejected write broadcasts
// too (fix round, verifier-confirmed): InputBar's popover sets its notch
// optimistically before the write resolves, so a caught rejection still has
// to correct the client back to the real on-disk value.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    settings: {} as Record<string, unknown>,
    updates: [] as Array<{ key: string; value: unknown; target: unknown }>,
    updateThrows: false,
    errorCalls: [] as unknown[][],
  },
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: (...args: unknown[]) => { fake.errorCalls.push(args); },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => fake.settings[key],
      update: async (key: string, value: unknown, target: unknown) => {
        if (fake.updateThrows) throw new Error('workspace is untrusted');
        if (value === undefined) delete fake.settings[key];
        else fake.settings[key] = value;
        fake.updates.push({ key, value, target });
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import { broadcastBrowserAutoApprove, setBrowserAutoApprove } from '../../../src/dashboard/browserAutoApproveControl';

function fakeHost() {
  const posts: Array<Record<string, unknown>> = [];
  return { host: { post: (msg: Record<string, unknown>) => posts.push(msg) }, posts };
}

// t-obf3jw: bypass-browser is now the DEFAULT. globalAutoApprove()
// (browserVsCode.ts) reads anything other than an EXPLICIT `false` as
// bypass, so an absent setting — or a malformed one — reads as true; only a
// deliberate `false` (the OFF switch) reads as Ask.
describe('broadcastBrowserAutoApprove — reads LIVE, never cached', () => {
  beforeEach(() => { fake.settings = {}; fake.updates = []; });

  it('absent reads as true (Bypass) — the default, no setup needed', () => {
    const { host, posts } = fakeHost();
    broadcastBrowserAutoApprove(host);
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: true }]);
  });

  it('explicit false on disk (the OFF switch, set outside Origami) reads as false (Ask)', () => {
    fake.settings['chat.tools.global.autoApprove'] = false;
    const { host, posts } = fakeHost();
    broadcastBrowserAutoApprove(host);
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: false }]);
  });

  it('true on disk (set outside Origami — Settings UI, another window) reads as true (Bypass)', () => {
    fake.settings['chat.tools.global.autoApprove'] = true;
    const { host, posts } = fakeHost();
    broadcastBrowserAutoApprove(host);
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: true }]);
  });

  it('a non-boolean stray value (e.g. a string) reads as true — only an explicit false is Ask', () => {
    fake.settings['chat.tools.global.autoApprove'] = 'yes';
    const { host, posts } = fakeHost();
    broadcastBrowserAutoApprove(host);
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: true }]);
  });
});

// t-obf3jw: Ask now writes an EXPLICIT `false`, not `undefined`. Removing the
// entry would read back as bypass (the new default) — the opposite of what
// "Ask" was asked for.
describe('setBrowserAutoApprove — Bypass writes true, Ask writes an explicit false', () => {
  beforeEach(() => { fake.settings = {}; fake.updates = []; fake.updateThrows = false; fake.errorCalls = []; });

  it('Bypass (true): writes true via ConfigurationTarget.Global, then broadcasts true', async () => {
    const { host, posts } = fakeHost();
    await setBrowserAutoApprove(host, true);
    expect(fake.updates).toEqual([{ key: 'chat.tools.global.autoApprove', value: true, target: 1 }]);
    expect(fake.settings['chat.tools.global.autoApprove']).toBe(true);
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: true }]);
  });

  it('Ask (false): writes an explicit false — NOT removed, or it would read back as bypass', async () => {
    fake.settings['chat.tools.global.autoApprove'] = true; // was on
    const { host, posts } = fakeHost();
    await setBrowserAutoApprove(host, false);
    expect(fake.updates).toEqual([{ key: 'chat.tools.global.autoApprove', value: false, target: 1 }]);
    expect(fake.settings['chat.tools.global.autoApprove']).toBe(false);
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: false }]);
  });

  it('never touches the sibling chat.tools.eligibleForAutoApproval setting', async () => {
    const { host } = fakeHost();
    await setBrowserAutoApprove(host, true);
    expect(fake.settings['chat.tools.eligibleForAutoApproval']).toBeUndefined();
  });

  // A rejected write (e.g. an untrusted workspace) must not read as success —
  // a visible toast instead of an unhandled rejection the message-handler
  // loop would otherwise swallow — but it must ALSO correct the client: the
  // popover already flipped its notch optimistically before this write
  // resolved, so silence here would strand the gauge on a guess forever.
  // broadcastBrowserAutoApprove re-reads config LIVE, so the broadcast value
  // is the real unchanged setting, never the attempted (failed) `value`.
  it('a rejected write shows an error toast AND broadcasts the corrective live value — never a false "it worked", never a stale client', async () => {
    fake.updateThrows = true;
    const { host, posts } = fakeHost();
    await setBrowserAutoApprove(host, true); // attempted Bypass; write throws, nothing on disk
    // live value, unchanged — nothing was ever written, so the default (bypass) still reads true
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: true }]);
    expect(fake.errorCalls).toHaveLength(1);
    expect(String(fake.errorCalls[0][0])).toMatch(/could not update/i);
  });

  // The dangerous direction, named explicitly: Bypass is ON (every chat tool,
  // every workspace, auto-approved). The user clicks Ask to turn it OFF. The
  // explicit-`false` write throws. Without the corrective broadcast, the
  // gauge would show plain "Browser" (looks off/safe) while the real setting
  // is still `true` — the opposite of "state mirrors the live setting".
  it('un-bypassing that fails still broadcasts true — the gauge must not show "safe" while the real setting stays on', async () => {
    fake.settings['chat.tools.global.autoApprove'] = true; // Bypass was on
    fake.updateThrows = true;
    const { host, posts } = fakeHost();
    await setBrowserAutoApprove(host, false); // user clicks Ask
    expect(posts).toEqual([{ type: 'browserAutoApproveUpdate', value: true }]); // still true — corrects the optimistic "Ask" back to "Bypass"
    expect(fake.settings['chat.tools.global.autoApprove']).toBe(true); // write never took
  });
});
