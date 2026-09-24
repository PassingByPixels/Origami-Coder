// origami_change (t-qdc718): the agent snapshot cache is the thing a new chat now TRUSTS
// instead of rebuilding, so these tests are about the two ways trusting it could hurt:
// serving an answer that differs from the live one, and serving a stale one after the user
// changed something.
//
// Real paths are safe here because `test/preload.ts` points XDG_DATA_HOME at a temp
// directory before `Global` loads (docs Part 9).
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { AgentSnapshotCache } from "../../src/agent/snapshot-cache"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const KEY = { directory: "/round/trip", config: { model: "acme/big" }, skillDirs: ["/skills/a"] }

describe("agent snapshot cache", () => {
  // THE no-behaviour-change claim, against the REAL registry rather than a hand-built
  // fixture: whatever `Agent.list` produces has to survive the JSON round trip the cache
  // takes, field for field. A class instance, a Set, a Date or a symbol in any archetype
  // would fail here - which is the whole reason this is asserted on live output.
  it.instance("a cached snapshot is deep-equal to the live registry", () =>
    Effect.gen(function* () {
      const live = yield* Agent.Service.use((svc) => svc.list())
      expect(live.length).toBeGreaterThan(0)

      const key = AgentSnapshotCache.key({ directory: "/live", config: {}, skillDirs: [] })
      AgentSnapshotCache.write(key, live)
      const cached = AgentSnapshotCache.read(key)

      expect(cached).toEqual(live as never)
      expect(cached!.map((agent) => agent.name)).toEqual(live.map((agent) => agent.name))
    }),
  )

  test("a written snapshot is read back", () => {
    const key = AgentSnapshotCache.key(KEY)
    AgentSnapshotCache.write(key, [
      { name: "build", mode: "primary", permission: [], options: {} },
      { name: "explore", mode: "subagent", permission: [], options: {}, native: true },
    ] as never)
    expect(AgentSnapshotCache.read(key)?.map((agent) => agent.name)).toEqual(["build", "explore"])
  })

  test("a truncated or foreign file is a MISS, not a throw", () => {
    const key = AgentSnapshotCache.key(KEY)
    AgentSnapshotCache.write(key, [{ name: "build", mode: "primary", permission: [], options: {} }] as never)
    const file = AgentSnapshotCache.file(key)
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 20))
    expect(AgentSnapshotCache.read(key)).toBeUndefined()
    fs.writeFileSync(file, JSON.stringify({ format: 999, agents: [] }))
    expect(AgentSnapshotCache.read(key)).toBeUndefined()
    // The shape guard: an entry that is not an agent must not be served as one.
    fs.writeFileSync(file, JSON.stringify({ format: 1, agents: [{ name: "build" }] }))
    expect(AgentSnapshotCache.read(key)).toBeUndefined()
    fs.writeFileSync(file, JSON.stringify({ format: 1, agents: "not-an-array" }))
    expect(AgentSnapshotCache.read(key)).toBeUndefined()
  })

  test("a missing file is a miss", () => {
    expect(AgentSnapshotCache.read("0".repeat(64))).toBeUndefined()
  })

  // An agent definition file edited, added or deleted reaches the key through the MERGED
  // config, because `Config.get` merges every `agent/**.md` file's parsed content into
  // `cfg.agent`. This is the unit-level half of the invalidation the ACP subprocess test
  // proves end to end.
  test("an agent definition change changes the key", () => {
    const before = AgentSnapshotCache.key({
      directory: "/d",
      config: { agent: { one: { prompt: "a" } } },
      skillDirs: [],
    })
    const edited = AgentSnapshotCache.key({
      directory: "/d",
      config: { agent: { one: { prompt: "b" } } },
      skillDirs: [],
    })
    const added = AgentSnapshotCache.key({
      directory: "/d",
      config: { agent: { one: { prompt: "a" }, two: {} } },
      skillDirs: [],
    })
    expect(edited).not.toBe(before)
    expect(added).not.toBe(before)
  })

  // A new skill directory changes the permission allow-globs the registry carries, and
  // nothing in the config need change for it to appear.
  test("a skill directory appearing changes the key", () => {
    const before = AgentSnapshotCache.key({ directory: "/d", config: {}, skillDirs: ["/a"] })
    const after = AgentSnapshotCache.key({ directory: "/d", config: {}, skillDirs: ["/a", "/b"] })
    expect(after).not.toBe(before)
  })

  // Discovery order is not information: two processes that find the same directories in
  // a different order must share one cache entry, or the cache would miss at random.
  test("skill directory ORDER does not change the key", () => {
    expect(AgentSnapshotCache.key({ directory: "/d", config: {}, skillDirs: ["/b", "/a"] })).toBe(
      AgentSnapshotCache.key({ directory: "/d", config: {}, skillDirs: ["/a", "/b"] }),
    )
  })

  test("a different directory changes the key", () => {
    expect(AgentSnapshotCache.key({ directory: "/one", config: {}, skillDirs: [] })).not.toBe(
      AgentSnapshotCache.key({ directory: "/two", config: {}, skillDirs: [] }),
    )
  })

  // The regression that made the provider catalog cache never hit once was a key that
  // moved every process. This one reads no environment at all, so the same inputs must
  // give the same key twice running.
  test("the same inputs give the same key", () => {
    expect(AgentSnapshotCache.key(KEY)).toBe(AgentSnapshotCache.key(KEY))
  })
})
