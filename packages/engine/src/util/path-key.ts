// t-v47qh6. ONE rule for "are these two stored directory paths the same folder".
//
// Windows compares paths without case and takes `/` and `\` as the same
// separator, so `C:\Users\X`, `c:\users\x` and `C:/Users/X/` are one folder.
// The engine writes a realpath spelling (`C:\...`), VS Code sends its fsPath
// (`c:\...`) and the session table holds `C:/...`: an exact string compare
// splits one project into three. Other platforms keep case, as their file
// systems do.
//
// The key is for COMPARING only. Stored rows keep the spelling they were
// written with; both sides of a compare go through `pathKey`. The board's repo
// registry (tool/board-store.ts) and the artifact store both use it.
import path from "node:path"

/** Comparable form of a path: resolved, trailing separator dropped, case-folded
 *  on Windows. `platform` is a test seam; callers leave it out. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32"
  const resolved = (win ? path.win32 : path.posix).resolve(p).replace(/[\\/]+$/, "")
  return win ? resolved.toLowerCase() : resolved
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform)
}
