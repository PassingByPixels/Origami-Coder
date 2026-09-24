export * as ACPNests from "./nests"

import { RequestError } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { StorageNests } from "@/storage/nests"
import { StorageNestsHandover } from "@/storage/nests-handover"
import { StorageNestsMeasure } from "@/storage/nests-measure"
import * as ACPError from "./error"
import type { ACPSession } from "./session"

/**
 * Nests L4a (t-s9jgzh) and L5 (t-sb9tlk): the nest ext methods, their wire parsing, and the gate.
 *
 * THE GATE. Every call carries `{ enabled, deviceId }` from the host: `enabled`
 * is the VS Code setting `origamicoder.nests.enabled` (default false), and
 * `deviceId` is this desk's id from the L2 device group. Anything but an exact
 * `enabled: true` is refused here, BEFORE the service or the store is reached,
 * with JSON-RPC data `{ service: "nests", reason: "nests-off" }`. The store's
 * tables are created by the first call that passes, so a desk with Nests off
 * never gets them.
 */

export const NESTS_OFF = "nests-off"

export type NestIndexRequest = {
  readonly deviceId: string
  readonly deskName: string
  /** Chats open in the host's windows on this desk. The engine adds the ones
   *  loaded in this ACP connection itself. */
  readonly open: readonly string[]
}
export type NestIndexResult = {
  /** This desk's rows: what the host sends to the other desks. */
  readonly rows: readonly StorageNests.NestIndexRow[]
  /** Rows the other desks sent: what the host pushes to the webview. */
  readonly others: readonly StorageNests.NestIndexRow[]
}
export type NestApplyIndexRequest = {
  readonly deviceId: string
  readonly desk: string
  readonly rows: readonly unknown[]
  readonly replace: boolean
}
export type NestExportRequest = {
  readonly deviceId: string
  readonly sessionId: string
  readonly after: number
  readonly maxBytes: number
}
export type NestImportRequest = { readonly deviceId: string; readonly chunk: unknown }
export type NestStorageRequest = {
  readonly deviceId: string
  /** t-vbivj4: answer with the partial sums (`done: false`) when the measure
   *  is not done by then. Absent: wait for the whole measure. */
  readonly waitMs?: number
}
export type NestRetentionRequest = {
  readonly deviceId: string
  readonly set?: Partial<Record<StorageNests.RetentionClass, number | null>>
  /** t-vb87lt: `windows` is for a dry run only: what a choice would free. */
  readonly apply?: {
    readonly dryRun: boolean
    readonly windows?: Partial<Record<StorageNests.RetentionClass, number | null>>
  }
}

/** L5 (t-sb9tlk). Host contract: `nest_continue { sessionId, enabled, deviceId,
 *  ownerOnline, ownerRunning }`. `ownerOnline` does not change what the engine
 *  does (idle and offline both take over); the host uses it to decide whether
 *  to send the old owner a release. */
export type NestContinueRequest = {
  readonly deviceId: string
  readonly sessionId: string
  readonly ownerOnline: boolean
  readonly ownerRunning: boolean
}
/** `nest_release { sessionId }`. `owner` (optional, additive) is the new desk,
 *  as the hand-over frame names it; without it the owner row or the other
 *  desks' index rows name it. */
export type NestReleaseRequest = { readonly deviceId: string; readonly sessionId: string; readonly owner?: string }
export type NestReleaseResult =
  | {
      readonly sessionId: string
      readonly owner: string
      /** This desk's last seq after the turn stop. Above the seq the new owner
       *  took the session at: the stop wrote events, and a reconcile saves them. */
      readonly seq: number
      /** The turn stop was sent: to this engine (the session's directory was
       *  known), or to a turn in any engine on this store (t-tc2b6c). */
      readonly aborted: boolean
    }
  | { readonly refused: "not-found" | "unknown-owner"; readonly sessionId: string }
/** `nest_reconcile { sessionId, remoteSeq }`, plus optional `owner` and
 *  `deskName` (additive) for the same reason as release. */
export type NestReconcileRequest = {
  readonly deviceId: string
  readonly sessionId: string
  readonly remoteSeq: number
  readonly owner?: string
  readonly deskName?: string
}

