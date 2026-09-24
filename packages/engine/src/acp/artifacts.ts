export * as ACPArtifacts from "./artifacts"

/**
 * THE ARTIFACTS PANE'S ACP SURFACE — the fork-owned ext methods, dispatched
 * from `acp/agent.ts` and proxied by `acp/service.ts`, exactly as `acp/flock.ts`
 * is. Five reads and one write, all of them over the one `ArtifactStore` this
 * process holds (`artifact/instance.ts`):
 *
 *   artifact_list     {all?, projectPath?} -> {artifacts:[…], homeDevice}
 *   artifact_versions {artifactId}         -> {versions:[…]}
 *   artifact_open     {artifactId, version?} -> {url}
 *   artifact_restore  {artifactId, version}  -> {version}
 *   artifact_diff     {artifactId, from, to} -> {added, removed, changed}
 *   artifact_rename   {artifactId, title}    -> {title}
 *   artifact_delete   {artifactId}           -> {removedVersions, removedBlobs}
 *
 * plus the `origami/artifactsChanged` notification the extension listens for,
 * pushed from `acp/event.ts` whenever `onArtifactChange` fires.
 *
 * WHY `here` IS ALWAYS TRUE. The row carries it because the sidebar shows
 * "here / on 5090" (design section 6), and lane 3 is what makes it ever false:
 * until a device group transfers bodies, every artifact this store lists has
 * its blobs on this machine. It is published now so the UI lane can render the
 * mark and lane 3 only has to change what fills it in.
 *
 * WHY `artifact_open` BUILDS THE URL HERE. The port is chosen at listen time
 * and told to nobody (`cli/cmd/acp.ts`), so the extension cannot compute this
 * address — `Server.url` is the one place that knows it. The host is written
 * `127.0.0.1` rather than taken from `Server.url`: an engine started with
 * `--hostname 0.0.0.0` publishes `http://0.0.0.0:<port>`, which is not an
 * address a browser should dial, and the route only answers loopback anyway.
 */

import { emitArtifactChange } from "@/artifact/events"
import { artifactStore } from "@/artifact/instance"
import { PREFIX } from "@/artifact/serve"

/** The notification name. `origami/` prefixed and camelCase, like every other
 *  push on this connection (`origami/flockMailbox`, `origami/turnEnd`). */
export const ARTIFACTS_CHANGED_METHOD = "origami/artifactsChanged"

export type ListRequest = { readonly all?: boolean; readonly projectPath?: string }
export type ArtifactIdRequest = { readonly artifactId: string }
export type OpenRequest = ArtifactIdRequest & { readonly version?: number }
export type RestoreRequest = ArtifactIdRequest & { readonly version: number }
export type DiffRequest = ArtifactIdRequest & { readonly from: number; readonly to: number }
export type RenameRequest = ArtifactIdRequest & { readonly title: string }
export type DeleteRequest = ArtifactIdRequest

/** One row of the artifacts list, as the UI lane's contract file spells it
 *  (packages/vscode/src/dashboard/artifactAcp.ts, ARTIFACT_ROW_FIELDS).
 *  `latest` is the newest version NUMBER, which is what the sidebar prints;
 *  `project` is the repo it was made in.
 *
 *  `unopened` (the dock badge) and `conflict` (the banner) are the pane's two
 *  additions. Both are answers only a DEVICE GROUP can give — "arrived from
 *  elsewhere and not looked at", "that machine published over you" — so until
 *  lane 3 there is nothing here that can be new or in conflict: `unopened` is
 *  false and `conflict` is absent. They are declared now so the pane renders
 *  against the final shape and lane 3 only has to fill them in. */
export type ListRow = {
  readonly id: string
  readonly title: string
  readonly latest: number
  readonly updated: number
  readonly ownerDevice: string
  readonly here: boolean
  readonly sessionID?: string
  readonly project?: string
  readonly unopened: boolean
  readonly conflict?: { readonly device: string; readonly theirVersion: number; readonly yourVersion: number }
}

export type VersionRow = {
  readonly number: number
  readonly digest: string
  readonly created: number
  readonly device?: string
}

/** `homeDevice` is what THIS machine is called in an `ownerDevice`, so the
 *  pane can mark the rows it owns without a second call. Until the device
 *  group names this box, that is the same fallback a row with no recorded
 *  device gets. */
