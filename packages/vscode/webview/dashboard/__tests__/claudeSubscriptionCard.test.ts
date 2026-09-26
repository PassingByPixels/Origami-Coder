// claudeSubscriptionCard.test.ts — the Connections "Claude (subscription,
// experimental)" card (t-tsw90t): add (disclosure -> the ONE setting),
// decline, disconnect, and every readiness state's status line + fix line,
// against a faked `vscode` module and a fake engine client — plus the
// Svelte card itself, driven by the exact `claudeSubscriptionStatus` shape
// the host posts.
//
// The regression this guards: a second flag. Add/disconnect must touch
// ONLY origami.experimentalClaudeSubscription — the setting the Settings
// toggle and the engine spawn overlay both already read.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

const { fake } = vi.hoisted(() => ({
  fake: {
    warnReply: undefined as string | undefined,
    settings: {} as Record<string, unknown>,
    updates: [] as Array<{ key: string; value: unknown; target: unknown }>,
    cli: null as { version?: string; binary?: string } | null,
  },
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: async () => fake.warnReply,
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

vi.mock('../../../src/dashboard/claudeCodeDetect', () => ({
  claudeCli: async () => fake.cli,
}));

import { handleClaudeSubscriptionCardMessage } from '../../../src/dashboard/claudeSubscriptionCard';
import { CLAUDE_SUBSCRIPTION_SETTING } from '../../../src/claudeSubscriptionFlag';
import { resetClaudeSubscriptionStatusCache } from '../../../src/claudeSubscription/engineStatus';
import ClaudeSubscriptionCard, { claudeSubscriptionTiles } from '../../sidebar/ClaudeSubscriptionCard.svelte';
import { nameLines } from '../../sidebar/connectionCarouselFit';

function makeContext(consented?: boolean) {
  const store: Record<string, unknown> = consented === undefined ? {} : { 'origami.claudeSubscriptionDisclosure.v1': consented };
  return { globalState: { get: (k: string) => store[k], update: async (k: string, v: unknown) => { store[k] = v; } } } as never;
}

beforeEach(() => {
  fake.warnReply = undefined;
  fake.settings = {};
  fake.updates = [];
  fake.cli = null;
  resetClaudeSubscriptionStatusCache(); // engineStatus.ts caches 5s by wall clock — stale across cases otherwise
});
afterEach(() => cleanup());

describe('handleClaudeSubscriptionCardMessage — add / decline / disconnect', () => {
  const post = vi.fn();
  beforeEach(() => post.mockClear());

  it('add + Confirm: turns the ONE setting on, no second flag', async () => {
    fake.warnReply = 'Enable';
    const host = { context: makeContext(undefined), post, engineClient: async () => undefined };
    await handleClaudeSubscriptionCardMessage(host, { type: 'claudeSubscriptionAdd' });
    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBe(true);
    expect(fake.updates).toEqual([{ key: CLAUDE_SUBSCRIPTION_SETTING, value: true, target: 1 }]);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'claudeSubscriptionStatus', enabled: true }));
  });

  it('add + decline (dismiss): the setting stays off', async () => {
    const host = { context: makeContext(undefined), post, engineClient: async () => undefined };
    await handleClaudeSubscriptionCardMessage(host, { type: 'claudeSubscriptionAdd' });
    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBeUndefined();
    expect(post).toHaveBeenLastCalledWith({ type: 'claudeSubscriptionStatus', enabled: false, ready: false, label: '', fixLine: '', cli: '' });
  });

  it('disconnect: turns the setting off, asks no consent', async () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true;
    const host = { context: makeContext(true), post, engineClient: async () => undefined };
    await handleClaudeSubscriptionCardMessage(host, { type: 'claudeSubscriptionDisconnect' });
    expect(fake.settings[CLAUDE_SUBSCRIPTION_SETTING]).toBe(false);
    expect(fake.updates).toEqual([{ key: CLAUDE_SUBSCRIPTION_SETTING, value: false, target: 1 }]);
  });

  it('ignores a message that is not its own', async () => {
    const host = { context: makeContext(true), post, engineClient: async () => undefined };
    await handleClaudeSubscriptionCardMessage(host, { type: 'somethingElse' });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('handleClaudeSubscriptionCardMessage — readiness through requestClaudeSubscriptionStatus', () => {
  const post = vi.fn();
  beforeEach(() => { post.mockClear(); fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = true; });

  it('disabled: no engine call at all, empty status', async () => {
    fake.settings[CLAUDE_SUBSCRIPTION_SETTING] = false;
    const engineClient = vi.fn(async () => ({ extMethod: vi.fn() }));
    const host = { context: makeContext(true), post, engineClient };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(engineClient).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ type: 'claudeSubscriptionStatus', enabled: false, ready: false, label: '', fixLine: '', cli: '' });
  });

  it('ready, via the engine (no chat open — hostEngine)', async () => {
    const extMethod = vi.fn(async () => ({ state: 'ready' }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(extMethod).toHaveBeenCalledWith('claude_subscription_status', {});
    expect(post).toHaveBeenCalledWith({ type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '', cli: '' });
  });

  // t-vd9s7z: the card names the binary the route uses, so "which claude?" has an answer on screen.
  const NATIVE = 'C:\\Users\\u\\.local\\bin\\claude.exe';
  const BUNDLED = 'C:\\Users\\u\\.vscode\\extensions\\anthropic.claude-code-2.1.281-win32-x64\\resources\\native-binary\\claude.exe';

  it('ready: names the binary and its version', async () => {
    const extMethod = vi.fn(async () => ({ state: 'ready', version: '2.1.281', path: BUNDLED }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ready: true, cli: `Uses Claude Code 2.1.281 at ${BUNDLED}.` }));
  });

  it('version-too-old, native install: names the binary and says to run claude update', async () => {
    const extMethod = vi.fn(async () => ({ state: 'version-too-old', found: '2.1.198', floor: '2.1.263', path: NATIVE }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      fixLine: `Claude Code 2.1.198 at ${NATIVE} is older than 2.1.263. Run "claude update" in a terminal, then reopen this panel.`,
    }));
  });

  it('version-too-old, VS Code extension copy: says to update the extension (claude update does not touch it)', async () => {
    const extMethod = vi.fn(async () => ({ state: 'version-too-old', found: '2.1.200', floor: '2.1.263', path: BUNDLED }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      fixLine: `Claude Code 2.1.200 at ${BUNDLED} is older than 2.1.263. Update the Claude Code extension in VS Code, then reopen this panel.`,
    }));
  });

  it('no engine: the local fallback names the binary discovery chose', async () => {
    fake.cli = { version: '2.1.198', binary: NATIVE };
    const host = { context: makeContext(true), post, engineClient: async () => undefined };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ fixLine: expect.stringContaining(`at ${NATIVE} is older`) }));
  });

  it('cli-missing: label + fix line, not ready', async () => {
    const extMethod = vi.fn(async () => ({ state: 'cli-missing' }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ready: false, label: 'CLI missing', fixLine: expect.stringMatching(/Install it/) }));
  });

  it('not-logged-in: label + fix line', async () => {
    const extMethod = vi.fn(async () => ({ state: 'not-logged-in' }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ready: false, label: 'Not signed in', fixLine: expect.stringMatching(/sign in/i) }));
  });

  it('version-too-old: label + fix line names both versions', async () => {
    const extMethod = vi.fn(async () => ({ state: 'version-too-old', found: '2.0.1', floor: '2.1.263' }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ready: false, label: 'Version too old', fixLine: expect.stringContaining('2.0.1') }));
  });

  it('unready (Gate B reason): label + verbatim reason as the fix line', async () => {
    const extMethod = vi.fn(async () => ({ state: 'weird-state', reason: 'ORIGAMI_EXPERIMENTAL_CLAUDE_SUBSCRIPTION conflicts with something' }));
    const host = { context: makeContext(true), post, engineClient: async () => ({ extMethod }) };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ ready: false, label: 'Not ready', fixLine: expect.stringContaining('conflicts') }));
  });

  it('no engine at all: falls back to the local CLI-discovery guess', async () => {
    fake.cli = { version: '2.1.263' };
    const host = { context: makeContext(true), post, engineClient: async () => undefined };
    await handleClaudeSubscriptionCardMessage(host, { type: 'requestClaudeSubscriptionStatus' });
    expect(post).toHaveBeenCalledWith({ type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '', cli: '' });
  });
});

