// The model-facing half of the artifact store. Four tools, one store: publish
// writes a version, list/get/diff read one back.
//
// WHY EVERY REFUSAL IS TEXT, NOT A THROW. A thrown tool error reaches the model
// as a failure it is told to retry, and every refusal here is the opposite of
// retryable: a stale base version needs a different baseVersion, an unsafe path
// needs a different path. So each one returns an ExecuteResult whose `output`
// says what happened and what to do next. The conflict case is the one the
// design note calls out by name — "a publish that conflicts returns the
// conflict to the agent as text, not as an error".
//
// WHY THE STORE IS A PROCESS SINGLETON. artifact/instance.ts opens it once per
// engine, lazily, under the global data dir; it is shared with the ACP lane so
// two openers never race on the same SQLite file. A test primes that singleton
// with its own root instead of pointing the engine at a real home.

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { Cause, Effect, Exit, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { artifactStore } from "@/artifact/instance"
import { emitArtifactChange } from "@/artifact/events"
import { ArtifactPathError, type ManifestEntry, type PublishFile } from "@/artifact/types"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import PUBLISH_DESCRIPTION from "./artifact-publish.txt"
import LIST_DESCRIPTION from "./artifact-list.txt"
import GET_DESCRIPTION from "./artifact-get.txt"
import DIFF_DESCRIPTION from "./artifact-diff.txt"

/** The one line every artifact result ends with. The store has no UI of its
 *  own: if the model does not say where the thing went, the user is left with
 *  an id and no way to reach it. */
const PILL_NUDGE = "Tell the user this is in the Artifacts pill in the sidebar."

/** Text content is inlined up to here. Above it the model gets size + media
 *  type only — printing a 2 MB page back into the context window would spend
 *  the whole budget restating what it just published. */
export const INLINE_LIMIT = 64 * 1024

/** The v1 ceiling on one version, from design note section 7 ("Versions over
 *  32 MiB — raise the cap when a real case appears"). Counted over the WHOLE
 *  file set and checked before the bytes are read, so an oversized publish
 *  costs a `stat` per file and nothing else. */
export const MAX_PUBLISH_BYTES = 32 * 1024 * 1024

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`

/** THE STABLE ADDRESS OF ONE VERSION, for the chat. Not the loopback url:
 *  that carries a per-version token and the port of THIS engine run, so it
 *  is dead after a restart. The chat renders this link as a card whose Open
 *  asks the engine for the live url (`artifact_open`), the same as the pane. */
export const artifactLink = (artifactId: string, version: number) =>
  `origami://artifact/${artifactId}?v=${version}`

/** The link as the Markdown the model is told to paste, so the card has a
 *  title. `[`, `]` and line breaks in a title would end the label early, so
 *  they are replaced; the title in the store is unchanged. */
const linkLine = (title: string, artifactId: string, version: number) =>
  `Link: [${title.replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")")).replace(/\s+/g, " ")}](${artifactLink(artifactId, version)})`

/** One metadata shape for all four tools, declared rather than inferred: each
 *  execute has several result branches and inference would pin the type to
 *  whichever one is written first. */
type ArtifactMetadata = {
  artifactId?: string
  version?: number
  digest?: string
  contentToken?: string
  files?: number
  conflict?: boolean
  refused?: string
}

const PublishFileParam = Schema.Struct({
  path: Schema.String.annotate({
    description: "Path inside the artifact, `/`-separated and relative, e.g. `index.html` or `assets/app.css`.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "The file's text, UTF-8. Use this OR sourcePath, not both.",
  }),
  sourcePath: Schema.optional(Schema.String).annotate({
    description:
      "Absolute path of a file on disk to publish byte for byte. Use this for images and anything not plain text.",
  }),
  mediaType: Schema.optional(Schema.String).annotate({
    description: "Overrides the media type guessed from the extension, e.g. `text/html`.",
  }),
})

export const PublishParameters = Schema.Struct({
  title: Schema.String.annotate({ description: "Short human title for the artifact, shown in the Artifacts list." }),
  files: Schema.Array(PublishFileParam).annotate({
    description: "The files of this version. At least one. Every version carries the WHOLE file set, not a delta.",
  }),
  entryPath: Schema.optional(Schema.String).annotate({
    description: "The file the viewer opens first. Must be one of `files`. Defaults to index.html, else the first.",
  }),
  artifactId: Schema.optional(Schema.String).annotate({
    description: "Omit to create a new artifact. Pass an existing id to publish a new version of it.",
  }),
  baseVersion: Schema.optional(Schema.Finite).annotate({
    description:
      "Required together with artifactId: the version number you last saw. Omit both for a new artifact.",
  }),
})

export const ListParameters = Schema.Struct({
  all: Schema.optional(Schema.Boolean).annotate({
    description: "true = every artifact on this machine. Default false = this project only.",
  }),
})

export const GetParameters = Schema.Struct({
  artifactId: Schema.String.annotate({ description: "The artifact id, as artifact_list reports it." }),
  version: Schema.optional(Schema.Finite).annotate({ description: "Version number. Defaults to the latest." }),
})

export const DiffParameters = Schema.Struct({
  artifactId: Schema.String.annotate({ description: "The artifact id, as artifact_list reports it." }),
  from: Schema.Finite.annotate({ description: "The older version number." }),
  to: Schema.Finite.annotate({ description: "The newer version number." }),
})

/** Refusal result: the model reads `output`, nothing was written. */
function refuse(title: string, output: string): Tool.ExecuteResult<ArtifactMetadata> {
  return { title, output: `${output}\nNothing was written.`, metadata: { refused: output } }
}

/** One planned file: either inline bytes the model handed over, or an absolute
 *  path on disk plus the size `stat` reports for it. Sizing a source by `stat`
 *  rather than by reading it is what lets the cap refuse a 200 MB publish
 *  without pulling 200 MB into memory first. */
type PlannedFile = {
  path: string
  mediaType?: string
  bytes?: Uint8Array
  source?: { absolute: string; size: number }
}

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"

/** Resolve the tool's file list to bytes-or-source WITHOUT reading a source
 *  file. A missing or unreadable source is a refusal, not a crash: the model
 *  gave a path that is not there. */
function planFiles(files: readonly Schema.Schema.Type<typeof PublishFileParam>[]):
  | { ok: true; files: PlannedFile[] }
  | { ok: false; reason: string } {
  const out: PlannedFile[] = []
  for (const file of files) {
    if (file.content !== undefined) {
      out.push({ path: file.path, bytes: new TextEncoder().encode(file.content), mediaType: file.mediaType })
      continue
    }
    if (file.sourcePath === undefined) {
      return { ok: false, reason: `File "${file.path}" has neither content nor sourcePath.` }
    }
    // Absolute before anything else looks at it: the external-directory check
    // compares against the worktree, and a relative path would be compared as
    // written and read from the engine's cwd, which are two different places.
    const absolute = path.resolve(file.sourcePath)
    let size: number
    try {
      const stat = fs.statSync(absolute)
      if (!stat.isFile()) {
        return { ok: false, reason: `sourcePath "${absolute}" for "${file.path}" is not a file.` }
      }
      size = stat.size
    } catch (error) {
      return { ok: false, reason: `Could not read sourcePath "${absolute}" for "${file.path}" (${errnoCode(error)}).` }
    }
    out.push({ path: file.path, mediaType: file.mediaType, source: { absolute, size } })
  }
  return { ok: true, files: out }
}

/** What the publish will cost, decided before a single source byte is read. */
const plannedBytes = (files: PlannedFile[]) =>
  files.reduce((total, file) => total + (file.bytes?.byteLength ?? file.source?.size ?? 0), 0)

/** Read the sources. Runs only after the cap and the external-directory checks
 *  have passed, so nothing large or out of bounds reaches memory. */
function loadFiles(files: PlannedFile[]): { ok: true; files: PublishFile[] } | { ok: false; reason: string } {
  const out: PublishFile[] = []
  for (const file of files) {
    if (file.bytes) {
      out.push({ path: file.path, bytes: file.bytes, mediaType: file.mediaType })
      continue
    }
    try {
      out.push({
        path: file.path,
        bytes: new Uint8Array(fs.readFileSync(file.source!.absolute)),
        mediaType: file.mediaType,
      })
    } catch (error) {
      return {
        ok: false,
        reason: `Could not read sourcePath "${file.source!.absolute}" for "${file.path}" (${errnoCode(error)}).`,
      }
    }
  }
  return { ok: true, files: out }
}

/** A publish must be replay-safe across a dropped connection, and the tool call
 *  id is what identifies "the same call" to the engine. A client that does not
 *  send one still gets idempotency, from the only other thing that is stable
 *  across a retry: this session, this title, these exact bytes. */
function idempotencyKey(callID: string | undefined, sessionID: string, title: string, files: PublishFile[]): string {
  if (callID) return callID
  const hash = crypto.createHash("sha256")
  hash.update(sessionID)
  hash.update("\u0000")
  hash.update(title)
  for (const file of files) {
    hash.update("\u0000")
    hash.update(file.path)
    hash.update("\u0000")
    if (file.bytes) hash.update(file.bytes)
  }
  return `derived_${hash.digest("hex")}`
}

const isText = (mediaType: string) =>
  mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "image/svg+xml"

function describeEntry(entry: ManifestEntry): string {
  return `- ${entry.path} (${entry.size} bytes, ${entry.mediaType})`
}

/** The project an artifact is filed under. A non-git workspace resolves its
 *  worktree to the drive root, which would file every such artifact under one
 *  shared "project"; the working directory is the honest answer there. */
const projectOf = (instance: { worktree: string; directory: string; project: { vcs?: unknown } }) =>
  instance.project.vcs ? instance.worktree : instance.directory

export const ArtifactPublishTool = Tool.define<typeof PublishParameters, ArtifactMetadata, never>(
  "artifact_publish",
  Effect.gen(function* () {
    return {
      description: PUBLISH_DESCRIPTION,
      parameters: PublishParameters,
      execute: (params: Schema.Schema.Type<typeof PublishParameters>, ctx: Tool.Context<ArtifactMetadata>) =>
        Effect.gen(function* () {
          const title = params.title?.trim()
          if (!title) return refuse("Artifact not published", "`title` is required.")
          if (!params.files || params.files.length === 0) {
            return refuse("Artifact not published", "`files` must contain at least one file.")
          }
          if (!params.artifactId && params.baseVersion !== undefined) {
            return refuse(
              "Artifact not published",
              "`baseVersion` only applies when `artifactId` is given. Omit both to create a new artifact.",
            )
          }

          const planned = planFiles(params.files)
          if (!planned.ok) return refuse("Artifact not published", planned.reason)

          // The cap first: it is decided from `stat` alone, so refusing here
          // costs nothing, and it keeps an oversized publish from putting an
          // external-directory prompt in front of the user for files that were
          // never going to be written.
          const total = plannedBytes(planned.files)
          if (total > MAX_PUBLISH_BYTES) {
            return refuse(
              "Artifact not published",
              `This version is ${mib(total)} (${total} bytes), over the ${mib(MAX_PUBLISH_BYTES)} limit for one artifact version.` +
                " Publish fewer or smaller files, or leave the large ones in the repo and link to them.",
            )
          }

          // A sourcePath outside the worktree is read by the engine and its
          // contents end up in a stored artifact, so it gets the SAME gate the
          // read/edit/write tools use. Before the publish ask, so the user is
          // never asked to approve publishing a file the engine may not read.
          const sources = planned.files.flatMap((file) => (file.source ? [file.source.absolute] : []))
          for (const absolute of sources) {
            const outcome = yield* assertExternalDirectoryEffect(ctx, absolute).pipe(Effect.exit)
            if (Exit.isFailure(outcome)) {
              if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.failCause(outcome.cause)
              const cause = Cause.squash(outcome.cause)
              const detail = cause instanceof Error ? cause.message : String(cause)
              return refuse(
                "Artifact not published",
                `Reading "${absolute}" outside this project was refused: ${detail}`,
              )
            }
          }

          const store = yield* Effect.promise(() => artifactStore())

          // The base rule is enforced in the store's transaction; this check is
          // the model-facing half of it. Publishing onto an artifact without
          // saying which version you read is exactly the overwrite the whole
          // design exists to refuse, so it is refused before the ask.
          if (params.artifactId) {
            if (!store.artifact(params.artifactId)) {
              return refuse("Artifact not published", `No artifact "${params.artifactId}" in the store.`)
            }
            if (params.baseVersion === undefined) {
              const current = store.latestNumber(params.artifactId)
              return refuse(
                "Artifact not published",
                `Publishing a new version of "${params.artifactId}" needs \`baseVersion\`.` +
                  ` The current version is ${current}: read it with artifact_get, then publish with baseVersion: ${current}.`,
              )
            }
          }

          yield* ctx.ask({
            permission: "artifact_publish",
            patterns: [title],
            always: ["*"],
            metadata: {
              title,
              files: planned.files.map((file) => file.path),
              // The absolute paths whose CONTENTS this publish will copy. A
              // prompt that showed only `logo.png` would hide which file on
              // disk is about to be stored.
              ...(sources.length ? { sources } : {}),
              bytes: total,
              ...(params.artifactId ? { artifactId: params.artifactId } : {}),
            },
          })

          const prepared = loadFiles(planned.files)
          if (!prepared.ok) return refuse("Artifact not published", prepared.reason)

          const instance = yield* InstanceState.context
          let result
          try {
            result = store.publish({
              artifactId: params.artifactId,
              title,
              files: prepared.files,
              entryPath: params.entryPath,
              baseVersion: params.artifactId ? Math.floor(params.baseVersion!) : "absent",
              idempotencyKey: idempotencyKey(ctx.callID, ctx.sessionID, title, prepared.files),
              sessionID: ctx.sessionID,
              projectPath: projectOf(instance),
            })
          } catch (error) {
            // Path safety rejects the WHOLE publish before a byte is written,
            // and the fix is a different path, which is the model's to make.
            if (error instanceof ArtifactPathError) {
              return refuse("Artifact not published", error.message)
            }
            throw error
          }

          if (result.kind === "conflict") {
            return {
              title: "Artifact conflict",
              output: [
                `Conflict: nothing was written. You published "${title}" onto version ${params.baseVersion},`,
                `but artifact ${result.artifactId} is already at version ${result.currentVersion}.`,
                "",
                `To build on the newer one: artifact_get { artifactId: "${result.artifactId}", version: ${result.currentVersion} },`,
                `then artifact_publish with baseVersion: ${result.currentVersion}.`,
                "To keep yours separately instead: artifact_publish the same files with no artifactId, which creates a new artifact.",
              ].join("\n"),
              metadata: {
                conflict: true,
                artifactId: result.artifactId,
                version: result.currentVersion,
                digest: result.currentDigest,
              },
            }
          }

          // The ACP forwarder subscribes to this once per engine and pushes the
          // change to the sidebar. Emitted after the write, never before: a
          // listener that refetches must find the new version already there.
          // `sessionID` lets the host auto-open a NEW artifact in the chat that
          // made it, and in no other chat.
          emitArtifactChange({
            artifactId: result.artifactId,
            version: result.version,
            kind: "published",
            sessionID: ctx.sessionID,
          })

          const detail = store.get(result.artifactId, result.version)
          return {
            title: `Published v${result.version}`,
            output: [
              `Published "${title}" as artifact ${result.artifactId}, version ${result.version}.`,
              `Content token: ${result.contentToken}`,
              `Manifest digest: ${result.digest}`,
              ...(detail?.version.entryPath ? [`Opens at: ${detail.version.entryPath}`] : []),
              `Files (${prepared.files.length}):`,
              ...(detail?.entries ?? []).map(describeEntry),
              "",
              linkLine(title, result.artifactId, result.version),
              "Put the Link line in your reply as written: the chat shows it as a card that opens the artifact.",
              `To publish a next version, pass artifactId: "${result.artifactId}" and baseVersion: ${result.version}.`,
              PILL_NUDGE,
            ].join("\n"),
            metadata: {
              artifactId: result.artifactId,
              version: result.version,
              digest: result.digest,
              contentToken: result.contentToken,
              files: prepared.files.length,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof PublishParameters, ArtifactMetadata>
  }),
)

export const ArtifactListTool = Tool.define<typeof ListParameters, ArtifactMetadata, never>(
  "artifact_list",
  Effect.gen(function* () {
    return {
      description: LIST_DESCRIPTION,
      parameters: ListParameters,
      execute: (params: Schema.Schema.Type<typeof ListParameters>, ctx: Tool.Context<ArtifactMetadata>) =>
        Effect.gen(function* () {
          void ctx
          const store = yield* Effect.promise(() => artifactStore())
          const instance = yield* InstanceState.context
          const items = store.list({ all: params.all === true, projectPath: projectOf(instance) })
          if (items.length === 0) {
            return {
              title: "No artifacts",
              output:
                params.all === true
                  ? "The artifact store is empty. Publish one with artifact_publish."
                  : "No artifacts for this project yet. Pass all: true to see every artifact on this machine.",
              metadata: { files: 0 },
            }
          }
          const lines = items.map(
            (item) =>
              `- ${item.id}  v${item.latestVersion}  ${new Date(item.updated).toISOString()}  ${item.title}`,
          )
          return {
            title: `${items.length} artifact${items.length === 1 ? "" : "s"}`,
            output: [
              params.all === true ? "All artifacts on this machine:" : "Artifacts for this project:",
              ...lines,
              "",
              "Read one with artifact_get. " + PILL_NUDGE,
            ].join("\n"),
            metadata: { files: items.length },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof ListParameters, ArtifactMetadata>
  }),
)

export const ArtifactGetTool = Tool.define<typeof GetParameters, ArtifactMetadata, never>(
  "artifact_get",
  Effect.gen(function* () {
    return {
      description: GET_DESCRIPTION,
      parameters: GetParameters,
      execute: (params: Schema.Schema.Type<typeof GetParameters>, ctx: Tool.Context<ArtifactMetadata>) =>
        Effect.gen(function* () {
          void ctx
          const store = yield* Effect.promise(() => artifactStore())
          const version = params.version === undefined ? undefined : Math.floor(params.version)
          const detail = store.get(params.artifactId, version)
          if (!detail) {
            return refuse(
              "Artifact not found",
              version === undefined
                ? `No artifact "${params.artifactId}" in the store. Call artifact_list to see what is there.`
                : `No version ${version} of artifact "${params.artifactId}".`,
            )
          }

          const body: string[] = []
          for (const entry of detail.entries) {
            if (!isText(entry.mediaType) || entry.size > INLINE_LIMIT) {
              body.push(`### ${entry.path} (${entry.size} bytes, ${entry.mediaType}) — not shown`)
              continue
            }
            const bytes = store.readBlob(entry.sha256)
            if (!bytes) {
              // Bodies are pruned by the retention window while rows stay, so a
              // missing blob is an expected state, not a broken store.
              body.push(`### ${entry.path} (${entry.size} bytes, ${entry.mediaType}) — content no longer on disk`)
              continue
            }
            body.push(`### ${entry.path} (${entry.mediaType})`, new TextDecoder().decode(bytes))
          }

          return {
            title: `${detail.artifact.title} v${detail.version.number}`,
            output: [
              `Artifact ${detail.artifact.id} "${detail.artifact.title}", version ${detail.version.number} of ${store.latestNumber(detail.artifact.id)}.`,
              `Manifest digest: ${detail.version.digest}`,
              ...(detail.version.entryPath ? [`Opens at: ${detail.version.entryPath}`] : []),
              linkLine(detail.artifact.title, detail.artifact.id, detail.version.number),
              "Files:",
              ...detail.entries.map(describeEntry),
              "",
              ...body,
              "",
              `To publish a new version, pass artifactId: "${detail.artifact.id}" and baseVersion: ${store.latestNumber(detail.artifact.id)}.`,
              PILL_NUDGE,
            ].join("\n"),
            metadata: {
              artifactId: detail.artifact.id,
              version: detail.version.number,
              digest: detail.version.digest,
              contentToken: detail.version.contentToken,
              files: detail.entries.length,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof GetParameters, ArtifactMetadata>
  }),
)

export const ArtifactDiffTool = Tool.define<typeof DiffParameters, ArtifactMetadata, never>(
  "artifact_diff",
  Effect.gen(function* () {
    return {
      description: DIFF_DESCRIPTION,
      parameters: DiffParameters,
      execute: (params: Schema.Schema.Type<typeof DiffParameters>, ctx: Tool.Context<ArtifactMetadata>) =>
        Effect.gen(function* () {
          void ctx
          const store = yield* Effect.promise(() => artifactStore())
          const artifact = store.artifact(params.artifactId)
          if (!artifact) {
            return refuse("Artifact not found", `No artifact "${params.artifactId}" in the store.`)
          }
          const from = Math.floor(params.from)
          const to = Math.floor(params.to)
          for (const number of [from, to]) {
            if (!store.version(params.artifactId, number)) {
              return refuse(
                "Version not found",
                `Artifact "${params.artifactId}" has no version ${number}; its latest is ${store.latestNumber(params.artifactId)}.`,
              )
            }
          }

          const diff = store.diff(params.artifactId, from, to)
          const section = (label: string, paths: string[]) =>
            paths.length ? [`${label}:`, ...paths.map((item) => `- ${item}`)] : [`${label}: none`]
          const total = diff.added.length + diff.removed.length + diff.changed.length
          return {
            title: `v${from} to v${to}: ${total} path${total === 1 ? "" : "s"}`,
            output: [
              `${artifact.title} (${artifact.id}), version ${from} compared with version ${to}:`,
              ...section("Added", diff.added),
              ...section("Removed", diff.removed),
              ...section("Changed", diff.changed),
              "",
              "This is a file-level comparison. Read a changed file with artifact_get.",
              PILL_NUDGE,
            ].join("\n"),
            metadata: { artifactId: artifact.id, version: to, files: total },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof DiffParameters, ArtifactMetadata>
  }),
)
