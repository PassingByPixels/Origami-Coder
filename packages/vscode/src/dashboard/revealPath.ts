// revealPath.ts — RESOLVING A TOOL CARD'S PATH TO A REAL FILESYSTEM PATH.
//
// A path on a card is whatever the agent reported. It may be absolute (the
// read-image rider is: `rawOutputMeta.display.path`, normalised by the engine)
// or workspace-relative (`locations[0].path` is the model's raw argument and
// usually is). Either has to become one absolute path before the host can point
// the OS at it.
//
// Pure — no `vscode` import — so the ESCAPE GUARD below is unit-testable. That
// guard is the reason this is a function and not four inline lines: a relative
// path is attacker-adjacent input in the sense that matters here, since the
// model writes it, and `..` climbing out of the workspace would hand
// `revealFileInOS` a directory the workspace does not reach.

import path from 'node:path';

/**
 * The absolute path to act on, or undefined when there is nothing safe to act
 * on: an empty path, a relative path with no workspace to resolve it against,
 * or a relative path that escapes the workspace root.
 *
 * An ABSOLUTE path is passed through untouched, which is deliberate and matches
 * `openAbsoluteFile`'s long-standing behaviour: the engine's own display path
 * is frequently outside the workspace (a temp render, a file in another repo),
 * and the workspace root is not a sandbox boundary for a path the host already
 * trusts enough to open.
 */
export function resolveCardPath(rawPath: string, workspacePath: string | null | undefined): string | undefined {
  const raw = rawPath.trim();
  if (!raw) return undefined;
  if (path.isAbsolute(raw)) return raw;
  if (!workspacePath) return undefined;
  const wsRoot = path.resolve(workspacePath);
  const resolved = path.resolve(path.join(wsRoot, raw));
  if (resolved !== wsRoot && !resolved.startsWith(wsRoot + path.sep)) return undefined;
  return resolved;
}
