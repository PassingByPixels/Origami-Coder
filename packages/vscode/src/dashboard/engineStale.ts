// Does the engine serving this session still match the binary the extension would spawn today?
//
// A deploy replaces the binary, but an already-open window keeps talking to the process it spawned
// — so a session on a stale engine can look identical to one on the new build, and a real fix can
// read as though it never shipped. The rule is pure so it tests without a filesystem; the one stat
// call sits at the bottom.

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
 * Filesystem mtime granularity and a deploy's copy are both coarse enough to land a few hundred ms
 *  off. A two-second tolerance keeps a false "stale" reading off an up-to-date window.
 */
export const STALE_TOLERANCE_MS = 2000;

/**
 * The one-line notice, or undefined when there is nothing honest to say. An unreadable stat or a
 *  session with no recorded spawn says nothing — a false "outdated" on a current window is worse
 *  than silence.
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
 * The same verdict against the binary as it stands on disk now. A stat that throws reads as "no
 *  evidence", not "stale".
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
