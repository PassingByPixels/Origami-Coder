// claudeCodeDetect.test.ts — the MEMO in front of discovery.
//
// The old undetected tooltip ended "…install the CLI, then reload the window".
// The reload was not advice, it was the only way to drop a per-window memo, and
// it is why a user who fixed the problem still saw the pill say no. So the two
// things asserted here are: the memo really does stop a second probe, and the
// two events that must drop it (an explicit retry, a settings change) really do.
//
// `nodeDiscoveryDeps` is mocked, so nothing here reads the real filesystem, runs
// the real `claude`, or touches `vscode`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiscoveryDeps } from '../../../src/claudeCode/discovery';

/** Counts probe runs. `which` is the first impure call every walk makes. */
let walks = 0;

/** One unpacked Claude Code extension, so the bundled-binary row is real. */
const EXT_DIR_NAME = 'anthropic.claude-code-2.1.258-win32-x64';

vi.mock('../../../src/claudeCode/discoveryNode', () => ({
  settingValue: () => '',
  nodeDiscoveryDeps: (): DiscoveryDeps => ({
    platform: 'win32',
    env: { USERPROFILE: 'C:\\Users\\u' },
    setting: () => '',
    stat: () => 'none',
    listDir: () => [EXT_DIR_NAME],
    version: async () => ({ ok: false, error: 'not reached' }),
    which: async () => { walks++; return { hits: [], detail: 'where claude -> exit 1' }; },
  }),
}));

// The hand-off file (t-vd9s7z) lands under ORIGAMI_TEST_HOME, never the real ~/.origami.
const HOME = mkdtempSync(path.join(tmpdir(), 'claude-handoff-'));
process.env.ORIGAMI_TEST_HOME = HOME;
const HANDOFF = path.join(HOME, '.origami', 'claude-cli.json');

const { claudeCliDiscovery, probeClaudeCliInBackground, resetClaudeCliCache, statusPost } = await import('../../../src/dashboard/claudeCodeDetect');
const { handleClaudeCodeMessage } = await import('../../../src/dashboard/claudeCodeManager');
const { CLAUDE_CLI_FILE, claudeCliFilePath } = await import('../../../src/claudeCode/handoff');

beforeEach(() => { walks = 0; resetClaudeCliCache(); });

describe('the per-window memo', () => {
  it('probes once however many times the sidebar asks', async () => {
    await claudeCliDiscovery();
    await claudeCliDiscovery();
    await claudeCliDiscovery();
    expect(walks).toBe(1);
  });

  it('probes again after the cache is dropped', async () => {
    await claudeCliDiscovery();
    resetClaudeCliCache();
    await claudeCliDiscovery();
    expect(walks).toBe(2);
  });

  it('keeps the trail, not just the verdict, so a second ask can still explain itself', async () => {
    const result = await claudeCliDiscovery();
    expect(result.found).toBeUndefined();
    expect(result.probes.map((p) => p.source)).toContain('vscode-extension');
    expect((await claudeCliDiscovery()).probes).toEqual(result.probes);
  });
});

describe('the status message', () => {
  // A host with NEITHER test seam takes the production path — which is the one
  // that has to honour `refresh`, and the one no other suite exercises.
  const host = { post: () => undefined } as unknown as Parameters<typeof handleClaudeCodeMessage>[0];

  it('replays the memo on an ordinary status request', async () => {
    await handleClaudeCodeMessage(host, { type: 'requestClaudeCodeStatus' });
    await handleClaudeCodeMessage(host, { type: 'requestClaudeCodeStatus' });
    expect(walks).toBe(1);
  });

  it('re-probes when the user retries from the pill', async () => {
    await handleClaudeCodeMessage(host, { type: 'requestClaudeCodeStatus' });
    await handleClaudeCodeMessage(host, { type: 'requestClaudeCodeStatus', refresh: true });
    expect(walks).toBe(2);
  });

  it('reports not-installed with a tooltip that names what was tried', () => {
    const post = statusPost({ probes: [{ source: 'path', path: 'claude', result: 'missing' }] });
    expect(post).toMatchObject({ type: 'claudeCodeStatus', installed: false, version: '', binary: '', source: '' });
    expect(String(post.tooltip)).toContain('Probed: PATH (missing)');
  });
});

describe('the engine hand-off file (t-vd9s7z)', () => {
  it('a background probe writes the winner for the engine, without anyone awaiting it', async () => {
    probeClaudeCliInBackground(true);
    await vi.waitFor(() => expect(existsSync(HANDOFF)).toBe(true));
    const doc = JSON.parse(readFileSync(HANDOFF, 'utf8')) as Record<string, unknown>;
    expect(doc).toMatchObject({ path: '', version: '', source: '' }); // nothing found here: the engine uses PATH
    expect(typeof doc.at).toBe('number');
    expect(readdirSync(path.dirname(HANDOFF)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('names the same file the engine reads: ~/.origami/<CLI_FILE>, rooted like Global.Path.origami', () => {
    const engineSrc = readFileSync(path.resolve(__dirname, '../../../../engine/src/provider/claude-subscription.ts'), 'utf8');
    expect(engineSrc).toContain(`export const CLI_FILE = "${CLAUDE_CLI_FILE}"`);
    expect(engineSrc).toContain('path.join(Global.Path.origami, CLI_FILE)');
    expect(claudeCliFilePath('/h')).toBe(path.join('/h', '.origami', CLAUDE_CLI_FILE));
  });

  it('shares one probe between callers that arrive while it runs', async () => {
    await Promise.all([claudeCliDiscovery(), claudeCliDiscovery(), claudeCliDiscovery()]);
    expect(walks).toBe(1);
  });
});
