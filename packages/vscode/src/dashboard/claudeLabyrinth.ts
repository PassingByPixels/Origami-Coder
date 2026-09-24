// claudeLabyrinth.ts — the Labyrinth's `run_steps` answer for a Claude Code
// session: which bytes on disk, read how, and which sub-agent files belong
// to which spawn. The projection itself is claudeSteps.ts beside it.
//
// A Claude run id is `claude:<session uuid>` or
// `claude:<session uuid>#agent-<id>` for a sub-agent transcript — both
// halves are checked against a strict character class before any path join,
// since the id crosses the wire from a webview.
//
// A sub-agent file is linked to its spawn by the `.meta.json` sidecar's
// `toolUseId`, an exact match to the parent's `tool_use.id` — not a time
// window, since sessions routinely run several background sub-agents at once.
//
// Streamed with a byte budget; the payload says `truncated: true` when the
// budget stops the read, and `total` is a floor, never an invented remainder.
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import type { RunStep } from '../acpExtTypes';
import { claudeProjectsRoot, matchProjectDirs } from './claudeProjects';
import { projectClaudeSteps, spawnToolIds, type ClaudeChild, type ClaudeRecord } from './claudeSteps';

/** The route marker. An id without it is an engine id and is never seen here. */
export const CLAUDE_RUN_PREFIX = 'claude:';
/** Separates the conversation from one of its sub-agent transcripts. */
export const CHILD_SEPARATOR = '#';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/** Sub-agent transcripts read to expand ONE run. Mirrors the engine's
 *  MAX_CHILD_SESSIONS: each expansion is another file, and an unbounded
 *  fan-out would turn one review into a hundred reads. */
const MAX_CHILDREN = 32;
const CHUNK = 64 * 1024;

/** A session uuid or a sub-agent file stem, as a PATH SEGMENT may look. No dot,
 *  no separator, so neither half of an id can ever climb out of its directory. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export interface ClaudeStepsResult {
  sessionId: string;
  steps: RunStep[];
    /** Always empty: a Claude run has no collab roster; present for the wire shape. */
  members: string[];
  truncated: boolean;
  total: number;
  error?: string;
}

export interface ClaudeStepsOptions {
  /** `~/.claude/projects` unless a caller injects one. Tests MUST inject. */
  root?: string;
  /** Bytes read per transcript before the pass stops and says `truncated`. */
  maxBytes?: number;
}

/** The Labyrinth run id for a Claude conversation, or one of its sub-agents. */
export function claudeRunId(session: string, child?: string): string {
  return `${CLAUDE_RUN_PREFIX}${session}${child ? CHILD_SEPARATOR + child : ''}`;
}

/** True for an id this leaf answers. Everything else belongs to the engine. */
export function isClaudeRunId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(CLAUDE_RUN_PREFIX);
}

/** The two halves of a run id, or `null` when either could name a path
 *  segment it should not — refused before it can read outside the session's folder. */
export function parseClaudeRunId(id: string): { session: string; child?: string } | null {
  if (!isClaudeRunId(id)) return null;
  const [session, child, ...rest] = id.slice(CLAUDE_RUN_PREFIX.length).split(CHILD_SEPARATOR);
  if (rest.length || !session || !SAFE_SEGMENT.test(session)) return null;
  if (child !== undefined && !SAFE_SEGMENT.test(child)) return null;
  return { session, ...(child ? { child } : {}) };
}

const NO_FOLDER = 'This Claude Code chat has no folder — reopen the run index.';
const NO_RUN = 'That Claude Code transcript is not on this machine any more.';

/**
 * One Claude Code conversation as a step list. Never throws — a missing
 * directory, deleted transcript, or unreadable sub-agent file each become an
 * `error` field or a missing child.
 */
export async function claudeStepsPayload(
  id: string,
  cwd: string,
  opts: ClaudeStepsOptions = {},
): Promise<ClaudeStepsResult> {
  const empty: ClaudeStepsResult = { sessionId: id, steps: [], members: [], truncated: false, total: 0 };
  const parsed = parseClaudeRunId(id);
  if (!parsed) return { ...empty, error: NO_RUN };
  if (!cwd) return { ...empty, error: NO_FOLDER };
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    // Every matching directory, best first. A folded key can match two on
    // this OS, so the first one that HOLDS THE FILE wins, not the first match.
  const found = await firstWithRecords(opts.root ?? claudeProjectsRoot(), cwd, parsed, maxBytes);
  if (!found) return { ...empty, error: NO_RUN };
  const { dir, read } = found;
  const sub = path.join(dir, parsed.session, 'subagents');

    // Children are expanded for the CONVERSATION only — a sub-agent that
    // spawned its own sits in the same folder and would list a grandchild twice.
  const children = parsed.child ? undefined : await readChildren(sub, parsed.session, read.records, maxBytes);
  const steps = projectClaudeSteps(read.records, children);
  return { sessionId: id, steps, members: [], truncated: read.truncated, total: steps.length };
}

