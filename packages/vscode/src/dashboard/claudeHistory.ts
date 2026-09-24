// claudeHistory.ts — Claude Code's OWN past chats, listed beside Origami's
// in the one History popup.
//
// Reads `~/.claude/projects/<sanitised cwd>/<session uuid>.jsonl`. The
// directory name is the session's IDENTITY: `claude --resume` only finds a
// conversation in the folder it was created in. Which directory matches this
// workspace is decided by claudeProjects.ts, shared by History, the
// Labyrinth, resume and diagnostics.
//
// Bounded: a streaming pass per file with a byte budget reads small
// transcripts in full and marks a big one `partial: true` rather than
// silently under-reporting.
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import type { ClaudeScanFacts } from '../acpExtTypes';
import type { ClaudeCliInfo } from '../claudeCode/discovery';
import { bindCell, type ClaudeCodeHost } from './claudeCodeCell';
import { rememberResume } from './claudeCodeResume';
import { claudeProjectsRoot, listProjectDirs, matchProjectDirs, projectKey, samePath } from './claudeProjects';

/** One Claude Code transcript, shaped to sit in the same `historyList` array as
 *  an Origami row (historyRows.ts) — the fields the popup draws, plus the usage
 *  the one pass could measure while it was there. */
export interface ClaudeHistoryRow {
  sessionId: string;
  title: string;
  /** Basename of the OPEN workspace folder this transcript belongs to. */
  folder: string;
  /** The open folder itself — where `--resume` has to run. */
  cwd: string;
  /** File mtime, ISO. The transcript has no "ended at" of its own. */
  updatedAt: string;
  /** Always false: a Claude transcript is never the engine chat you have open. */
  current: false;
  kind: 'claude';
  /** Assistant messages, deduplicated by message id — see `readTranscript`. */
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  model: string;
  /** True when the byte budget stopped the read: every count above is a FLOOR. */
  partial: boolean;
}

export interface ClaudeScanOptions {
  /** `~/.claude/projects` unless a caller injects one. Tests MUST inject. */
  root?: string;
  /** The open workspace folders. Nothing outside these is ever listed. */
  folders: readonly string[];
  /** Newest-by-mtime files per folder. */
  maxFilesPerFolder?: number;
  /** Bytes read per file before the pass stops and marks the row `partial`. */
  maxBytesPerFile?: number;
}

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const CHUNK = 64 * 1024;
/** Long enough to recognise the chat, short enough for one dropdown line. */
const TITLE_CHARS = 80;

/** Rows and the facts of the scan that produced them. */
export interface ClaudeScanResult {
  rows: ClaudeHistoryRow[];
  scan: ClaudeScanFacts;
}

/**
 * Every Claude Code transcript that belongs to one of the OPEN folders, with
 * the facts an empty result has to be able to explain. Never throws: a missing
 * directory, unreadable file, or corrupt transcript each cost only their own row.
 */
export async function scanClaudeHistoryReport(opts: ClaudeScanOptions): Promise<ClaudeScanResult> {
  const root = opts.root ?? claudeProjectsRoot();
  const folders = (opts.folders ?? []).filter(Boolean);
  // Nothing open is nothing to look for, and a scan that reads the projects
  // root anyway pays for a listing no row can come from.
  if (folders.length === 0) return { rows: [], scan: { root, seen: 0, keys: [] } };
  const dirs = await listProjectDirs(root);
  const scan: ClaudeScanFacts = { root, seen: dirs.length, keys: folders.map(projectKey) };
  const maxFiles = opts.maxFilesPerFolder ?? DEFAULT_MAX_FILES;
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES;
  const rows: ClaudeHistoryRow[] = [];
  const done = new Set<string>();
  for (const cwd of folders) {
        // Only directories matching an OPEN folder are read — a session
        // elsewhere would offer a row whose only outcome is a chat started in
        // the wrong place. Matching is claudeProjects.ts's one shared rule.
    for (const match of await matchProjectDirs(root, cwd, dirs)) {
        // Dedup by DIRECTORY, not by the folded key of the open folder: two
        // distinct open folders can share a key, and folding them together
        // would drop the second folder's rows entirely. The same directory
        // reached twice is the only real duplicate.
      if (done.has(match.dir)) continue;
      done.add(match.dir);
        // The files come from the match, already listed and stat'ed — one
        // readdir+stat pass per directory per popup open.
      for (const file of match.files.slice(0, maxFiles)) {
        const read = await readTranscript(file.path, maxBytes);
        if (!read) continue;
        rows.push({
          ...read,
          sessionId: read.sessionId || path.basename(file.path, '.jsonl'),
          folder: path.basename(cwd) || cwd,
          cwd,
          updatedAt: new Date(file.mtimeMs).toISOString(),
          current: false,
          kind: 'claude',
        });
      }
    }
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { rows, scan };
}

type Scanned = Omit<ClaudeHistoryRow, 'folder' | 'cwd' | 'updatedAt' | 'current' | 'kind'>;

/**
 * One streaming pass over one transcript. `null` means "not a row" (a
 * sub-agent file, or nothing a human typed).
 *
 * Message ids are deduplicated: the CLI writes one record per content block
 * under one cumulative `message.usage`, so summing per record would triple
 * every token figure.
 */
async function readTranscript(file: string, maxBytes: number): Promise<Scanned | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return null;
  }
  const seen = new Set<string>();
  const out: Scanned = {
    sessionId: '', title: '', turns: 0,
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, model: '', partial: false,
  };
  let sidechain = false;
    // StringDecoder, not buffer.toString(): a 64 KB read can land mid-
    // character, and a split code point would corrupt a title.
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let rest = '';
  let read = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      read += bytesRead;
      rest += decoder.write(buffer.subarray(0, bytesRead));
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (take(out, seen, line)) { sidechain = true; break; }
      }
      // A sub-agent's transcript is not a chat anyone opened. Stop the moment
      // the file says so, rather than read the rest of it to learn nothing.
      if (sidechain) return null;
      if (read >= maxBytes) { out.partial = true; break; }
    }
    if (!out.partial) {
      rest += decoder.end();
      if (rest.trim() && take(out, seen, rest)) return null;
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return out.title ? out : null;
}

