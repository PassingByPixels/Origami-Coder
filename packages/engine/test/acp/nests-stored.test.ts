// t-tijhw6 (scout B #22). `foreignOwner` reads the device id an earlier
// process stored, once per process. A FAILED read (a locked database) was kept
// as that one read, so the read-only guard stayed open for every session
// imported from another desk until the engine restarted. A failed read is not
// kept: the next call reads again. t-tc2b6c (merged over this): the failed read
// now FAILS the call (the guard fails closed), and a read that finds no id is
// not kept either, because another engine on the store may store one later.
import { expect, mock, test } from "bun:test"
import { Effect } from "effect"
import type * as ACPError from "@/acp/error"
import type { ACPSession } from "@/acp/session"
import type { OrigamiClient } from "@origami/sdk/v2"

const DESK_A = "desk-a"
const DESK_B = "desk-b"
let reads = 0
let failFirstRead = true

// The store and the app runtime are replaced, so this file needs no database.
void mock.module("@/storage/nests", () => ({
  StorageNests: {
    storedDevice: () =>
      Effect.suspend(() => {
        reads++
        return failFirstRead && reads === 1
          ? Effect.fail(new Error("database is locked"))
          : Effect.succeed(failFirstRead ? DESK_A : undefined)
      }),
    foreignOwner: (input: { deviceId: string }) => Effect.succeed(input.deviceId === DESK_A ? DESK_B : undefined),
  },
}))
void mock.module("@/effect/app-runtime", () => ({
  AppRuntime: {
    runPromise: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect),
    // The test preload disposes the runtime after the file.
    dispose: () => Promise.resolve(),
  },
}))

// Import AFTER the mocks so the module picks them up.
const { ACPNests } = await import("@/acp/nests")

const nests = () =>
  ACPNests.make({
    sdk: {} as OrigamiClient,
    session: {} as ACPSession.Interface,
    request: <T>(fn: () => Promise<T>) =>
      Effect.tryPromise({ try: fn, catch: (error) => error as ACPError.Error }),
  })

test("a failed stored-device read is not kept: the next call reads again", async () => {
  reads = 0
  failFirstRead = true
  const { foreignOwner } = nests()

  // The failed read fails the call (fail closed); the next call reads again.
  expect((await Effect.runPromiseExit(foreignOwner("ses_1")))._tag).toBe("Failure")
  expect(await Effect.runPromise(foreignOwner("ses_1"))).toBe(DESK_B)
  expect(await Effect.runPromise(foreignOwner("ses_1"))).toBe(DESK_B)
  expect(reads).toBe(2)
})

test("a read that finds no stored id is not kept: another engine may store one", async () => {
  reads = 0
  failFirstRead = false
  const { foreignOwner } = nests()

  expect(await Effect.runPromise(foreignOwner("ses_1"))).toBeUndefined()
  expect(await Effect.runPromise(foreignOwner("ses_1"))).toBeUndefined()
  expect(reads).toBe(2)
})
