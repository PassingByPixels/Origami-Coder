// claudeCodeResume.ts — WHICH Claude Code conversation a chat cell may resume.
//
// Fixes a bug where storing `{<cwd>: <session id>}` made every passthrough
// chat in a workspace folder resolve to the SAME Claude conversation. The key
// is now the BOUND CELL id, so a new chat always mints a new Claude session
// and resume applies only to the same chat coming back. A run stamp
// (RESUME_RUN) guards against a recycled cell id from a previous window
// inheriting that window's entry.

/** One cell's parked Claude conversation. `cwd` and `run` are both guards
 *  on when the entry is usable. */
export interface ResumeEntry {
  readonly cwd: string;
  /** The CLI's own session id — what `--resume` takes. */
  readonly session: string;
  readonly run: string;
}

/** cell id → entry. The value of `CLAUDE_CODE_RESUME_KEY` in workspaceState. */
export type ResumeStore = Record<string, ResumeEntry>;

/** The store, as this module needs it. Structural so nothing here depends on
 *  ClaudeCodeHost, and so a test can hand in a plain object. */
export interface ResumeIO {
  read(): ResumeStore | undefined;
  write(next: ResumeStore): void;
  log(line: string): void;
}

/** This extension host's run id. See the header — it is what stops a recycled
 *  `session-<n>` from inheriting a previous window's conversation. */
export const RESUME_RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A value written by THIS build. Anything else — most of all phase 1's bare
 *  string — is not an entry and is discarded rather than guessed at. */
function entryOf(value: unknown): ResumeEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.cwd !== 'string' || typeof rec.session !== 'string' || typeof rec.run !== 'string') return undefined;
  return rec.session ? { cwd: rec.cwd, session: rec.session, run: rec.run } : undefined;
}

/**
 * The Claude session id this cell may resume, or undefined for a fresh one.
 *
 * Undefined for a new chat (the common case), for a stale cwd-keyed entry
 * from an older build (discarded, and logged), or for an entry from another
 * run or directory.
 */
export function resumeIdFor(io: ResumeIO, cellId: string, cwd: string): string | undefined {
  const raw = io.read()?.[cellId] as unknown;
  if (raw === undefined) return undefined;
  const entry = entryOf(raw);
  if (!entry) {
    io.log(`[claude-code] discarding a stale resume entry for ${cellId} (written by an older build)`);
    return undefined;
  }
  if (entry.run !== RESUME_RUN || entry.cwd !== cwd) return undefined;
  return entry.session;
}

/**
 * Remember this cell's Claude session id, and drop every entry that can
 * never be used again (another run, or an unreadable shape). A no-op when
 * nothing changed.
 */
export function rememberResume(io: ResumeIO, cellId: string, cwd: string, session: string): void {
  if (!cellId || !session) return;
  const current = io.read() ?? {};
  const held = entryOf(current[cellId] as unknown);
  if (held && held.session === session && held.cwd === cwd && held.run === RESUME_RUN) return;
  const next: ResumeStore = {};
  for (const [key, value] of Object.entries(current)) {
    const kept = entryOf(value as unknown);
    if (kept && kept.run === RESUME_RUN && key !== cellId) next[key] = kept;
  }
  next[cellId] = { cwd, session, run: RESUME_RUN };
  io.write(next);
}