export interface Methods {
  readonly nestIndex: (input: NestIndexRequest) => Effect.Effect<NestIndexResult, ACPError.Error>
  readonly nestApplyIndex: (input: NestApplyIndexRequest) => Effect.Effect<StorageNests.ApplyResult, ACPError.Error>
  readonly nestExport: (input: NestExportRequest) => Effect.Effect<StorageNests.ExportResult, ACPError.Error>
  readonly nestImport: (input: NestImportRequest) => Effect.Effect<StorageNests.ImportResult, ACPError.Error>
  readonly nestStorage: (input: NestStorageRequest) => Effect.Effect<StorageNests.StorageResult, ACPError.Error>
  readonly nestRetention: (input: NestRetentionRequest) => Effect.Effect<StorageNests.RetentionResult, ACPError.Error>
  readonly nestContinue: (
    input: NestContinueRequest,
  ) => Effect.Effect<StorageNestsHandover.ContinueResult, ACPError.Error>
  readonly nestRelease: (input: NestReleaseRequest) => Effect.Effect<NestReleaseResult, ACPError.Error>
  readonly nestReconcile: (
    input: NestReconcileRequest,
  ) => Effect.Effect<StorageNestsHandover.ReconcileResult, ACPError.Error>
}

const METHODS = [
  "nest_index",
  "nest_apply_index",
  "nest_export",
  "nest_import",
  "nest_storage",
  "nest_retention",
  "nest_continue",
  "nest_release",
  "nest_reconcile",
] as const

function refuse(method: string) {
  return new RequestError(-32602, `${method} refused: Nests is off on this desk`, {
    service: "nests",
    reason: NESTS_OFF,
  })
}

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)

/**
 * The effect for a nest method, or `undefined` when `name` is not one. Throws
 * `RequestError` for a refused or malformed call, the same way the other ext
 * methods in `agent.ts` do, so nothing downstream runs.
 */
export function dispatch(
  name: string,
  params: Record<string, unknown> | undefined,
  service: Methods,
): Effect.Effect<unknown, ACPError.Error> | undefined {
  if (!(METHODS as readonly string[]).includes(name)) return undefined
  if (params?.["enabled"] !== true) throw refuse(name)
  const deviceId = text(params["deviceId"])
  if (!deviceId) throw RequestError.invalidParams(`${name} requires a non-empty string deviceId`)
  switch (name) {
    case "nest_index": {
      const open = Array.isArray(params["open"]) ? params["open"].filter((id) => typeof id === "string") : []
      return service.nestIndex({ deviceId, deskName: text(params["deskName"]) ?? "", open })
    }
    case "nest_apply_index": {
      const desk = text(params["desk"])
      const rows = params["rows"]
      if (!desk || !Array.isArray(rows))
        throw RequestError.invalidParams("nest_apply_index requires a string desk and an array rows")
      return service.nestApplyIndex({ deviceId, desk, rows, replace: params["replace"] === true })
    }
    case "nest_export": {
      const sessionId = text(params["sessionId"])
      if (!sessionId) throw RequestError.invalidParams("nest_export requires a string sessionId")
      const after = params["after"] ?? -1
      if (typeof after !== "number" || !Number.isInteger(after) || after < -1)
        throw RequestError.invalidParams("nest_export after must be an integer >= -1")
      const maxBytes = params["maxBytes"] ?? StorageNests.DEFAULT_CHUNK_BYTES
      if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0)
        throw RequestError.invalidParams("nest_export maxBytes must be a positive number")
      return service.nestExport({ deviceId, sessionId, after, maxBytes })
    }
    case "nest_import": {
      if (typeof params["chunk"] !== "object" || params["chunk"] === null)
        throw RequestError.invalidParams("nest_import requires an object chunk")
      return service.nestImport({ deviceId, chunk: params["chunk"] })
    }
    case "nest_storage": {
      const waitMs = params["waitMs"]
      if (waitMs !== undefined && (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0))
        throw RequestError.invalidParams("nest_storage waitMs must be a number >= 0")
      return service.nestStorage({ deviceId, ...(waitMs !== undefined ? { waitMs } : {}) })
    }
    case "nest_retention":
      return service.nestRetention({ deviceId, ...retentionParams(params) })
    case "nest_continue": {
      const sessionId = text(params["sessionId"])
      const ownerOnline = params["ownerOnline"]
      const ownerRunning = params["ownerRunning"]
      if (!sessionId || typeof ownerOnline !== "boolean" || typeof ownerRunning !== "boolean")
        throw RequestError.invalidParams(
          "nest_continue requires a string sessionId and boolean ownerOnline and ownerRunning",
        )
      return service.nestContinue({ deviceId, sessionId, ownerOnline, ownerRunning })
    }
    case "nest_release": {
      const sessionId = text(params["sessionId"])
      if (!sessionId) throw RequestError.invalidParams("nest_release requires a string sessionId")
      const owner = optionalText(params, "nest_release", "owner")
      return service.nestRelease({ deviceId, sessionId, ...(owner ? { owner } : {}) })
    }
    case "nest_reconcile": {
      const sessionId = text(params["sessionId"])
      const remoteSeq = params["remoteSeq"]
      if (!sessionId || typeof remoteSeq !== "number" || !Number.isInteger(remoteSeq) || remoteSeq < -1)
        throw RequestError.invalidParams("nest_reconcile requires a string sessionId and an integer remoteSeq >= -1")
      const owner = optionalText(params, "nest_reconcile", "owner")
      const deskName = optionalText(params, "nest_reconcile", "deskName")
      return service.nestReconcile({
        deviceId,
        sessionId,
        remoteSeq,
        ...(owner ? { owner } : {}),
        ...(deskName ? { deskName } : {}),
      })
    }
  }
  return undefined
}

