// t-tc2rlo #10: at most one engine per repo runs the hourly snapshot gc. Two
// engine PROCESSES on the same repo each schedule their own `cleanup()`
// independently — the in-process `locked()` semaphore in snapshot/index.ts
// cannot see across processes, so before this fix both actually ran
// `git gc --prune=7.days` on the SAME gitdir every hour. `claimGcLease` is
// the cross-process gate: a real, on-disk exclusive-create race, standing in
// for two separate engine processes reaching the same gitdir.
import { describe, expect } from "bun:test"
import { FSUtil } from "@origami/core/fs-util"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { GC_LEASE_TTL_MS, claimGcLease } from "@/snapshot"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))

describe("Snapshot.claimGcLease", () => {
  it.live("only ONE of two racing claims on the same gitdir wins", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const gitdir = yield* tmpdirScoped()
      const now = () => 1_000_000

      const [first, second] = yield* Effect.all(
        [claimGcLease(fs, gitdir, now), claimGcLease(fs, gitdir, now)],
        { concurrency: "unbounded" },
      )

      // Exactly one engine actually runs gc; the other skips this hour.
      expect([first, second].filter(Boolean)).toHaveLength(1)
    }),
  )

  it.live("a claim within the TTL blocks a later engine reaching the same gitdir", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const gitdir = yield* tmpdirScoped()
      let clock = 1_000_000
      const now = () => clock

      expect(yield* claimGcLease(fs, gitdir, now)).toBe(true)
      clock += 5 * 60_000 // 5 minutes later, well inside the TTL
      expect(yield* claimGcLease(fs, gitdir, now)).toBe(false)
    }),
  )

  it.live("a stale claim (past the TTL) is retaken rather than blocking gc forever", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const gitdir = yield* tmpdirScoped()
      let clock = 1_000_000
      const now = () => clock

      expect(yield* claimGcLease(fs, gitdir, now)).toBe(true)
      // The claimant crashed mid-gc and never cleared it. Past the TTL, a
      // DIFFERENT engine's later hourly tick must still be able to run.
      clock += GC_LEASE_TTL_MS + 60_000
      expect(yield* claimGcLease(fs, gitdir, now)).toBe(true)
    }),
  )

  it.live("different gitdirs never contend for the same claim", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const gitdirA = yield* tmpdirScoped()
      const gitdirB = yield* tmpdirScoped()
      const now = () => 1_000_000

      expect(yield* claimGcLease(fs, gitdirA, now)).toBe(true)
      expect(yield* claimGcLease(fs, gitdirB, now)).toBe(true)
    }),
  )
})
