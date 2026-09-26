// t-xnvp72: the first-turn warm builds the provider state and the environment block AT THE
// SAME TIME. They ran one after the other, so a slow provider discovery (3 s on the owner's
// remote vLLM) also held back the environment block, and the first message waited for both.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ElasticWarm } from "../../src/elastic/warm"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"

describe("first-turn warm", () => {
  test("the environment block is built while the provider state is still being built", async () => {
    const events: string[] = []
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => (releaseProvider = resolve))
    const store = { load: () => Effect.succeed({ directory: "/w", worktree: "/w", project: { id: "p", vcs: "git" } }) }
    const provider = {
      defaultModel: () => Effect.succeed({ providerID: "fake", modelID: "m" }),
      // The provider state is done only once the environment block has been built. Built
      // in series (provider first), the warm never ends.
      getModel: () =>
        Effect.promise(async () => {
          events.push("provider started")
          await providerGate
          events.push("provider done")
          return {}
        }),
    }
    const system = {
      environment: () =>
        Effect.sync(() => {
          events.push("environment done")
          releaseProvider()
          return [] as string[]
        }),
    }
    const run = ElasticWarm.warm("/w").pipe(
      Effect.provideService(InstanceStore.Service, store as unknown as InstanceStore.Interface),
      Effect.provideService(Provider.Service, provider as unknown as Provider.Interface),
      Effect.provideService(SystemPrompt.Service, system as unknown as SystemPrompt.Interface),
    )
    const outcome = await Promise.race([
      Effect.runPromise(run).then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 3_000)),
    ])
    expect(outcome).toBe("ended")
    expect(events).toEqual(["provider started", "environment done", "provider done"])
  })
})
