// engineStale.ts — does the engine serving this session still match the binary
// the extension would spawn today, and what should the user be told?
//
// Why this exists: a deploy replaces `~/.origami/bin/origami.exe`, but a window
// that is already open keeps talking to the process it spawned. On 2026-08-11
// two engine processes from the previous day were still alive alongside
// post-deploy ones, and a session served by one of them looked identical to a
// session on the new build — so a fix that had genuinely shipped read as a fix
// that did not work. The extension had the mtime evidence for this since the
// beginning and never showed it anywhere the user would look.
//
// The RULE is pure so it can be tested without a filesystem; the one stat it
// needs sits at the bottom, in the only function that touches the disk. This
// lives here rather than as more methods on AcpClient because that file sits
// within a few lines of its architecture cap — the same remedy boardData.ts,
// promptCapture.ts and cacheStats.ts took before it.

import { statSync } from 'node:fs';

export interface EngineStaleInput {
  /** mtime of the binary at the moment this session's engine was spawned. */
  spawnedMtimeMs: number;
  /** mtime of that same path NOW; 0 when it could not be read. */
  diskMtimeMs: number;
  /** `agentInfo.version` from this session's ACP handshake, if it sent one. */
  runningVersion?: string;
}

/**
 * Filesystem mtime granularity, and the copy that a deploy performs, are both
 * coarse enough to land a few hundred milliseconds either side of the truth. A
 * two-second tolerance keeps a false "you are stale" - which teaches the user
 * to ignore the warning - off a window that is in fact up to date.
 */
export const STALE_TOLERANCE_MS = 2000;

/**
 * The one-line notice, or undefined when there is nothing honest to say.
 * Deliberately conservative: an unreadable stat or a session that never
 * recorded a spawn says nothing at all, because "engine outdated" on a window
 * that is current is worse than silence.
 */
export function engineStaleNotice(input: EngineStaleInput): string | undefined {
  if (!input.spawnedMtimeMs || !input.diskMtimeMs) return undefined;
  if (input.diskMtimeMs <= input.spawnedMtimeMs + STALE_TOLERANCE_MS) return undefined;
  const running = input.runningVersion ? ` This session is running ${input.runningVersion}.` : '';
  return `Origami: engine outdated — a newer build is on disk and this session is still on the old one.${running} Restart the session (or reload the window) to update.`;
}

/** What a session's client knows about the build it spawned. */
export interface EngineSpawn {
  binary: string | null;
  spawnedMtimeMs: number;
  runningVersion?: string;
}

/**
 * The same verdict, against the binary as it stands on disk right now. A stat
 * that throws reads as "no evidence" rather than "stale", for the same reason
 * the tolerance exists.
 */
export function engineSpawnStaleNotice(spawn: EngineSpawn): string | undefined {
  let diskMtimeMs = 0;
  if (spawn.binary) {
    try {
      diskMtimeMs = statSync(spawn.binary).mtimeMs;
    } catch {
      diskMtimeMs = 0;
    }
  }
  return engineStaleNotice({
    spawnedMtimeMs: spawn.spawnedMtimeMs,
    diskMtimeMs,
    runningVersion: spawn.runningVersion,
  });
}
