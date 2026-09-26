// parkedMail.ts — t-w2txb2: a PARKED chat stays addressable (owner decision 2026-09-24).
//
// When a chat's engine is parked, the engine leaves a stand-in file for each of its sessions in
// `~/.origami/agents/parked/` (engine origami/agent-broker.ts `park`). A peer `send_message`, a flock
// reply or a sub-agent question to that session is then kept as a file in
// `~/.origami/agents/mailbox/<engine session id>/` (engine origami/agent-mailbox.ts). This file watches
// that folder and starts the chat whose engine session the sub-folder names; the restored engine reads
// its mailbox on `session/resume` and admits each message as a live peer message would be.
// No vscode here. DashboardPanel wires it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** MIRROR of the engine's agentsDir() folder names (origami/agent-broker.ts PARKED_DIR / MAILBOX_DIR);
 *  parkedMail.test.ts reads both files. */
export const PARKED_DIR = 'parked';
export const MAILBOX_DIR = 'mailbox';

/** `~/.origami/agents`, the engine's agentsDir() for an engine spawned with this user's home. */
export function agentsDir(home: string = os.homedir()): string {
  return path.join(home, '.origami', 'agents');
}

/** The engine session id a mailbox event names, or null. `filename` is relative to the mailbox folder. */
export function sessionOfMail(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const first = filename.split(/[\\/]/)[0] ?? '';
  return /^[A-Za-z0-9_-]{1,128}$/.test(first) ? first : null;
}

/** Messages waiting for this engine session (final `.json` files only; a tmp file is still being written). */
export function hasMail(sessionId: string, root: string = agentsDir()): boolean {
  try {
    return fs.readdirSync(path.join(root, MAILBOX_DIR, sessionId)).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/** The chat was closed while parked: nothing will start it again, so its stand-in goes (a peer then
 *  gets "no live agent", as for any closed chat). */
export function removeStandIn(sessionId: string, root: string = agentsDir()): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
  try {
    fs.rmSync(path.join(root, PARKED_DIR, `${sessionId}.json`), { force: true });
  } catch {
    // gone already
  }
}

/** t-wypna7: what a stand-in holds. MIRROR of the engine's `Parked` (origami/agent-broker.ts); parkedMail.test.ts
 *  compares the keys. */
export interface StandIn {
  version: 1;
  parked: true;
  name: string;
  cwd: string;
  kind: 'interactive' | 'background';
  sessionId: string;
  hostPid: number;
  parkedAt: number;
}

/** t-wypna7: a chat reopened at a window reload WITHOUT its engine has no engine to write its stand-in (the engine writes
 *  one only when it parks, and a stand-in from before the reload names the old extension host, so the engine's reader
 *  deletes it). The window writes it: list_agents then shows the chat as stopped, and send_message keeps the message in
 *  its mailbox (watchMail below starts the chat). The engine removes it when it loads the session. Same file, same
 *  atomic write (tmp + rename) as the engine's own. */
export function writeStandIn(standIn: Omit<StandIn, 'version' | 'parked'>, root: string = agentsDir()): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(standIn.sessionId)) return false;
  const dir = path.join(root, PARKED_DIR);
  const file = path.join(dir, `${standIn.sessionId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const body: StandIn = { version: 1, parked: true, ...standIn };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

/** Call `onMail(engineSessionId)` when a message lands for a session. One watcher per window; the folder is
 *  made if it is missing. A platform without recursive watching gets none (the mail waits for the chat's
 *  next message, and is read then). */
export function watchMail(onMail: (sessionId: string) => void, root: string = agentsDir(), watch: typeof fs.watch = fs.watch): { dispose(): void } {
  const dir = path.join(root, MAILBOX_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
      const name = typeof filename === 'string' ? filename : filename ? String(filename) : '';
      if (!name.endsWith('.json')) return;
      const sid = sessionOfMail(name);
      if (sid) onMail(sid);
    });
    watcher.on('error', () => { /* the folder went away: mail is read on the chat's next message */ });
    return { dispose: () => watcher.close() };
  } catch {
    return { dispose: () => undefined };
  }
}