/** An optional string param: absent is fine, any other type is refused. */
function optionalText(params: Record<string, unknown>, method: string, key: string) {
  const value = params[key]
  if (value === undefined) return undefined
  if (!text(value)) throw RequestError.invalidParams(`${method} ${key} must be a non-empty string`)
  return value as string
}

/** `set` is a WRITE of a setting that a later apply prunes with, so a window
 *  that is not a positive number or `null` is refused, not coerced. `apply` is
 *  dry unless `dryRun` is exactly false, like `storage_prune`. `apply.windows`
 *  (t-vb87lt) takes the same checks as `set` and is refused on a real apply:
 *  an apply prunes with the windows it stores. */
function retentionParams(params: Record<string, unknown>) {
  const set = params["set"]
  const apply = params["apply"]
  const out: {
    set?: Partial<Record<StorageNests.RetentionClass, number | null>>
    apply?: NonNullable<NestRetentionRequest["apply"]>
  } = {}
  if (set !== undefined) out.set = windowsParam(set, "set")
  if (apply !== undefined) {
    if (typeof apply !== "object" || apply === null)
      throw RequestError.invalidParams("nest_retention apply must be an object")
    const dryRun = (apply as Record<string, unknown>)["dryRun"] !== false
    const windows = (apply as Record<string, unknown>)["windows"]
    if (windows !== undefined && !dryRun)
      throw RequestError.invalidParams("nest_retention apply.windows is for a dry run only")
    out.apply = { dryRun, ...(windows !== undefined ? { windows: windowsParam(windows, "apply.windows") } : {}) }
  }
  return out
}

function windowsParam(value: unknown, name: string) {
  if (typeof value !== "object" || value === null)
    throw RequestError.invalidParams(`nest_retention ${name} must be an object`)
  const windows: Partial<Record<StorageNests.RetentionClass, number | null>> = {}
  for (const [key, days] of Object.entries(value)) {
    if (!(StorageNests.CLASSES as readonly string[]).includes(key))
      throw RequestError.invalidParams(`nest_retention unknown class ${key}`)
    if (days !== null && (typeof days !== "number" || !Number.isFinite(days) || days <= 0))
      throw RequestError.invalidParams(`nest_retention ${key} must be a positive number of days or null`)
    windows[key as StorageNests.RetentionClass] = days
  }
  return windows
}

type Request = <T>(fn: () => Promise<T>, service?: string) => Effect.Effect<T, ACPError.Error>

/** The Nests-on mark is kept fresh at most this often; it counts for
 *  `StorageNestsHandover.ACTIVE_MS` (5 min). */
const MARK_EVERY_MS = 60_000

/** t-vbivj4: the one storage measure of this engine process (a scan of the
 *  whole store); every connection's `nest_storage` joins it. */
const measure = new StorageNestsMeasure.MeasureJob<StorageNests.StorageResult>()

/** A partial answer from before the first range is read. */
const nothingYet = (deviceId: string): StorageNests.StorageResult => ({
  deviceId,
  classes: { chats: 0, subagents: 0, toolOutput: 0, journal: 0, artifacts: 0 },
  fileBytes: 0,
  journalEventsPerPart: 0,
  method: "length-sums",
  measuredMs: 0,
  done: false,
  progress: 0,
})

/**
 * The service side. The store work runs on the process-wide AppRuntime, which
 * holds `Database.Service` and the event service whose projectors a replay
 * must run (the same reason `storage_stats` runs there).
 *
 * `self` is the device id of the last call that passed the gate. Until one
 * has, `foreignOwner` reads the stored id, which on a desk where Nests is off
 * is one `sqlite_master` read per write call (t-tc2b6c: no longer once per
 * process, see `foreignOwner`).
 */
