export * as ACPNestArtifacts from "./nest-artifacts"

import { RequestError } from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { emitArtifactChange } from "@/artifact/events"
import { artifactStore } from "@/artifact/instance"
import { NestSync } from "@/artifact/nest-sync"
import * as ACPError from "./error"

/**
 * Artifacts in the nest (lane 4, t-sj39jx): four ext methods over this
 * process's artifact store, dispatched from `acp/agent.ts` beside the session
 * nest methods (acp/nests.ts) and gated the same way: anything but an exact
 * `enabled: true` is refused with data `{ service: "nests", reason: "nests-off" }`
 * before the store is opened.
 *
 *   nest_artifact_index  {deskName}                    -> {rows, others}
 *   nest_artifact_apply  {desk, rows, replace}         -> ApplyResult
 *   nest_artifact_export {artifactId, version, sha256?, offset?, maxBytes?}
 *                        -> the manifest, or one base64 piece of one blob
 *   nest_artifact_import {chunk, deskName?}            -> the import result
 *
 * Refusals the host acts on (not-found, gap, missing blobs) are VALUES, like
 * nest_export's; a thrown error is a fault.
 */

export const METHODS = [
  "nest_artifact_index",
  "nest_artifact_apply",
  "nest_artifact_export",
  "nest_artifact_import",
] as const

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)
const int = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min

function refuse(method: string) {
  return new RequestError(-32602, `${method} refused: Nests is off on this desk`, {
    service: "nests",
    reason: "nests-off",
  })
}

/** The effect for one of the four methods, or undefined when `name` is not one. Throws
 *  RequestError for a refused or malformed call, so nothing downstream runs. */
export function dispatch(
  name: string,
  params: Record<string, unknown> | undefined,
): Effect.Effect<unknown, ACPError.Error> | undefined {
  if (!(METHODS as readonly string[]).includes(name)) return undefined
  if (params?.["enabled"] !== true) throw refuse(name)
  const deviceId = text(params["deviceId"])
  if (!deviceId) throw RequestError.invalidParams(`${name} requires a non-empty string deviceId`)
  switch (name) {
    case "nest_artifact_index": {
      const deskName = text(params["deskName"]) ?? ""
      return run((store) => NestSync.index({ store, deviceId, deskName }))
    }
    case "nest_artifact_apply": {
      const desk = text(params["desk"])
      const rows = params["rows"]
      if (!desk || !Array.isArray(rows))
        throw RequestError.invalidParams("nest_artifact_apply requires a string desk and an array rows")
      return run((store) => NestSync.applyIndex({ store, deviceId, desk, rows, replace: params["replace"] === true }))
    }
    case "nest_artifact_export": {
      const artifactId = text(params["artifactId"])
      const version = params["version"]
      if (!artifactId || !int(version, 1))
        throw RequestError.invalidParams("nest_artifact_export requires a string artifactId and an integer version >= 1")
      const sha256 = params["sha256"]
      if (sha256 === undefined) return run((store) => NestSync.exportManifest({ store, deviceId, artifactId, version }))
      const offset = params["offset"] ?? 0
      const maxBytes = params["maxBytes"] ?? NestSync.DEFAULT_PIECE_BYTES
      if (!text(sha256) || !int(offset, 0) || !int(maxBytes, 1))
        throw RequestError.invalidParams("nest_artifact_export sha256, offset and maxBytes are malformed")
      return run((store) =>
        NestSync.exportBlob({ store, artifactId, version, sha256: sha256 as string, offset, maxBytes }),
      )
    }
    case "nest_artifact_import": {
      const chunk = params["chunk"]
      if (typeof chunk !== "object" || chunk === null)
        throw RequestError.invalidParams("nest_artifact_import requires an object chunk")
      const c = chunk as Record<string, unknown>
      if (c["kind"] === "blob") return run((store) => NestSync.importBlob({ store, chunk: c }))
      if (c["kind"] !== "manifest")
        throw RequestError.invalidParams("nest_artifact_import chunk.kind must be manifest or blob")
      const deskName = text(params["deskName"])
      return run((store) => {
        const result = NestSync.importManifest({ store, chunk: c, ...(deskName ? { deskName } : {}) })
        // The pane and the other windows re-read, as after a publish. No sessionID: nothing auto-opens.
        if ("result" in result && (result.result === "added" || result.result === "sibling"))
          emitArtifactChange({
            artifactId: result.result === "sibling" ? result.sibling : result.artifactId,
            version: result.result === "sibling" ? 1 : result.version,
            kind: "imported",
          })
        return result
      })
    }
  }
  return undefined
}

function run<A>(body: (store: Awaited<ReturnType<typeof artifactStore>>) => A) {
  return Effect.tryPromise({ try: async () => body(await artifactStore()), catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.logError("nest artifact call failed", { error: error instanceof Error ? error.message : String(error) }).pipe(
        Effect.andThen(
          Effect.fail(new ACPError.ServiceFailureError({ safeMessage: "Origami artifact nest failure", service: "nests" })),
        ),
      ),
    ),
  )
}
