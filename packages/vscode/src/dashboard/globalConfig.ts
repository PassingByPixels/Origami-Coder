// The one place this extension answers "where is the global origami config, and how do I read/write
// it without lying to the user" — every reader/writer in firstFold.ts and toolDeferConfig.ts routes
// through here.
//
// Fixes four divergences from the engine that used to live in hand-copied path/parse code: the
// config dir must follow XDG_CONFIG_HOME like the engine does; the file must parse as JSONC
// (comments, trailing commas) since the engine's own parser does; writes must be atomic (tmp +
// rename) so an interrupted write can't leave a torn file the engine then discards; and a
// background probe must never consume the user's one rollback backup slot.
//
// Pure Node I/O, no vscode import, so it unit-tests with no extension host.

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { configShapeErrors } from './configShape';

/** The engine's global config dir, mirrored exactly (XDG_CONFIG_HOME || ~/.config, app dir
 *  "origami") — identical to agentManager/archetypes.ts's globalAgentDir(), with a drift test
 *  binding the two. */
export function globalConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'origami');
}

/** The global config file this extension reads and writes: `origami.json`, deliberately — the
 *  engine tries `.jsonc`/`.json`/`config.json` and merges later-wins, so an empty seeded `.jsonc`
 *  would shadow every write here forever. The engine now seeds `origami.json` instead and migrates
 *  an empty seed aside on load. */
export function globalConfigPath(): string {
  return path.join(globalConfigDir(), 'origami.json');
}

/** One pass over JSONC text: the comment-free equivalent, and whether any comment was there.
 *  String-aware, so a `//` inside a string value (e.g. a URL) survives untouched; line comments
 *  stop at the newline so error line numbers stay accurate. No more lenient than JSON otherwise —
 *  matches what the engine's parser itself accepts. */
function scanJsonc(text: string): { stripped: string; hasComments: boolean } {
  let out = '';
  let hasComments = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      // Copy the whole string literal verbatim, escapes included.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      hasComments = true;
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      hasComments = true;
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === '}' || c === ']') {
      // Drop a trailing comma before the close. Scanned back over the
      // whitespace run rather than matched with a /,\s*$/ regex, which would
      // re-scan the whole accumulated output once per brace — quadratic on a
      // real config. The whitespace itself stays, so line numbers survive.
      let k = out.length;
      while (k > 0 && (out[k - 1] === ' ' || out[k - 1] === '\t' || out[k - 1] === '\n' || out[k - 1] === '\r')) k--;
      if (k > 0 && out[k - 1] === ',') out = out.slice(0, k - 1) + out.slice(k);
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return { stripped: out, hasComments };
}

/** True when the file carries line or block comments — i.e. content a
 *  whole-object rewrite would silently delete. */
export function hasJsonComments(text: string): boolean {
  return scanJsonc(text).hasComments;
}

/** Parse config text the way the ENGINE does: comments and trailing commas are
 *  legal. Throws on genuinely malformed input, same as JSON.parse. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(scanJsonc(text).stripped);
}

/** Read the global config as a plain object for a READ-ONLY caller. `null`
 *  when the file is absent; throws only when it is unreadable or malformed, so
 *  a caller can keep its own "a broken config is not worth failing over"
 *  policy. */
export function readConfigObject(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Read the global config for a WRITE. null when the file is absent (the caller creates it); throws
 *  with the real reason otherwise — unreadable, malformed, or "has comments" (the honest half of
 *  the fix: every writer is a whole-object rewrite that cannot preserve comments, so it refuses and
 *  says why instead of silently destroying the user's notes).
 */
export function readConfigForWrite(file: string): { raw: string; cfg: Record<string, unknown> } | null {
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`could not read ${file}: ${e instanceof Error ? e.message : e}`);
  }
  if (hasJsonComments(raw)) {
    throw new Error(
      `${file} has comments, and this change rewrites the whole file — it would delete them. `
      + `Edit the file by hand, or remove the comments first.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    throw new Error(`existing config at ${file} is not valid JSON — fix or remove it first`);
  }
  const cfg = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  return { raw, cfg };
}

/** How many backups the rotation keeps. `.bak` is the newest and `.bak.1` ..
 *  `.bak.4` are the four before it, so the count below IS the total on disk. */
export const MAX_BACKUPS = 5;

/**
 * Roll the backups one slot older, then write `raw` as the new `.bak` (kept newest, matching the
 *  panel's "Backed up to origami.json.bak" message). Reached only for a user-initiated write via
 *  saveConfig — automatic probe writers pass no previous config, so a background probe firing after
 *  a hand-edit can't consume the user's only rollback slot.
 */
export function backupConfig(file: string, raw: string): void {
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const from = i === 1 ? `${file}.bak` : `${file}.bak.${i - 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.bak.${i}`);
  }
  fs.writeFileSync(`${file}.bak`, raw, 'utf8');
}

/** Atomic write: tmp + rename, so a reader mid-write never sees half a file.
 *  Same shape as agentManager/repoFile.ts's writeRepoFile — which protected the
 *  agent repo list while the one file whose corruption takes the whole product
 *  down was written by a plain truncating writeFileSync. */
export function writeConfigAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Every writer's last line: refuse a document the engine would reject, back up what is being
 *  replaced, then write atomically.
 * A refused write must not spend a rotation slot — validate, THEN back up — or repeatedly clicking
 *  a failing Connect flushes real history out of the chain with copies of the same unchanged file.
 * `previous` is null/undefined for a first write or an automatic one; automatic writers pass null
 *  on purpose so a background probe never consumes the user's rollback point.
 */
export function saveConfig(
  file: string,
  cfg: Record<string, unknown>,
  previous?: { raw: string } | null,
): void {
  const problems = configShapeErrors(cfg);
  if (problems.length) {
    throw new Error(
      `refusing to write ${file}: the engine would reject the whole file and fall back to no config `
      + `(${problems.join('; ')})`,
    );
  }
  if (previous) backupConfig(file, previous.raw);
  writeConfigAtomic(file, JSON.stringify(cfg, null, 2) + '\n');
}
