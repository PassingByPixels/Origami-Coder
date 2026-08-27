export * as AgentPluginPath from "./containment"

import path from "path"
import { realpathSync } from "fs"

/**
 * agent-plugins.org §4.1: "When a client discovers, reads, or executes a file or
 * directory supplied by the plugin package, the filesystem-resolved path MUST
 * remain within the filesystem-resolved plugin root."
 *
 * "Filesystem-resolved" is the whole clause. `path.resolve` alone answers a
 * question about strings; a `skills/` entry that is a symlink to `~/.ssh` beats
 * it while still looking relative. So every check here runs on realpaths.
 */

export const ROOT_PLACEHOLDER = "${PLUGIN_ROOT}"
export const DATA_PLACEHOLDER = "${PLUGIN_DATA}"

export interface Roots {
  /** Absolute plugin root. */
  readonly root: string
  /** Absolute per-plugin persistent data directory. Outside the root by design. */
  readonly data: string
}

/**
 * Realpath that also works for a path that does not exist yet.
 *
 * The naive fallback — catch ENOENT, return `path.resolve(p)` — reopens the hole
 * this module exists to close: `<root>/link/nope` where `link` is a symlink to
 * `/etc` never gets its symlink resolved, because the FULL path is missing and
 * the error hides the part that does exist. So walk up to the deepest ancestor
 * that does resolve, resolve THAT, and re-join the remainder.
 */
export function real(target: string): string {
  const absolute = path.resolve(target)
  let head = absolute
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync.native(head) : path.join(realpathSync.native(head), ...tail)
    } catch {
      const parent = path.dirname(head)
      // Root reached and still unresolvable: nothing on this path exists, so the
      // lexical resolution is all there is and it cannot be hiding a symlink.
      if (parent === head) return absolute
      tail.unshift(path.basename(head))
      head = parent
    }
  }
}

/** Windows paths compare case-insensitively; POSIX ones do not. */
function same(a: string, b: string) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Is `child` the same as `parent`, or inside it, once both are filesystem-resolved? */
export function within(parent: string, child: string): boolean {
  const base = real(parent)
  const target = real(child)
  if (same(base, target)) return true
  const prefix = base.endsWith(path.sep) ? base : base + path.sep
  return same(target.slice(0, prefix.length), prefix)
}

/** Expand the two placeholders the standard defines. No other expansion happens. */
export function expand(value: string, roots: Roots): string {
  return value.split(ROOT_PLACEHOLDER).join(roots.root).split(DATA_PLACEHOLDER).join(roots.data)
}

/**
 * Resolve a plugin-declared path and enforce §4.1.
 *
 * Both roots are permitted: the standard allows `${PLUGIN_DATA}/...` for a
 * server `cwd`, and PLUGIN_DATA is by definition outside the package. Anything
 * that lands in neither — `../`, an absolute path elsewhere, a symlink out — is
 * refused, and refused as `undefined` so the caller has to decide what to do
 * about it rather than receiving a silently rewritten path.
 */
export function resolveInside(value: string, roots: Roots): string | undefined {
  const expanded = expand(value, roots)
  const absolute = path.resolve(roots.root, expanded)
  if (within(roots.root, absolute)) return real(absolute)
  if (within(roots.data, absolute)) return real(absolute)
  return undefined
}

/**
 * Resolve a path that must stay inside the PACKAGE, with no PLUGIN_DATA escape.
 *
 * Used for components the plugin ships — skill directories — where §4.1 names
 * the plugin root and only the plugin root. `resolveInside` is the wider rule and
 * exists for server `cwd`, which the standard explicitly lets point at
 * `${PLUGIN_DATA}`. Keeping them apart means the skill path never has to rely on
 * a later filter to undo a permission it should not have been granted.
 */
export function resolveInPackage(value: string, root: string): string | undefined {
  const absolute = path.resolve(root, value.split(ROOT_PLACEHOLDER).join(root))
  return within(root, absolute) ? real(absolute) : undefined
}

/** Filter already-absolute paths (glob hits, say) down to those inside the root. */
export function containedIn(root: string, candidates: readonly string[]): string[] {
  return candidates.filter((candidate) => within(root, candidate))
}
