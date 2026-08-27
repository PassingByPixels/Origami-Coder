// engineStale.test.ts — the "this session is on a pre-deploy engine" rule, and
// the two ends of the wire it depends on. The rule itself is arithmetic; what
// actually breaks is the contract underneath it, so both ends are pinned by
// reading the real files.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineStaleNotice, STALE_TOLERANCE_MS } from '../../../src/dashboard/engineStale';

const AT_SPAWN = 1_700_000_000_000;

describe('engineStaleNotice', () => {
  it('says nothing while the binary on disk is the one this session spawned', () => {
    expect(engineStaleNotice({ spawnedMtimeMs: AT_SPAWN, diskMtimeMs: AT_SPAWN })).toBeUndefined();
  });

  it('says nothing for a difference inside the mtime tolerance', () => {
    // A false "you are stale" on a current window teaches the user to ignore
    // the warning, which costs more than the warning is worth.
    expect(
      engineStaleNotice({ spawnedMtimeMs: AT_SPAWN, diskMtimeMs: AT_SPAWN + STALE_TOLERANCE_MS }),
    ).toBeUndefined();
  });

  it('warns once the on-disk binary is genuinely newer, and says what to do', () => {
    const notice = engineStaleNotice({ spawnedMtimeMs: AT_SPAWN, diskMtimeMs: AT_SPAWN + 60_000 });
    expect(notice).toContain('engine outdated');
    expect(notice).toContain('Restart the session');
  });

  it('names the version the session actually reported, so the claim is checkable', () => {
    const notice = engineStaleNotice({
      spawnedMtimeMs: AT_SPAWN,
      diskMtimeMs: AT_SPAWN + 60_000,
      runningVersion: 'local-202608071110',
    });
    expect(notice).toContain('local-202608071110');
  });

  it('drops the version clause rather than inventing one when the agent sent none', () => {
    const notice = engineStaleNotice({ spawnedMtimeMs: AT_SPAWN, diskMtimeMs: AT_SPAWN + 60_000 })!;
    expect(notice).not.toContain('undefined');
    expect(notice).not.toMatch(/running\s*\./);
  });

  it('stays silent when it cannot see both mtimes — an unreadable stat is not evidence', () => {
    expect(engineStaleNotice({ spawnedMtimeMs: 0, diskMtimeMs: AT_SPAWN })).toBeUndefined();
    expect(engineStaleNotice({ spawnedMtimeMs: AT_SPAWN, diskMtimeMs: 0 })).toBeUndefined();
  });

  it('never warns on a binary that got OLDER — a rollback is not a stale window', () => {
    expect(engineStaleNotice({ spawnedMtimeMs: AT_SPAWN, diskMtimeMs: AT_SPAWN - 60_000 })).toBeUndefined();
  });
});

// Two ends, neither reachable from the other's type system.
describe('stale-engine wiring', () => {
  // __tests__ -> dashboard -> webview -> vscode -> packages
  const root = join(__dirname, '../../../..');

  it('the engine still puts its version in the ACP handshake', () => {
    // Drop `agentInfo` from the initialize response and the notice silently
    // loses the only fact that makes it checkable, with every test above green.
    const service = readFileSync(join(root, 'engine/src/acp/service.ts'), 'utf-8');
    expect(service).toMatch(/agentInfo:\s*\{/);
    expect(service).toMatch(/version:\s*InstallationVersion/);
  });

  it('the extension still reads agentInfo.version off the init response', () => {
    const client = readFileSync(join(root, 'vscode/src/acpClient.ts'), 'utf-8');
    expect(client).toMatch(/agentInfo\?\.version/);
    expect(client).toMatch(/engineSpawn\(\)/);
  });

  it('the peer-broker name still rides the same handshake, both ends', () => {
    // Same wiring class as version above: the engine stamps agentInfo._meta.
    // peerName from its broker registration; the client reads it. Drop either
    // end and every chat header silently shows nothing, all unit tests green.
    const service = readFileSync(join(root, 'engine/src/acp/service.ts'), 'utf-8');
    expect(service).toMatch(/AgentBroker\.self\(\)\?\.name/);
    expect(service).toMatch(/_meta:\s*\{\s*peerName\s*\}/);
    const client = readFileSync(join(root, 'vscode/src/acpClient.ts'), 'utf-8');
    expect(client).toMatch(/_meta\?\.peerName/);
  });

  it('DashboardPanel still routes that verdict to a warning the user sees', () => {
    const panel = readFileSync(join(root, 'vscode/src/dashboard/DashboardPanel.ts'), 'utf-8');
    expect(panel).toMatch(/engineSpawnStaleNotice\(session\.client\.engineSpawn\(\)\)/);
    expect(panel).toMatch(/showWarningMessage\(notice, 'Reload Window'\)/);
  });
});