export type ListResult = { readonly artifacts: readonly ListRow[]; readonly homeDevice: string }
export type VersionsResult = { readonly versions: readonly VersionRow[] }
export type OpenResult = { readonly url: string; readonly localPath?: string }
export type RestoreResult = { readonly version: number }
export type DiffResult = { readonly added: string[]; readonly removed: string[]; readonly changed: string[] }
export type RenameResult = { readonly title: string }
export type DeleteResult = { readonly removedVersions: number; readonly removedBlobs: number }

/** What a row says when the store never recorded a device — the artifact was
 *  made here, before any device group existed. */
export const THIS_MACHINE = "this machine"

export async function list(input: ListRequest = {}): Promise<ListResult> {
  const rows = (await artifactStore()).list({
    ...(input.all ? { all: true } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  })
  return {
    artifacts: rows.map((row) => ({
      id: row.id,
      title: row.title,
      latest: row.latestVersion,
      updated: row.updated,
      ownerDevice: row.ownerDevice ?? THIS_MACHINE,
      here: true,
      unopened: false,
      ...(row.sessionID ? { sessionID: row.sessionID } : {}),
      ...(row.projectPath ? { project: row.projectPath } : {}),
    })),
    homeDevice: THIS_MACHINE,
  }
}

export async function versions(input: ArtifactIdRequest): Promise<VersionsResult> {
  const artifacts = await artifactStore()
  if (!artifacts.artifact(input.artifactId)) throw new Error(`no artifact ${input.artifactId}`)
  const latest = artifacts.latestNumber(input.artifactId)
  const rows: VersionRow[] = []
  // Newest first, which is the order the versions list shows them in.
  for (let number = latest; number >= 1; number--) {
    const version = artifacts.version(input.artifactId, number)
    if (!version) continue
    rows.push({
      number: version.number,
      digest: version.digest,
      created: version.created,
      ...(version.device ? { device: version.device } : {}),
    })
  }
  return { versions: rows }
}

export async function open(input: OpenRequest): Promise<OpenResult> {
  const store = await artifactStore()
  const detail = store.get(input.artifactId, input.version)
  if (!detail) {
    throw new Error(
      input.version === undefined
        ? `no artifact ${input.artifactId}`
        : `no version ${input.version} of ${input.artifactId}`,
    )
  }
  const entryPath = detail.version.entryPath ?? detail.entries[0]?.path
  if (!entryPath) throw new Error(`version ${detail.version.number} of ${input.artifactId} has no files to open`)
  const entry = detail.entries.find((item) => item.path === entryPath)
  return {
    url: `${await base()}${PREFIX}${detail.version.contentToken}/${encodePath(entryPath)}`,
    // The entry's blob on THIS machine's disk. Lane 1 is local-only, so this is
    // always a real path; "Show in Explorer" reveals it without ever asking the
    // webview to hold a filesystem path.
    ...(entry ? { localPath: store.blobs.pathFor(entry.sha256) } : {}),
  }
}

export async function restore(input: RestoreRequest): Promise<RestoreResult> {
  const result = (await artifactStore()).restore(input.artifactId, input.version)
  // The copy-forward IS a new version, so every listener — the pane, and any
  // second window watching — hears about it the same way a publish is heard.
  emitArtifactChange({ artifactId: result.artifactId, version: result.version, kind: "restored" })
  return { version: result.version }
}

export async function diff(input: DiffRequest): Promise<DiffResult> {
  return (await artifactStore()).diff(input.artifactId, input.from, input.to)
}

export async function rename(input: RenameRequest): Promise<RenameResult> {
  const result = (await artifactStore()).rename(input.artifactId, input.title)
  emitArtifactChange({ artifactId: result.id, kind: "renamed" })
  return { title: result.title }
}

export async function remove(input: DeleteRequest): Promise<DeleteResult> {
  const result = (await artifactStore()).delete(input.artifactId)
  emitArtifactChange({ artifactId: input.artifactId, kind: "deleted" })
  return { removedVersions: result.removedVersions, removedBlobs: result.removedBlobs }
}

/** `http://127.0.0.1:<port>`, or a sentence saying why there is no address.
 *  Imported lazily: `@/server/server` pulls the whole app layer in, and the
 *  ACP process has already loaded it by the time anything here is called. */
async function base(): Promise<string> {
  const { url } = await import("@/server/server")
  if (!url) throw new Error("this engine has no HTTP server listening, so an artifact has no address to open")
  return `http://127.0.0.1:${url.port}`
}

/** Each SEGMENT encoded, so the `/`s that separate them survive. A store path
 *  is already validated (`Manifest.validatePath`); this is about spaces and
 *  other characters a URL cannot carry raw. */
function encodePath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}
