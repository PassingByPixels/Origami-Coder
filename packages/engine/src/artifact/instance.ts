// ONE ArtifactStore per engine process.
//
// The store is a plain class over a SQLite file (see store.ts), and two
// handles on the same file in the same process would each hold their own WAL
// connection for no gain. The publish tool, the HTTP route and the ACP methods
// all want the SAME handle, so it is opened once, lazily, and shared. Lazily
// because a process that never touches an artifact must not create
// `<data>/artifacts/` just by starting.

import { ArtifactStore } from "./store"

let opening: Promise<ArtifactStore> | undefined

/** One store per engine process, opened on first use under the global data
 *  dir. `root` is honoured only by the FIRST caller, which is how a test puts
 *  the singleton in a temp directory: `resetArtifactStore()` first, then open
 *  with its own root. */
export function artifactStore(root?: string): Promise<ArtifactStore> {
  if (opening) return opening
  const next = ArtifactStore.open(root)
  opening = next
  // A failed open is not kept (t-tijhw6): the next call opens again. Callers
  // of THIS call still get the rejection from `next`.
  next.catch(() => {
    if (opening === next) opening = undefined
  })
  return next
}

/** Test seam: forget the singleton so the next call opens a fresh store. */
export function resetArtifactStore(): void {
  opening = undefined
}