/** Fold one line into the running totals. Returns true if the file is a
 *  sidechain — the one condition that abandons the whole file. */
function take(out: Scanned, seen: Set<string>, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false; // a torn last line, or a record this build does not know
  }
  if (rec.isSidechain === true) return true;
  if (!out.sessionId && typeof rec.sessionId === 'string') out.sessionId = rec.sessionId;
  const message = rec.message as Record<string, unknown> | undefined;
  if (rec.type === 'user' && !out.title) {
        // First user text: a turn whose content is only a tool_result yields ''
        // and is skipped, rather than naming the chat after a tool it ran.
    const text = userText(message?.content).replace(/\s+/g, ' ').trim();
    if (text) out.title = text.slice(0, TITLE_CHARS);
    return false;
  }
  if (rec.type !== 'assistant' || !message) return false;
  const id = typeof message.id === 'string' ? message.id : '';
  if (id && seen.has(id)) return false;
  if (id) seen.add(id);
  out.turns += 1;
  if (typeof message.model === 'string' && message.model) out.model = message.model;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return false;
  out.tokensIn += num(usage.input_tokens);
  out.tokensOut += num(usage.output_tokens);
  out.cacheRead += num(usage.cache_read_input_tokens);
  out.cacheWrite += num(usage.cache_creation_input_tokens);
  return false;
}

/** The human text of a user turn. A string is itself; an array is its `text`
 *  parts joined — `tool_result` parts contribute nothing, on purpose. */
export function userText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => (p as { type?: unknown })?.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map((p) => (p as { text: string }).text)
    .join(' ')
    .trim();
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Said once, by both entry points — the pill's new chat and a History pick. */
export const CLI_MISSING = 'Claude Code was not found. Install it, then reopen this panel.';

/** The webview's pick, as it arrives. Every field is untrusted. */
export interface ClaudeHistoryPick {
  claudeSessionId?: unknown;
  cwd?: unknown;
  title?: unknown;
}

/**
 * Open a picked Claude Code conversation as a passthrough cell that RESUMES it.
 *
 * ORDER matters: the resume entry must be written BEFORE the bind, since
 * `bindCell` reads the resume map once while building the driver. FOLDER
 * matters too: `--resume` is only valid in the directory the session was
 * made in, so the cell runs in the picked row's folder — checked against the
 * open folders here since it crosses the wire from a webview.
 *
 * That check is `samePath`, never `projectKey`: the folded key would let a
 * webview-supplied `C:\Repos\Foo-Bar` pass on the strength of an open
 * `C:\Repos\Foo_Bar` and spawn `claude` in a directory nobody opened.
 */
export async function openClaudeHistoryChat(
  host: ClaudeCodeHost,
  cli: ClaudeCliInfo | null,
  model: string,
  pick: ClaudeHistoryPick,
): Promise<string | undefined> {
  if (!cli) {
    host.post({ type: 'error', message: CLI_MISSING, sessionId: '' });
    return undefined;
  }
  const session = String(pick?.claudeSessionId ?? '');
  const cwd = String(pick?.cwd ?? '');
  const open = host.folders?.() ?? [host.cwd];
  if (!session || !cwd || !open.some((f) => samePath(f, cwd))) {
    host.log(`[claude-code] not resuming ${session || '(no session id)'} — ${cwd || '(no folder)'} is not an open workspace folder`);
    return undefined;
  }
  const id = await host.createCell();
  rememberResume(host, id, cwd, session);
  host.post({ type: 'sessionTitle', sessionId: id, title: String(pick?.title ?? '').trim().slice(0, TITLE_CHARS) || 'Claude Code' });
  // `cwd` overridden for THIS bind only: the host object is the panel's own
  // literal, and the cell it just made has to spawn where the session lives.
  bindCell({ ...host, cwd }, cli, id, model);
  return id;
}
