// origami_change (provider_refresh): a model's VISION CAPABILITY rewritten while
// the engine is ALREADY RUNNING has to reach the image check, not just the file.
//
// THE INCIDENT. A vLLM box serves GLM 5.3 Flash. vLLM answers no capability
// probe, so the extension's detection pass sees an empty map, writes nothing,
// and `capabilities.input.image` falls to false. The owner attaches a
// screenshot; session/transform.ts replaces the pixels with a text part saying
// the model cannot read images, so the picture is never sent and never billed.
// The cure is the manual pin - the extension writes `modalities.input` carrying
// "image" into origami.json - and it used to demand a WINDOW RELOAD, because
// nothing told the running engine the file had changed.
//
// WHY NOTHING NOTICED. Identical in shape to the context-window storm its
// sibling file pins. `session/prompt.ts` resolves the turn's model through
// `Provider.getModel`, whose provider list is an `InstanceState` built once from
// `config.get()`, and `capabilities.input.image` is baked into it there
// (provider/provider.ts's config merge reads `model.modalities.input`). The
// merged config is a second `InstanceState`, the global file is cached at
// `Duration.infinity`, and there is no watcher. `resolveConfiguredModel`'s
// self-heal cannot help either: it fires only when the model ID is MISSING from
// the session snapshot, and a changed MODALITY leaves the id exactly where it
// was.
//
// So the assertion in the middle - still blind after the file already says
// otherwise - is the defect, pinned. Without it this test could pass on a build
// that never cached anything and would prove nothing.
//
// NO `@/session/*` IMPORT, and that is load-bearing rather than tidy. Reading
// through `modelSeesImages` would be the more expressive assertion, and it cost
// this whole family a full-suite run: pulling the session graph into an
// acp/provider-refresh file makes its tests — and the CREDENTIAL tests next door
// — die with "All fibers interrupted without error" whenever
// interject-instance.test.ts and any test/provider module land in the same run.
// provider-refresh-live-turn.test.ts's header carries the bisect that found it,
// and that file exists separately for exactly this reason. So the assertion here
// is the FIELD — which is the whole of `modelSeesImages` (`=== true` on it, see
// session/vision.ts) and the whole of what provider.ts's config merge writes.
// session/vision.test.ts owns the predicate itself.
//
// This drives the PROJECT config rather than the global one, for
// provider-refresh-context-limit.test.ts's reason: the global file's own cache
// is covered by provider-refresh.test.ts, and repeating it here would mean
// writing the developer's real ~/.config/origami/origami.json.

import { afterAll, describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import fs from "fs/promises"
import path from "path"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Provider } from "@/provider/provider"
import { tmpdir } from "../fixture/fixture"

const created: InstanceContext[] = []

afterAll(async () => {
  for (const ctx of created) await InstanceRuntime.disposeInstance(ctx).catch(() => undefined)
})

describe("provider_refresh and the vision pin", () => {
  it("a model pinned as sighted reaches the image check on the call, not before it", async () => {
    const dir = await tmpdir({ git: true, config: modelConfig(false) })
    await using _dir = dir
    const file = path.join(dir.path, "origami.json")

    const ctx = await InstanceRuntime.load({ directory: dir.path })
    created.push(ctx)

    // What the running session believes today: every attached image becomes a
    // "this model cannot read images" text part.
    expect(await sees(ctx)).toBe(false)

    // The extension's write: the owner clicks On, and writeModelVision puts
    // `modalities.input: ["text", "image"]` plus `attachment: true` in the file.
    await fs.writeFile(file, JSON.stringify(modelConfig(true), null, 2))

    // Nothing notices on its own. THIS is the defect - the file says the model
    // can see and every turn still swaps the picture for an apology.
    expect(await sees(ctx)).toBe(false)

    expect(await Effect.runPromise(makeService().providerRefresh({ cwd: dir.path }))).toEqual({ ok: true })

    expect(await sees(ctx)).toBe(true)
  }, 120_000)

  it("and back again - unpinning to Auto stops the engine claiming the model sees", async () => {
    // The mirror case. A refresh that only ever turned vision ON would leave a
    // model handed back to detection still being sent pixels it cannot read,
    // which fails silently on the provider's side rather than in the transform.
    const dir = await tmpdir({ git: true, config: modelConfig(true) })
    await using _dir = dir
    const file = path.join(dir.path, "origami.json")

    const ctx = await InstanceRuntime.load({ directory: dir.path })
    created.push(ctx)

    expect(await sees(ctx)).toBe(true)

    await fs.writeFile(file, JSON.stringify(modelConfig(false), null, 2))
    expect(await sees(ctx)).toBe(true) // still stale, for the same reason

    expect(await Effect.runPromise(makeService().providerRefresh({ cwd: dir.path }))).toEqual({ ok: true })

    expect(await sees(ctx)).toBe(false)
  }, 120_000)
})

/** Whether the NEXT turn would treat this model as able to look, resolved the
 *  way `session/prompt.ts` resolves it — `Provider.getModel` in the session's
 *  own instance — and read on the field `modelSeesImages` gates on. */
function sees(ctx: InstanceContext) {
  const effect: Effect.Effect<boolean, never, AppServices> = Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("visionprobe"), ModelV2.ID.make("test-model"))
    return model.capabilities.input.image === true
  }).pipe(Effect.orDie)
  return AppRuntime.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
}

/** The ACP service with a stub sdk - `providerRefresh` does its work IN the
 *  instance and never touches the sdk, so this is only what `make` needs. */
function makeService() {
  const sdk = {
    config: {
      providers: () => Promise.resolve({ data: { providers: [], default: {} } }),
      get: () => Promise.resolve({ data: {} }),
      refresh: () => Promise.resolve({ data: true }),
    },
    app: { agents: () => Promise.resolve({ data: [] }), skills: () => Promise.resolve({ data: [] }) },
    command: { list: () => Promise.resolve({ data: [] }) },
    session: { list: () => Promise.resolve({ data: [] }) },
  } as unknown as OrigamiClient
  const connection = {
    sessionUpdate: (_update: SessionNotification) => Promise.resolve(),
    extNotification: () => Promise.resolve(),
  } as unknown as Pick<AgentSideConnection, "sessionUpdate" | "extNotification">
  return ACPService.make({ sdk, connection })
}

/**
 * One openai-compatible provider whose single model does or does not declare
 * image input.
 *
 * The two shapes are EXACTLY what the extension's `writeModelVision` produces
 * (packages/vscode/src/dashboard/firstFold.ts): pinning ON sets
 * `attachment: true` and `modalities.input: ["text", "image"]`; pinning back to
 * Auto DELETES both keys rather than writing false, because an absent modality
 * block is what an unconfigured model looks like. Deriving the fixture from the
 * real writer is the point - an invented shape would prove the two halves of
 * this feature agree with each other and with nothing else.
 */
function modelConfig(vision: boolean) {
  return {
    provider: {
      visionprobe: {
        name: "visionprobe",
        id: "visionprobe",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            ...(vision ? { attachment: true, modalities: { input: ["text", "image"] as ("text" | "image")[] } } : {}),
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 131_072, output: 0 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "unused", baseURL: "http://127.0.0.1:1/v1" },
      },
    },
  }
}