/** The first matching transcript directory that actually holds this run's file,
 *  with the records already read. `null` when no candidate does.
 *
 *  The file-presence check stays — a folded key can match two directories on
 *  this OS — but it now reuses the listing `matchProjectDirs` already made for
 *  each candidate instead of opening a conversation file to find out it is not
 *  there. A sub-agent file lives one directory deeper than that listing, so
 *  that one is still asked for by opening it. */
async function firstWithRecords(
  root: string,
  cwd: string,
  parsed: { session: string; child?: string },
  maxBytes: number,
): Promise<{ dir: string; read: { records: ClaudeRecord[]; truncated: boolean } } | null> {
  for (const match of await matchProjectDirs(root, cwd)) {
    const file = parsed.child
      ? path.join(match.dir, parsed.session, 'subagents', `${parsed.child}.jsonl`)
      : path.join(match.dir, `${parsed.session}.jsonl`);
    // Case-folded: on Windows the listing carries the name the CLI wrote, which
    // need not match the run id byte for byte. This may only SKIP a directory —
    // the open below is still what decides, so a fold can never lose a run.
    const wanted = file.toLowerCase();
    if (!parsed.child && !match.files.some((f) => f.path.toLowerCase() === wanted)) continue;
    const read = await readRecords(file, maxBytes);
    if (read) return { dir: match.dir, read };
  }
  return null;
}

/**
 * The sub-agent transcripts these records actually spawned, keyed by the
 * `tool_use` id that spawned each. Spawn ids are collected first, so a
 * sidecar naming none of them is never opened.
 */
async function readChildren(
  sub: string,
  session: string,
  records: readonly ClaudeRecord[],
  maxBytes: number,
): Promise<Map<string, ClaudeChild> | undefined> {
  const wanted = new Set(spawnToolIds(records));
  if (wanted.size === 0) return undefined;
  let names: string[];
  try {
    names = (await fs.promises.readdir(sub)).filter((n) => n.endsWith('.meta.json'));
  } catch {
    return undefined; // no sub-agents folder: every spawn stays a single step
  }
  const out = new Map<string, ClaudeChild>();
  for (const name of names) {
    if (out.size >= MAX_CHILDREN) break;
    const meta = await readMeta(path.join(sub, name));
    const toolUseId = typeof meta?.['toolUseId'] === 'string' ? meta['toolUseId'] : '';
    if (!meta || !toolUseId || !wanted.has(toolUseId) || out.has(toolUseId)) continue;
    const stem = name.slice(0, -'.meta.json'.length);
    if (!SAFE_SEGMENT.test(stem)) continue;
    const read = await readRecords(path.join(sub, `${stem}.jsonl`), maxBytes);
    if (!read) continue;
    const agent = typeof meta['name'] === 'string' && meta['name'] ? meta['name']
      : typeof meta['agentType'] === 'string' ? meta['agentType'] : undefined;
    out.set(toolUseId, { runId: claudeRunId(session, stem), ...(agent ? { agent } : {}), records: read.records });
  }
  return out.size ? out : undefined;
}

async function readMeta(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One streaming pass over one transcript. `null` means the file couldn't be
 * opened; a torn line costs only that line. Kept separate from
 * claudeHistory.ts's reader since this one keeps records, that one only totals.
 */
async function readRecords(file: string, maxBytes: number): Promise<{ records: ClaudeRecord[]; truncated: boolean } | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  const records: ClaudeRecord[] = [];
  let truncated = false;
  // StringDecoder, not buffer.toString(): a 64 KB read lands mid-character
  // often enough on a transcript full of em dashes, and a split code point
  // would become U+FFFD inside a step's title.
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let rest = '';
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      rest += decoder.write(buffer.subarray(0, bytesRead));
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) take(records, line);
      if (bytes >= maxBytes) { truncated = true; break; }
    }
    if (!truncated) {
      rest += decoder.end();
      take(records, rest);
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { records, truncated };
}

function take(records: ClaudeRecord[], line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    records.push(JSON.parse(trimmed) as ClaudeRecord);
  } catch { /* a torn last line, or a record this build does not know */ }
}
