// warmSpareWindow.ts — t-w2u2ki: the ONE warm spare of this VS Code window, and the real values it
// reads (settings, the spawn digest, the clock, the log). The rules live in warmSpare.ts.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AcpClient, engineOverlay, resolveDevEngine, resolveEngineBinary } from '../acpClient';
import { WarmSpare } from './warmSpare';
import { ELASTIC_SECTION, chatTurnRunning, elasticLog, onTurnSettled, raiseFromOutside, readElasticSettings } from './elasticWindow';

/** `origamicoder.elastic.warmSpare`, ON by default. A host with no settings store reads the default. */
export function warmSpareEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration(ELASTIC_SECTION).get<boolean>('warmSpare') !== false;
  } catch {
    return true;
  }
}

/** Every value a chat engine spawned NOW would be fixed with: the binary (and its build), the whole env it
 *  would get (host env + overlay, so LANG / LC_ALL / TZ too) and the folder. A spare whose digest differs
 *  from this at adoption time would not send a fresh engine's bytes (scope C S2). */
export function spawnDigest(cwd: string): string {
  const dev = resolveDevEngine();
  const binary = dev ? dev.entry : resolveEngineBinary();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(binary).mtimeMs;
  } catch {
    // not on disk (PATH lookup): the path alone
  }
  const env = Object.entries({ ...process.env, ...engineOverlay(false) })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ binary, argPrefix: dev?.argPrefix ?? [], mtimeMs, cwd, env })).digest('hex');
}

export const warmSpare = new WarmSpare<AcpClient>({
  make: (handlers) => new AcpClient(handlers),
  enabled: warmSpareEnabled,
  turnRunning: chatTurnRunning,
  lower: () => readElasticSettings().enabled,
  digest: spawnDigest,
  retrimMs: () => readElasticSettings().retrimMs,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  raise: (pid) => raiseFromOutside(pid, 'active'),
  log: elasticLog,
});

/** Activation: a settled turn may start a replacement, a settings change may drop a stale spare, and the
 *  spare goes with the window. */
export function activateWarmSpare(context: { subscriptions: Array<{ dispose(): unknown }> }): void {
  context.subscriptions.push(
    onTurnSettled(() => warmSpare.turnSettled()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('origami') || e.affectsConfiguration('origamicoder')) warmSpare.refresh(); }),
    { dispose: () => warmSpare.dispose() },
  );
}
