// The ONE place this extension answers "where is the global origami config,
// and how do I read and write it without lying to the user". Every reader and
// every writer in firstFold.ts and toolDeferConfig.ts routes through here.
//
// It exists because four independent divergences from the ENGINE lived in the
// two hand-copied path/parse blocks it replaces (connections adversarial
// review, 2026-08-15):
//
//   F5  `~/.config` was hardcoded, so a user with XDG_CONFIG_HOME set wrote a
//       file the engine never reads — every Connections action a confident
//       no-op with no error on either side. The engine resolves the dir with
//       xdg-basedir (packages/core/src/global.ts), and this extension already
//       mirrors that correctly one folder away, in
//       agentManager/archetypes.ts's globalAgentDir(). Now it does so ONCE.
//
//   F6  The engine parses every config file, origami.json included, with the
//       JSONC parser (packages/engine/src/config/parse.ts). The extension used
//       raw JSON.parse, so a user who documented their config with
//       `// Spark 2 is the second DGX box` kept a working engine while the
//       panel went blank and all 7 writers told them the file was "not valid
//       JSON — fix or remove it first", which is false for this product.
//
//   F7  Writes were plain truncating writeFileSync. A write interrupted by the
//       window reload the extension itself offers leaves a torn config; the
//       engine's parse then throws and orElseSucceed swallows it into `{}` —
//       the whole product on default settings, silently.
//
//   F8  One `.bak` slot, overwritten by BACKGROUND probes. A hand-edit gone
//       wrong could be overwritten seconds later by a model probe nobody asked
//       for, so the file named like a rollback point was never one.
//
// Pure Node I/O — no `vscode` import — so it unit-tests with no extension host,
// the same property toolDeferConfig.ts was written for.

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { configShapeErrors } from './configShape';

/** The engine's `Global.Path.config`, mirrored exactly: xdg-basedir's xdgConfig
 *  is (XDG_CONFIG_HOME || ~/.config) and the app dir is "origami". Identical
 *  expression to agentManager/archetypes.ts's globalAgentDir(), which asserts
 *  it in archetypes.test.ts — the drift test for this one lives beside it in
 *  globalConfig.test.ts. No effect/Global import; just the path. */
export function globalConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'origami');
}

/** The GLOBAL config file this extension reads and writes.
 *
 *  `origami.json`, deliberately. The engine tries `origami.jsonc`,
 *  `origami.json`, `config.json` first-existing and merges them later-wins in
 *  the reverse order, so `.jsonc` outranks `.json` when both exist. That is
 *  fine as long as nothing SEEDS an empty `.jsonc`: an empty file at the top of
 *  the merge order shadows every write this extension makes, forever, with no
 *  error anywhere. The engine used to seed exactly that; it now seeds this file
 *  instead, and migrates an existing empty seed aside on load
 *  (packages/engine/src/config/config.ts, globalConfigFile + loadGlobal). */
export function globalConfigPath(): string {
  return path.join(globalConfigDir(), 'origami.json');
}

/** One pass over JSONC text: the comment-free equivalent, and whether any
 *  comment was there. String-aware, because the whole point is that a `//`
 *  inside a string value is data, not a comment — `{"url": "http://x"}` must
 *  survive untouched. Line comments stop AT the newline, so line numbers in a
 *  JSON.parse error still point at the user's real line.
 *
 *  Deliberately no more lenient than JSON otherwise: comments and trailing
 *  commas are what the engine's parser adds (`allowTrailingComma: true` in
 *  packages/engine/src/config/parse.ts) and are all this adds too. Anything
 *  else malformed stays malformed here AND there. */
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

/** Read the global config for a WRITE. `null` when the file is absent (the
 *  caller creates it). Throws with the REAL reason otherwise:
 *
 *  - unreadable            → the OS error
 *  - genuinely malformed   → "not valid JSON"
 *  - has comments          → says so, and says the change would delete them
 *
 *  That last case is the honest half of F6. Every one of the 7 writers is a
 *  whole-object rewrite (read → mutate → JSON.stringify the lot), and a
 *  rewrite CANNOT preserve comments; only an edit-based writer can, which
 *  needs jsonc-parser's modify/applyEdits — an engine dependency this package
 *  cannot resolve. So the writers refuse and say why, instead of writing and
 *  destroying the user's notes, and instead of blaming a file that is valid. */
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

/** Roll the backups one slot older, then write `raw` as the new `.bak`.
 *
 *  `.bak` stays the NEWEST on purpose: the panel already tells the user
 *  "Backed up to origami.json.bak" (DashboardPanel.ts, removeProvider), and a
 *  rotation that renamed the newest away would make that sentence false.
 *
 *  Reached through `saveConfig`, which calls it only for a user-initiated
 *  write. The automatic ones (the two probe paths into writeModelContextLimit,
 *  and maybeAdoptRemoteServedModel's writeModelConfig) pass no previous
 *  config: a background probe firing seconds after a hand-edit went wrong used
 *  to consume the single slot and take the user's only rollback point with it.
 *  Exported so the rotation can be tested as the property it is. */
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

/** Every writer's last line: refuse a document the ENGINE would reject, back up
 *  what is being replaced, then write atomically.
 *
 *  The refusal is the point. A config that fails the engine's schema is not
 *  partially applied — packages/engine/src/config/parse.ts throws for the WHOLE
 *  file and cachedGlobal swallows it into `{}`, so one bad field silently
 *  reverts the user to no configuration at all while the panel still shows
 *  every pill green. Better to fail the one action, loudly, than to zero the
 *  file quietly. See configShape.ts for what is checked and how it is kept in
 *  step with the real schema.
 *
 *  ORDER: validate, THEN back up. A refused write must not spend a rotation
 *  slot — otherwise a user clicking a failing Connect five times flushes the
 *  real history out of the chain with five copies of the same unchanged file.
 *
 *  `previous` is the config being replaced (`readConfigForWrite`'s result), or
 *  null/undefined for a first write or an AUTOMATIC one. Automatic writers pass
 *  null on purpose: the chain is the user's rollback point for what the USER
 *  did, and a background probe must not consume it. */
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
