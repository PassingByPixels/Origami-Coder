// browserToolsConsent.test.ts — the once-ever offer to REPAIR browser-tool
// auto-approval (src/browserToolsConsent.ts), driven against a faked `vscode`
// module (the harness pattern from browserBridge.test.ts). Each case guards a
// specific regression: asking twice, overwriting a sibling tool's entry in the
// shared eligibleForAutoApproval map, and — the one this file exists for now —
// prompting on a stock machine where the write would be a NO-OP.
//
// That last case is the round-1 UAT failure written down as a test. The flow
// shipped believing `{"openBrowserPage": true}` would remove the "Open Browser
// Page?" modal; the modal still appeared, because
// `isToolEligibleForAutoApproval` RETURNS TRUE when the key is absent. Writing
// `true` over an absent key changes nothing, so the prompt promised something it
// could not deliver. Only an explicit `false` is worth asking about.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    infoCalls: [] as unknown[][],
    infoReply: undefined as string | undefined,
    settings: {} as Record<string, unknown>,
    updates: [] as Array<{ key: string; value: unknown; target: unknown }>,
  },
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: async (...args: unknown[]) => {
      fake.infoCalls.push(args);
      return fake.infoReply;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => fake.settings[key],
      // Mirrors VS Code: inspect() reports a scope value only when the key was
      // explicitly configured; update(key, undefined) removes the entry.
      inspect: (key: string) => (key in fake.settings ? { globalValue: fake.settings[key] } : undefined),
      update: async (key: string, value: unknown, target: unknown) => {
        if (value === undefined) delete fake.settings[key];
        else fake.settings[key] = value;
        fake.updates.push({ key, value, target });
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import {
  ensureBrowserToolsConsent,
  ensureYoloAutoApproveConsent,
  isBarredFromAutoApproval,
  mergeAutoApprovalSetting,
} from '../../../src/browserToolsConsent';

/** A minimal fake ExtensionContext.globalState — the only member this feature touches. */
function makeContext(flag?: boolean) {
  const store: Record<string, unknown> = flag === undefined ? {} : { 'origami.browserToolsConsent.v1': flag };
  return {
    globalState: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => { store[key] = value; },
    },
    _store: store,
  } as unknown as { globalState: { get: <T>(k: string) => T | undefined }; _store: Record<string, unknown> };
}

describe('mergeAutoApprovalSetting (pure read-merge-write)', () => {
  it('adds the tool id to an empty/absent map', () => {
    expect(mergeAutoApprovalSetting(undefined, 'openBrowserPage', true)).toEqual({ openBrowserPage: true });
  });

  it('preserves every sibling key already in the map, touching only the given id', () => {
    const current = { someOtherTool: true, aThirdTool: false };
    expect(mergeAutoApprovalSetting(current, 'openBrowserPage', true))
      .toEqual({ someOtherTool: true, aThirdTool: false, openBrowserPage: true });
  });

  it('overwrites only the SAME id on a second merge, not a fresh object each time', () => {
    const once = mergeAutoApprovalSetting({ keep: 1 }, 'openBrowserPage', true);
    const twice = mergeAutoApprovalSetting(once, 'openBrowserPage', false);
    expect(twice).toEqual({ keep: 1, openBrowserPage: false });
  });
});

describe('ensureBrowserToolsConsent', () => {
  beforeEach(() => {
    fake.infoCalls = []; fake.settings = {}; fake.updates = []; fake.infoReply = undefined;
  });

  it('asked once ever: the flag already true means NO prompt and no setting write', async () => {
    const ctx = makeContext(true);
    await ensureBrowserToolsConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it('already-set on disk (the "applied by hand" case): skips the prompt, still sets the flag', async () => {
    fake.settings = { 'chat.tools.eligibleForAutoApproval': { openBrowserPage: true } };
    const ctx = makeContext(undefined);
    await ensureBrowserToolsConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(0); // no popup
    expect(ctx._store['origami.browserToolsConsent.v1']).toBe(true); // never asks again
    expect(fake.updates).toHaveLength(0); // setting itself untouched (already correct)
  });

  // The round-1 UAT failure, as a test. A stock machine has no entry for the
  // tool, and an absent entry ALREADY means eligible — so writing `true` would
  // change nothing while the prompt claimed a popup would stop appearing.
  it('stock machine (no entry at all): asks NOTHING, because writing true would be a no-op', async () => {
    fake.settings = {};
    const ctx = makeContext(undefined);
    await ensureBrowserToolsConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
    expect(ctx._store['origami.browserToolsConsent.v1']).toBe(true);
  });

  it('a map holding only OTHER tools is still not a reason to ask — this tool is unbarred', async () => {
    fake.settings = { 'chat.tools.eligibleForAutoApproval': { fetch: false, runTask: false } };
    const ctx = makeContext(undefined);
    await ensureBrowserToolsConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it('Yes (barred): merges true back in via ConfigurationTarget.Global, preserving siblings, sets the flag', async () => {
    fake.settings = { 'chat.tools.eligibleForAutoApproval': { someOtherTool: true, openBrowserPage: false } };
    fake.infoReply = 'Yes';
    const ctx = makeContext(undefined);
    await ensureBrowserToolsConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(1);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0].key).toBe('chat.tools.eligibleForAutoApproval');
    expect(fake.updates[0].value).toEqual({ someOtherTool: true, openBrowserPage: true });
    expect(fake.updates[0].target).toBe(1); // ConfigurationTarget.Global
    expect(ctx._store['origami.browserToolsConsent.v1']).toBe(true);
    // The two settings this feature must NEVER touch. The first is the one VS
    // Code itself calls "YOLO mode"; it is the ONLY lever that would actually
    // suppress the modal, and that is precisely why it stays unwritten.
    expect(fake.settings['chat.tools.global.autoApprove']).toBeUndefined();
    expect(fake.settings['workbench.browser.enableChatTools']).toBeUndefined();
  });

  it('the prompt does not promise the agent-driven confirmation goes away', async () => {
    fake.settings = { 'chat.tools.eligibleForAutoApproval': { openBrowserPage: false } };
    fake.infoReply = 'No';
    const ctx = makeContext(undefined);
    await ensureBrowserToolsConsent(ctx as never);
    expect(String(fake.infoCalls[0][0])).toMatch(/does not remove the confirmation/i);
  });

  it('No: sets the flag (never asks again) and writes nothing to the setting', async () => {
    fake.settings = { 'chat.tools.eligibleForAutoApproval': { openBrowserPage: false } };
    fake.infoReply = 'No';
    const ctx = makeContext(undefined);
    await ensureBrowserToolsConsent(ctx as never);
    expect(fake.updates).toHaveLength(0);
    expect(ctx._store['origami.browserToolsConsent.v1']).toBe(true);
  });

  it('dismissed (Escape / click-away): sets NEITHER the flag nor the setting, so it asks again next time', async () => {
    fake.settings = { 'chat.tools.eligibleForAutoApproval': { openBrowserPage: false } };
    const ctx = makeContext(undefined);
    await ensureBrowserToolsConsent(ctx as never);
    expect(fake.updates).toHaveLength(0);
    expect(ctx._store['origami.browserToolsConsent.v1']).toBeUndefined();
  });
});

// The YOLO-on-install flow (t-kgsupy, owner-directed default-on, 2026-08-11).
// SUPERSEDED round 3 (2026-08-12, owner direction): the ABSENT branch that
// used to apply default-on then disclose it is DELETED — that decision now
// lives in the composer's explicit Browser control, and nothing calls this
// function from activation any more. Two branches remain, tested as what is
// LEFT rather than what the flow used to do: explicitly-false = a QUESTION
// (write only on "Turn on", dismiss re-asks); already-true = silent. A
// SEPARATE boolean setting and a SEPARATE globalState flag from the repair
// prompt above.
describe('ensureYoloAutoApproveConsent', () => {
  beforeEach(() => {
    fake.infoCalls = []; fake.settings = {}; fake.updates = []; fake.infoReply = undefined;
  });

  it('asked once ever: the flag already true means NO prompt and no setting write', async () => {
    const ctx = makeContext(undefined);
    ctx._store['origami.yoloAutoApproveConsent.v1'] = true;
    await ensureYoloAutoApproveConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it('already true on disk (this machine): skips the prompt silently, still sets the flag', async () => {
    fake.settings = { 'chat.tools.global.autoApprove': true };
    const ctx = makeContext(undefined);
    await ensureYoloAutoApproveConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
    expect(ctx._store['origami.yoloAutoApproveConsent.v1']).toBe(true);
  });

  // t-kgsupy round 3 (owner direction): the ABSENT branch that used to write
  // `true` and disclose it is DELETED. Absent now falls all the way through
  // ensureYoloAutoApproveConsent with no prompt, no write, and — because
  // nothing sets it — no flag either, so a future call (if anything ever
  // called this function again) would still see it as unresolved. That is a
  // dead-code detail: nothing calls this function from activation any more
  // (see DashboardPanel.ts's initialize()) — the decision lives in the
  // composer's explicit Browser control (browserAutoApproveControl.ts).
  it('ABSENT: does nothing now — no prompt, no write, no flag (superseded by the explicit Browser control)', async () => {
    const ctx = makeContext(undefined);
    await ensureYoloAutoApproveConsent(ctx as never);
    expect(fake.infoCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
    expect(fake.settings['chat.tools.global.autoApprove']).toBeUndefined();
    expect(ctx._store['origami.yoloAutoApproveConsent.v1']).toBeUndefined();
  });

  // The disclosure wording survives in the one branch that remains: a
  // deliberate prior "off" still gets asked about, in the same words the
  // (now-deleted) install-time disclosure used.
  it('the EXPLICIT-FALSE question still names ALL chat tools, ALL workspaces, and YOLO mode', async () => {
    fake.settings = { 'chat.tools.global.autoApprove': false };
    const ctx = makeContext(undefined);
    await ensureYoloAutoApproveConsent(ctx as never);
    const text = String(fake.infoCalls[0][0]);
    expect(text).toMatch(/ALL chat tools/);
    expect(text).toMatch(/ALL workspaces/i);
    expect(text).toMatch(/YOLO mode/i);
  });

  it('EXPLICIT false: asks a question and writes NOTHING without an affirmative click', async () => {
    fake.settings = { 'chat.tools.global.autoApprove': false };
    fake.infoReply = 'Keep off';
    const ctx = makeContext(undefined);
    await ensureYoloAutoApproveConsent(ctx as never);
    expect(fake.settings['chat.tools.global.autoApprove']).toBe(false);
    expect(fake.updates).toHaveLength(0);
    expect(ctx._store['origami.yoloAutoApproveConsent.v1']).toBe(true);
  });

  it('EXPLICIT false + "Turn on": writes true and sets the flag', async () => {
    fake.settings = { 'chat.tools.global.autoApprove': false };
    fake.infoReply = 'Turn on';
    const ctx = makeContext(undefined);
    await ensureYoloAutoApproveConsent(ctx as never);
    expect(fake.settings['chat.tools.global.autoApprove']).toBe(true);
    expect(ctx._store['origami.yoloAutoApproveConsent.v1']).toBe(true);
  });

  // A prior deliberate opt-out survives a dismissed QUESTION across repeated
  // activations — the exact failure scenario the security review named. The
  // question re-asks (no flag), but never writes.
  it('a deliberate prior false survives repeated dismissals across activations, and the question re-asks', async () => {
    fake.settings = { 'chat.tools.global.autoApprove': false };
    fake.infoReply = undefined;
    const ctx = makeContext(undefined);
    await ensureYoloAutoApproveConsent(ctx as never);
    await ensureYoloAutoApproveConsent(ctx as never);
    expect(fake.settings['chat.tools.global.autoApprove']).toBe(false);
    expect(fake.updates).toHaveLength(0);
    expect(fake.infoCalls).toHaveLength(2);
    expect(ctx._store['origami.yoloAutoApproveConsent.v1']).toBeUndefined();
  });

  it('never touches chat.tools.eligibleForAutoApproval — the two flows are isolated', async () => {
    const ctx = makeContext(undefined);
    await ensureYoloAutoApproveConsent(ctx as never);
    expect(fake.settings['chat.tools.eligibleForAutoApproval']).toBeUndefined();
  });
});

describe('isBarredFromAutoApproval — absent is NOT off', () => {
  it('only an explicit false bars the tool', () => {
    expect(isBarredFromAutoApproval({ openBrowserPage: false }, 'openBrowserPage')).toBe(true);
  });

  it('absent reads as unbarred, because VS Code defaults the gate open', () => {
    expect(isBarredFromAutoApproval(undefined, 'openBrowserPage')).toBe(false);
    expect(isBarredFromAutoApproval({}, 'openBrowserPage')).toBe(false);
    expect(isBarredFromAutoApproval({ fetch: false }, 'openBrowserPage')).toBe(false);
  });

  it('true reads as unbarred', () => {
    expect(isBarredFromAutoApproval({ openBrowserPage: true }, 'openBrowserPage')).toBe(false);
  });

  it('a malformed value is left alone rather than treated as barred', () => {
    expect(isBarredFromAutoApproval({ openBrowserPage: 'false' }, 'openBrowserPage')).toBe(false);
    expect(isBarredFromAutoApproval({ openBrowserPage: 0 }, 'openBrowserPage')).toBe(false);
  });
});
