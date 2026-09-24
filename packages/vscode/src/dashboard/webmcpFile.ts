// Web MCP registry — the extension's half of ~/.origami/webmcp.json. WebMCP is browser-native (the
// page IS the server), so this pane writes the file directly rather than going through the engine
// the way mcpPane.ts does — requiring a live session before bookmarking a site would be ceremony
// with nothing behind it.
// Two writers, one rule: the engine's webmcp_launch/webmcp_note write here too, so every rewrite
// follows: read the current doc, key entries by normalised url, change only the touched entry,
// preserve every other entry and unknown field verbatim, write atomically (tmp + rename).
// Works on the RAW parsed object rather than a projected list — each side carries keys the other
// has never heard of, and projecting would silently delete them. webmcpMirror.test.ts fails if the
// two writers drift.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The registry's filename. Mirrors WEBMCP_FILE in the engine's webmcp-store.ts. */
export const WEBMCP_FILE = 'webmcp.json';

/** The document key holding the entry array. Mirrors the engine's `doc.sites`. */
export const SITES_KEY = 'sites';

/** One site as the pane renders it. Unknown keys ride through every rewrite. */
export interface WebMcpSite {
  url: string;
  name: string;
  purpose: string;
  addedAt: number;
  /** Advisory knowledge banked by the engine's `webmcp_note`. Never a contract:
   *  a WebMCP page re-publishes its tools on every join. */
  notes?: string;
  lastLaunched?: number;
  [k: string]: unknown;
}

/** Where `.origami/webmcp.json` is rooted — ORIGAMI_TEST_HOME first (the engine's own test
 *  variable, so both writers land on one file under its harness), then ORIGAMI_REPOS_HOME. */
function webmcpHome(): string {
  return process.env.ORIGAMI_TEST_HOME || process.env.ORIGAMI_REPOS_HOME || os.homedir();
}

export function webmcpFilePath(home: string = webmcpHome()): string {
  return path.join(home, '.origami', WEBMCP_FILE);
}

/**
 * Comparable form of an address, and an entry's identity — mirrors the
 * engine's `normalizeUrl`, and the two must agree or one writer's "same
 * site" becomes the other's second row. A query or fragment is KEPT (a hash
 * route is a different page); anything not http(s) returns undefined.
 */
export function normalizeSiteUrl(raw: string | undefined): string | undefined {
  const text = (raw ?? '').trim();
  if (!text) return undefined;
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const bare = url.pathname === '/' && !url.search && !url.hash;
  return bare ? `${url.protocol}//${url.host}` : `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
}

/** The raw document, or undefined when there is no usable prior file. Kept RAW
 *  (not projected) so unknown top-level keys survive the rewrite. */
export function readDoc(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch { return undefined; } // missing or corrupt: treated as no prior file
}

/** Atomic write: tmp + rename, so a reader mid-write never sees half a file. */
export function writeDoc(file: string, doc: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The entry array of a doc, raw. Anything unusable reads as no sites. */
function rawSites(doc: Record<string, unknown> | undefined): unknown[] {
  const list = doc?.[SITES_KEY];
  return Array.isArray(list) ? [...list] : [];
}

/** Index of the entry for `url` in a raw list, or -1. */
function indexOfSite(list: readonly unknown[], url: string): number {
  return list.findIndex((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const other = (item as { url?: unknown }).url;
    return typeof other === 'string' && normalizeSiteUrl(other) === url;
  });
}

/** Project the raw doc into the pane's rows. An entry no browser could open is DROPPED — its Open
 *  button could only fail. Mirrors the engine's `parseSites`. */
export function sitesOf(doc: Record<string, unknown> | undefined): WebMcpSite[] {
  const out: WebMcpSite[] = [];
  for (const item of rawSites(doc)) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const url = normalizeSiteUrl(typeof entry.url === 'string' ? entry.url : undefined);
    if (!url) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    out.push({
      ...entry,
      url,
      name: name || new URL(url).host,
      purpose: typeof entry.purpose === 'string' ? entry.purpose.trim() : '',
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : 0,
    });
  }
  return out;
}

/** Set fields on one entry, creating it when absent — every other entry, field and unknown
 *  top-level key survives, per the file's merge rule. */
export function upsertSite(
  doc: Record<string, unknown> | undefined,
  url: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(doc ?? {}) };
  const list = rawSites(doc);
  // Normalised here, not trusted from the caller: an un-normalised url would create a second row
  // for a site already listed.
  const key = normalizeSiteUrl(url);
  if (!key) return { ...next, version: typeof next.version === 'number' ? next.version : 1, [SITES_KEY]: list };
  const at = indexOfSite(list, key);
  if (at === -1) list.push({ url: key, ...fields });
  else list[at] = { ...(list[at] as Record<string, unknown>), ...fields };
  if (typeof next.version !== 'number') next.version = 1;
  next[SITES_KEY] = list;
  return next;
}

/** Drop ONE entry (the pane's Remove). Everything else survives verbatim. */
export function dropSite(doc: Record<string, unknown> | undefined, url: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(doc ?? {}) };
  const list = rawSites(doc);
  const at = indexOfSite(list, url);
  if (at !== -1) list.splice(at, 1);
  if (typeof next.version !== 'number') next.version = 1;
  next[SITES_KEY] = list;
  return next;
}

/** Every registered site, for the pane. A missing file is no sites, never an error. */
export function listSites(home?: string): WebMcpSite[] {
  return sitesOf(readDoc(webmcpFilePath(home)));
}

/** Re-read the file, apply one edit, write the result — the read-modify-write every writer of this
 *  shared file owes the others. Returns an error MESSAGE rather than throwing, since every call
 *  here is a button the user just pressed. */
export function updateWebMcpFile(
  edit: (doc: Record<string, unknown> | undefined) => Record<string, unknown>,
  home?: string,
): string | undefined {
  const file = webmcpFilePath(home);
  try {
    writeDoc(file, edit(readDoc(file)));
    return undefined;
  } catch (e) {
    return `Could not write ${file}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
