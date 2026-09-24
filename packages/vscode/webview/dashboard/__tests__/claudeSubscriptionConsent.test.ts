// claudeSubscriptionConsent.test.ts — the one-time disclosure
// origami.experimentalClaudeSubscription requires before it stays on
// (src/claudeSubscriptionConsent.ts), driven against a faked `vscode` module
// (browserToolsConsent.test.ts's harness).
//
// The regression this guards: leaving a billing-and-account-risk setting ON
// after a dismissed or declined dialog. Every "not Enable" path — Cancel,
// Escape, click-away (undefined reply) — must revert the setting, unlike the
// browser-tool repair prompt this file is modelled on, which is safe to leave
// unresolved because ITS baseline is already off.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    warnCalls: [] as unknown[][],
    warnReply: undefined as string | undefined,
    settings: {} as Record<string, unknown>,
    updates: [] as Array<{ key: string; value: unknown; target: unknown }>,
  },
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: async (...args: unknown[]) => {
      fake.warnCalls.push(args);
      return fake.warnReply;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => fake.settings[key],
      update: async (key: string, value: unknown, target: unknown) => {
        fake.settings[key] = value;
        fake.updates.push({ key, value, target });
      },
    }),
  },
  ConfigurationTarget: { Global: 1 },
}));

import {
  DISCLOSURE_TEXT, confirmClaudeSubscriptionDisclosure, ensureClaudeSubscriptionConsent, watchClaudeSubscriptionSetting,
} from '../../../src/claudeSubscriptionConsent';
import { CLAUDE_SUBSCRIPTION_SETTING, CLAUDE_SUBSCRIPTION_SETTING_ID } from '../../../src/claudeSubscriptionFlag';

function makeContext(flag?: boolean) {
  const store: Record<string, unknown> = flag === undefined ? {} : { 'origami.claudeSubscriptionDisclosure.v1': flag };
  return {
    globalState: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => { store[key] = value; },
    },
    _store: store,
  } as unknown as { globalState: { get: <T>(k: string) => T | undefined }; _store: Record<string, unknown> };
}

beforeEach(() => {
  fake.warnCalls = []; fake.warnReply = undefined; fake.settings = {}; fake.updates = [];
});

describe('the disclosure text', () => {
  it('names the billing rate, the account risk, and links the legal page', () => {
    expect(DISCLOSURE_TEXT).toMatch(/Agent SDK rate/);
    expect(DISCLOSURE_TEXT).toMatch(/act on your account/);
    expect(DISCLOSURE_TEXT).toContain('https://www.anthropic.com/legal');
  });
});

describe('confirmClaudeSubscriptionDisclosure', () => {
  it('asked once ever: the flag already true skips the dialog', async () => {
    const ctx = makeContext(true);
    expect(await confirmClaudeSubscriptionDisclosure(ctx as never)).toBe(true);
    expect(fake.warnCalls).toHaveLength(0);
  });

  it('"Enable" confirms and remembers', async () => {
    fake.warnReply = 'Enable';
    const ctx = makeContext(undefined);
    expect(await confirmClaudeSubscriptionDisclosure(ctx as never)).toBe(true);
    expect(ctx._store['origami.claudeSubscriptionDisclosure.v1']).toBe(true);
  });

  it('a dismiss (no reply) declines and remembers NOTHING — it asks again next time', async () => {
    const ctx = makeContext(undefined);
    expect(await confirmClaudeSubscriptionDisclosure(ctx as never)).toBe(false);
    expect(ctx._store['origami.claudeSubscriptionDisclosure.v1']).toBeUndefined();
  });

  it('the dialog is MODAL — a click-away must not silently count as consent', async () => {
    const ctx = makeContext(undefined);
    await confirmClaudeSubscriptionDisclosure(ctx as never);
    expect(fake.warnCalls[0]![1]).toEqual({ modal: true });
  });
});

describe('ensureClaudeSubscriptionConsent — activation-time repair', () => {
  it('the setting is off: does nothing at all', async () => {
    const ctx = makeContext(undefined);
    await ensureClaudeSubscriptionConsent(ctx as never);
    expect(fake.warnCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it('on + already consented: no dialog, setting untouched', async () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    const ctx = makeContext(true);
    await ensureClaudeSubscriptionConsent(ctx as never);
    expect(fake.warnCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it('on + never consented (synced settings): asks, and "Enable" leaves it on', async () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    fake.warnReply = 'Enable';
    const ctx = makeContext(undefined);
    await ensureClaudeSubscriptionConsent(ctx as never);
    expect(fake.warnCalls).toHaveLength(1);
    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBe(true);
    expect(fake.updates).toHaveLength(0); // "Enable" writes no setting, only the flag
  });

  it('on + declined: reverts the setting to false, via ConfigurationTarget.Global', async () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    fake.warnReply = 'Cancel';
    const ctx = makeContext(undefined);
    await ensureClaudeSubscriptionConsent(ctx as never);
    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBe(false);
    expect(fake.updates[0]).toEqual({ key: CLAUDE_SUBSCRIPTION_SETTING, value: false, target: 1 });
  });

  it('on + dismissed: reverts the setting too — an unconfirmed billing feature must not sit on', async () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    const ctx = makeContext(undefined);
    await ensureClaudeSubscriptionConsent(ctx as never);
    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBe(false);
  });
});

describe('watchClaudeSubscriptionSetting — the live flip', () => {
  it('OFF -> ON with "Enable": stays on, flag set', async () => {
    const ctx = makeContext(undefined);
    let handler: ((e: unknown) => unknown) | undefined;
    fake.warnReply = 'Enable';

    // Wire the watcher against a minimal fake onDidChangeConfiguration.
    const vscode = await import('vscode');
    (vscode.workspace as unknown as { onDidChangeConfiguration: (cb: (e: unknown) => unknown) => { dispose(): void } })
      .onDidChangeConfiguration = (cb) => { handler = cb; return { dispose() {} }; };

    watchClaudeSubscriptionSetting(ctx as never);
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true; // the user just flipped it in Settings
    await handler!({ affectsConfiguration: (id: string) => id === CLAUDE_SUBSCRIPTION_SETTING_ID });

    expect(fake.warnCalls).toHaveLength(1);
    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBe(true);
  });

  it('OFF -> ON dismissed: reverted', async () => {
    const ctx = makeContext(undefined);
    let handler: ((e: unknown) => unknown) | undefined;
    const vscode = await import('vscode');
    (vscode.workspace as unknown as { onDidChangeConfiguration: (cb: (e: unknown) => unknown) => { dispose(): void } })
      .onDidChangeConfiguration = (cb) => { handler = cb; return { dispose() {} }; };

    watchClaudeSubscriptionSetting(ctx as never);
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    await handler!({ affectsConfiguration: (id: string) => id === CLAUDE_SUBSCRIPTION_SETTING_ID });

    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBe(false);
  });

  it('a change to a DIFFERENT setting is ignored entirely', async () => {
    const ctx = makeContext(undefined);
    let handler: ((e: unknown) => unknown) | undefined;
    const vscode = await import('vscode');
    (vscode.workspace as unknown as { onDidChangeConfiguration: (cb: (e: unknown) => unknown) => { dispose(): void } })
      .onDidChangeConfiguration = (cb) => { handler = cb; return { dispose() {} }; };

    watchClaudeSubscriptionSetting(ctx as never);
    await handler!({ affectsConfiguration: () => false });
    expect(fake.warnCalls).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });
});
