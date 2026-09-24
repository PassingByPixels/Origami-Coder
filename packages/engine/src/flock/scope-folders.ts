import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * WHETHER A FOLDER MAY BE SHARED AT ALL, and the sentence the owner reads if not.
 *
 * `scope.folders` is the one scope list with no source behind it: repos come from
 * the Folds registry and wiki entries from a directory listing, while a folder is
 * whatever the owner's file picker returned — on a bad day a drive letter or
 * their whole home directory. Sharing either is every credential, key store and
 * browser profile on the machine, so they are REFUSED, not warned about. A
 * refusal returns a sentence rather than throwing: the ACP write hands it
 * straight to the pane, and a stack trace is not a thing an owner can act on.
 *
 * The check is at the WRITE, never at the read — a folder that has since been
 * deleted must not make the whole stored scope unreadable (`sanitiseScope`).
 */

/**
 * ONE SPELLING OF ONE FOLDER: trailing separators off, `.`/`..` resolved, then
 * the REAL path behind any symlink or junction.
 *
 * The realpath is not tidiness, it is the difference between the cage working and
 * quietly refusing. `tool/external-directory.ts` normalises its target through
 * `FSUtil.normalizePath`, which on win32 is `realpathSync.native`, so a read under
 * a junction reaches the permission gate as the RESOLVED path and a rule written
 * from the junction path would match nothing. The OWNER IS SHOWN THE RESOLVED
 * PATH, because it names the folder whose contents are actually handed over. A
 * path that cannot be resolved falls back to the normalised form, so
 * {@link refusal} can say "does not exist" rather than throw at the pane.
 *
 * PLATFORM NOTE, stated rather than hidden: `FSUtil.normalizePath` is a no-op off
 * win32, so a POSIX desk that reads THROUGH a symlink to a shared folder is
 * refused while reading the resolved path works. That is the safe direction of
 * the two, and it is the same folder either way.
 */
export function normalise(folder: string): string {
  const trimmed = folder.trim()
  if (!trimmed) return ""
  const resolved = path.normalize(trimmed)
  const root = path.parse(resolved).root
  const tidy = resolved === root ? resolved : resolved.replace(/[/\\]+$/, "")
  try {
    return fs.realpathSync.native(tidy)
  } catch {
    return tidy
  }
}

function sameFolder(a: string, b: string): boolean {
  // win32 paths are case-insensitive, so a home folder typed in another case is
  // still the home folder — the one comparison here that must not be literal.
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The reason this folder cannot be shared, or `undefined` when it can. */
export function refusal(folder: string, home = os.homedir()): string | undefined {
  const value = normalise(folder)
  if (!value) return "a shared folder needs a path"
  if (!path.isAbsolute(value)) return `${folder} is not an absolute path — share a folder by its full path`
  if (value === path.parse(value).root) return `${value} is a whole drive — share a folder inside it instead`
  if (sameFolder(value, normalise(home))) return `${value} is your home folder — share a folder inside it instead`
  let stat: fs.Stats
  try {
    stat = fs.statSync(value)
  } catch {
    return `${value} does not exist`
  }
  if (!stat.isDirectory()) return `${value} is a file, not a folder`
  return undefined
}

/** Every folder in a scope, normalised — or the FIRST refusal. First rather than
 *  all of them: the pane adds one folder per Browse, so a list with two bad
 *  entries is a hand-edited config, and the owner fixes those one at a time. */
export function check(
  folders: readonly string[],
  home?: string,
): { readonly ok: true; readonly folders: string[] } | { readonly ok: false; readonly message: string } {
  const out: string[] = []
  for (const folder of folders) {
    const bad = home === undefined ? refusal(folder) : refusal(folder, home)
    if (bad) return { ok: false, message: bad }
    const value = normalise(folder)
    if (!out.includes(value)) out.push(value)
  }
  return { ok: true, folders: out }
}

export * as FlockScopeFolders from "./scope-folders"