describe('ClaudeSubscriptionCard.svelte — renders exactly what the host sends', () => {
  function post(data: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  it('renders nothing while disabled', () => {
    const { container } = render(ClaudeSubscriptionCard);
    post({ type: 'claudeSubscriptionStatus', enabled: false, ready: false, label: '', fixLine: '', cli: '' });
    expect(container.querySelector('.claude-sub-card')).toBeNull();
  });

  it('ready: status line, no fix line, Disconnect present', async () => {
    const { container, findByText } = render(ClaudeSubscriptionCard);
    post({ type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '' });
    await findByText('Ready');
    expect(container.querySelector('.claude-sub-status')?.classList.contains('live')).toBe(true);
    expect(container.querySelector('.claude-sub-hint')?.textContent).not.toMatch(/Install|sign in|older/);
    expect(container.querySelector('.claude-sub-disconnect')).not.toBeNull();
  });

  it('ready: shows the line that names the binary', async () => {
    const { findByText } = render(ClaudeSubscriptionCard);
    post({ type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '', cli: 'Uses Claude Code 2.1.281 at C:\\x\\claude.exe.' });
    await findByText('Uses Claude Code 2.1.281 at C:\\x\\claude.exe.');
  });

  it('not ready: shows the fix line and a non-live status', async () => {
    const { container, findByText } = render(ClaudeSubscriptionCard);
    post({ type: 'claudeSubscriptionStatus', enabled: true, ready: false, label: 'CLI missing', fixLine: 'Claude Code CLI not found. Install it, then reopen this panel.' });
    await findByText('CLI missing');
    expect(container.querySelector('.claude-sub-status')?.classList.contains('live')).toBe(false);
    expect(container.textContent).toContain('Install it');
  });

  it('Disconnect posts claudeSubscriptionDisconnect', async () => {
    const { findByText } = render(ClaudeSubscriptionCard);
    post({ type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '' });
    const button = await findByText('Disconnect');
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(button);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'claudeSubscriptionDisconnect' });
  });

  it('asks the host for status on mount', () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(ClaudeSubscriptionCard);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'requestClaudeSubscriptionStatus' });
  });
});

// t-xu5o64, owner UAT of 0.4.178: the strip's tile read "Claude (subscri..." and,
// unlike a provider tile, it has no "Pill name" to shorten it. It gets the short
// name by default; the experimental notice stays at the connection step.
describe('the connection strip tile', () => {
  it('reads "Claude (Sub)" on two whole lines', async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'claudeSubscriptionStatus', enabled: true, ready: true, label: 'Ready', fixLine: '' } }));
    const [tile] = claudeSubscriptionTiles(false, false);
    expect(tile?.title).toBe('Claude (Sub)');
    expect(nameLines(tile!.title)).toEqual(['Claude', '(Sub)']);
  });

  it('keeps the reason in the tooltip when not ready', async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'claudeSubscriptionStatus', enabled: true, ready: false, label: 'Not signed in', fixLine: 'Not logged in.' } }));
    const [tile] = claudeSubscriptionTiles(false, false);
    expect(tile?.title).toBe('Claude (Sub) — Not logged in.');
    expect(nameLines(tile!.title)).toEqual(['Claude', '(Sub)']);
  });
});