export function make(input: {
  readonly sdk: OrigamiClient
  readonly session: ACPSession.Interface
  readonly request: Request
}) {
  let self: string | undefined
  let deskName: string | undefined
  /** The device id an earlier process stored, while one read of it runs. */
  let stored: Promise<string | undefined> | undefined
  /** When this process last wrote the Nests-on mark (the run lease gate). */
  let marked = 0
  const store = <A>(deviceId: string, run: () => Promise<A>, name?: string) => {
    // L5 (t-sb9tlk): the id is kept in the store too, so the read-only guard
    // holds after a restart, before the host calls a nest method again.
    const remember = self !== deviceId || (!!name && name !== deskName)
    self = deviceId
    if (name) deskName = name
    return input.request(async () => {
      if (remember)
        await AppRuntime.runPromise(StorageNests.rememberDevice({ deviceId, ...(name ? { deskName: name } : {}) }))
      // t-tc2b6c: Nests is on. Turns on this store (any engine) lease from
      // their next start, and the turns of this process from now.
      if (Date.now() - marked >= MARK_EVERY_MS) {
        await AppRuntime.runPromise(StorageNestsHandover.markActive())
        marked = Date.now()
      }
      StorageNestsHandover.wake()
      return run()
    }, "nests")
  }

  /** Sessions this connection has loaded, and the ones of them that are busy.
   *  Run state lives per directory, so it is read once per directory. */
  const live = Effect.fnUntraced(function* () {
    const loaded = yield* input.session.list()
    const running = new Set<string>()
    for (const cwd of new Set(loaded.map((info) => info.cwd))) {
      const status = yield* input
        .request(() => input.sdk.session.status({ directory: cwd }, { throwOnError: true }), "nests")
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      for (const [id, value] of Object.entries(status ?? {}))
        if ((value as { type?: string }).type !== "idle") running.add(id)
    }
    return { loaded: loaded.map((info) => info.id), running }
  })

  const methods: Methods = {
    nestIndex: Effect.fn("ACP.nestIndex")(function* (params: NestIndexRequest) {
      const state = yield* live()
      const rows = yield* store(
        params.deviceId,
        async () => {
          // t-tc2b6c: a turn in another engine on this store (another window,
          // or this is the host engine) is running too.
          const leased = await AppRuntime.runPromise(StorageNestsHandover.runningSessions())
          return AppRuntime.runPromise(
            StorageNests.index({
              deviceId: params.deviceId,
              deskName: params.deskName,
              running: new Set([...state.running, ...leased]),
              open: new Set([...state.loaded, ...params.open]),
            }),
          )
        },
        params.deskName,
      )
      const others = yield* store(params.deviceId, () =>
        AppRuntime.runPromise(StorageNests.foreignIndex({ deviceId: params.deviceId })),
      )
      return { rows, others }
    }),
    nestApplyIndex: Effect.fn("ACP.nestApplyIndex")(function* (params: NestApplyIndexRequest) {
      return yield* store(params.deviceId, () => AppRuntime.runPromise(StorageNests.applyIndex(params)))
    }),
    nestExport: Effect.fn("ACP.nestExport")(function* (params: NestExportRequest) {
      return yield* store(params.deviceId, () => AppRuntime.runPromise(StorageNests.exportChunk(params)))
    }),
    nestImport: Effect.fn("ACP.nestImport")(function* (params: NestImportRequest) {
      return yield* store(params.deviceId, () => AppRuntime.runPromise(StorageNests.importChunk(params)))
    }),
    nestStorage: Effect.fn("ACP.nestStorage")(function* (params: NestStorageRequest) {
      // t-vbivj4: one sliced measure per process; a request joins the one that runs.
      return yield* store(params.deviceId, () =>
        measure.read(
          (onPartial) => AppRuntime.runPromise(StorageNests.storage({ deviceId: params.deviceId, onPartial })),
          params.waitMs,
          (latest) => latest ?? nothingYet(params.deviceId),
        ),
      )
    }),
    nestRetention: Effect.fn("ACP.nestRetention")(function* (params: NestRetentionRequest) {
      return yield* store(params.deviceId, () =>
        AppRuntime.runPromise(
          StorageNests.retention({
            ...(params.set ? { set: params.set } : {}),
            ...(params.apply ? { apply: params.apply } : {}),
          }),
        ),
      )
    }),
    nestContinue: Effect.fn("ACP.nestContinue")(function* (params: NestContinueRequest) {
      return yield* store(params.deviceId, () =>
        AppRuntime.runPromise(
          StorageNestsHandover.continueHere({
            deviceId: params.deviceId,
            sessionId: params.sessionId,
            ownerRunning: params.ownerRunning,
          }),
        ),
      )
    }),
    nestRelease: Effect.fn("ACP.nestRelease")(function* (params: NestReleaseRequest) {
      const plan: StorageNestsHandover.ReleaseResult = yield* store(params.deviceId, () =>
        AppRuntime.runPromise(StorageNestsHandover.releasePlan(params)),
      )
      if ("refused" in plan) return plan
      // t-tjhmhw: the turn stops FIRST, while this desk still owns the chat, so
      // the stopped turn writes its closing state (the write transaction refuses
      // every local write once the owner has flipped). The stop is the existing
      // one (the one ACP `cancel` sends); a failed stop is logged, not raised.
      // t-tc2b6c: the turn can run in another engine on this store; the stop
      // request reaches it through the run lease.
      const leased = yield* store(params.deviceId, () =>
        AppRuntime.runPromise(StorageNestsHandover.requestStop(params.sessionId)),
      )
      const directory = plan.directory
      if (directory)
        yield* input
          .request(
            () => input.sdk.session.abort({ directory, sessionID: params.sessionId }, { throwOnError: true }),
            "session",
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logError("nest_release: turn stop failed", { error, sessionID: params.sessionId }),
            ),
          )
      // Bounded: a turn that has not closed by then is cut off by the flip, and
      // its remaining writes are refused.
      if (leased) {
        const stopped = yield* store(params.deviceId, () =>
          AppRuntime.runPromise(StorageNestsHandover.awaitStopped(params.sessionId)),
        )
        if (!stopped)
          yield* Effect.logWarning("nest_release: the turn did not stop in time; the owner flips anyway", {
            sessionID: params.sessionId,
          })
      }
      // Then the owner flips. A prompt that passed the guard since the stop is
      // refused at its first write.
      const released: StorageNestsHandover.ReleaseResult = yield* store(params.deviceId, () =>
        AppRuntime.runPromise(StorageNestsHandover.release(params)),
      )
      if ("refused" in released) return released
      // The seq is read after the flip, so it counts what the stop wrote and the
      // host's reconcile saves it.
      const after = yield* store(params.deviceId, () => AppRuntime.runPromise(StorageNests.ownerRow(params.sessionId)))
      return {
        sessionId: released.sessionId,
        owner: released.owner,
        seq: after?.seq ?? released.seq,
        aborted: directory !== undefined || leased,
      } satisfies NestReleaseResult
    }),
    nestReconcile: Effect.fn("ACP.nestReconcile")(function* (params: NestReconcileRequest) {
      return yield* store(params.deviceId, () => AppRuntime.runPromise(StorageNestsHandover.reconcile(params)))
    }),
  }

  /** The writer of `sessionId` when it is another desk, so a write into a
   *  session imported from it can be refused. Until a nest call has passed the
   *  gate in this process, the id comes from the store; it creates none of the
   *  Nests tables.
   *
   *  t-tc2b6c: the read is kept only once it names a device. A failed read is
   *  not kept (the next call reads again), and a store with no device yet is
   *  read again on the next call: another engine on this store (the host
   *  engine, another window) may be the one that makes the first nest call. */
  const foreignOwner = (sessionId: string): Effect.Effect<string | undefined, ACPError.Error> =>
    input.request(async () => {
      if (!self) {
        stored ??= AppRuntime.runPromise(StorageNests.storedDevice())
        const read = stored
        self ??= await read.finally(() => {
          if (stored === read) stored = undefined
        })
      }
      const deviceId = self
      if (!deviceId) return undefined
      return AppRuntime.runPromise(StorageNests.foreignOwner({ deviceId, sessionId }))
    }, "nests")

  /** THE READ-ONLY GUARD (L5). Every ACP entry that writes into a session calls
   *  this first; a session another desk writes is refused with the RefusalError
   *  the prompt path has used since L4a. t-tc2b6c: it fails CLOSED. When the
   *  owner cannot be read, the write is refused and the fault is logged. */
  const guard = (sessionId: string, action: string): Effect.Effect<void, ACPError.RefusalError> =>
    foreignOwner(sessionId).pipe(
      Effect.catch((error) =>
        Effect.logError("nests: read-only guard could not read the owner", { error, sessionID: sessionId }).pipe(
          Effect.andThen(
            Effect.fail(
              new ACPError.RefusalError({
                safeMessage: `This chat's owner desk could not be read, so it is read only for now (${action} refused). Try again.`,
                service: "nests",
              }),
            ),
          ),
        ),
      ),
      Effect.flatMap((writer) =>
        writer
          ? Effect.fail(
              new ACPError.RefusalError({
                safeMessage: `This chat is read only on this desk: desk ${writer} writes it (${action} refused).`,
                service: "nests",
              }),
            )
          : Effect.void,
      ),
    )

  return { methods, foreignOwner, guard }
}
