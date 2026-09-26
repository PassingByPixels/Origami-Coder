// engineLog.ts — t-x3a89j: the engine's log file, for the Retry card's "Open engine log" and its Copy details.
// Kept out of DashboardPanel.ts (at its cap).
//
// Every engine writes `<data>/origami/log/origami.log` (@origami/core observability/logging.ts, rotated by size to
// origami.log.1 ...), where <data> is xdg-basedir's data dir: $XDG_DATA_HOME, else ~/.local/share on every platform
// including Windows. Mirrored, not imported (the same rule as subagentCost.ts catalogDir): this package does not
// depend on the engine's sources.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function engineLogPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(env['XDG_DATA_HOME'] || path.join(home, '.local', 'share'), 'origami', 'log', 'origami.log');
}

/** The lines Copy details adds after the reason: which chat, which engine session, where the log is. */
export function engineDescribe(chat: string, engineSessionId: string | null | undefined, logPath = engineLogPath()): string[] {
  return [`${chat} · engine session ${engineSessionId ?? '(none yet)'}`, `Engine log: ${logPath}`];
}

/** "Open engine log": the file in an editor, or a message that says where it would be. */
export async function openEngineLog(ui: {
  open(file: string): PromiseLike<unknown>;
  info(text: string): unknown;
}, file = engineLogPath()): Promise<void> {
  if (!fs.existsSync(file)) {
    ui.info(`Origami: the engine has not written a log yet (${file}).`);
    return;
  }
  await ui.open(file);
}
