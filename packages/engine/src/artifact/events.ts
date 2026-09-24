// Process-local change signal for the artifact store. The store itself stays
// a plain class with no listeners; callers that mutate (tools, ACP methods)
// call emitChange, and the ACP event forwarder subscribes once per engine to
// push `origami/artifactsChanged` to the extension. Shared by lanes 2 and 3
// so neither has to edit the other's files.

export interface ArtifactChange {
  artifactId: string
  version?: number
  kind: "published" | "restored" | "forked" | "pruned" | "renamed" | "deleted" | "imported"
  /** The session whose tool call made this change, when a tool made it. The
   *  host uses it to auto-open a new artifact in that chat only. */
  sessionID?: string
}

type Listener = (change: ArtifactChange) => void

const listeners = new Set<Listener>()

export function onArtifactChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitArtifactChange(change: ArtifactChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch {
      // a broken listener must not break the publisher
    }
  }
}
