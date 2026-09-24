import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Schedule from "effect/Schedule"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@origami/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<unknown[]>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: Effect.try({
        try: () => native.serialize(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
          }),
      }),
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

/** The failures of the WAL switch that another process opening the same new
 *  file at the same moment causes, and that a retry clears. SQLITE_IOERR_TRUNCATE
 *  is the Windows form: a file another process has open cannot be truncated. */
const isOpenRace = (cause: unknown) => {
  const code = typeof cause === "object" && cause !== null ? String((cause as { code?: unknown }).code) : ""
  return code.startsWith("SQLITE_BUSY") || code === "SQLITE_IOERR_TRUNCATE"
}

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      // t-tc2193: the busy handler FIRST. Switching to WAL (and the WAL
      // recovery another opener may be running) takes a lock; with SQLite's
      // default timeout of 0 the second of two engines starting together fails
      // here at once with SQLITE_BUSY / SQLITE_BUSY_RECOVERY.
      native.run("PRAGMA busy_timeout = 5000;")
      // The switch of a NEW file to WAL can still fail at once while other
      // engines open it: SQLite skips the busy handler when waiting could
      // deadlock (this connection holds a shared lock and wants an exclusive
      // one), and on Windows a truncate of a file another process holds fails.
      // Retry it, bounded to the same 5 s.
      if (config.disableWAL !== true)
        yield* Effect.try({ try: () => native.run("PRAGMA journal_mode = WAL;"), catch: (cause) => cause }).pipe(
          Effect.retry({ while: isOpenRace, times: 250, schedule: Schedule.spaced("20 millis") }),
          Effect.orDie,
        )
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}
