// handoff.ts — t-vd9s7z: the claude binary this window's discovery chose,
// written to ~/.origami/claude-cli.json so the engine's Claude (subscription)
// route uses the SAME binary as the passthrough. The engine reads the file
// when it needs a binary (packages/engine/src/provider/claude-subscription.ts
// `CLI_FILE`) and falls back to PATH when it is missing, unreadable, or names
// a file that is gone. No engine spawn waits for discovery: the file is
// written whenever discovery finishes (activation, pill re-probe, setting
// change), and a running engine reads the newest copy.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClaudeCliInfo } from './discovery';

/** MUST match the engine's `ClaudeSubscription.CLI_FILE` (drift-guard test). */
export const CLAUDE_CLI_FILE = 'claude-cli.json';

/** ~/.origami/claude-cli.json. ORIGAMI_TEST_HOME first: the engine's own
 *  `Global.Path.origami` honours it, so a test harness puts both sides on one file. */
export function claudeCliFilePath(home: string = process.env.ORIGAMI_TEST_HOME || os.homedir()): string {
  return path.join(home, '.origami', CLAUDE_CLI_FILE);
}

/** Write the winner (path '' when discovery found none), atomically: tmp +
 *  rename, so an engine reading mid-write never sees half a file. Never throws. */
export function writeClaudeCliHandoff(found: ClaudeCliInfo | undefined, file = claudeCliFilePath(), now = Date.now()): void {
  const doc = { path: found?.binary ?? '', version: found?.version ?? '', source: found?.source ?? '', at: now };
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}
