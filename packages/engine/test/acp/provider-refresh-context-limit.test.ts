// origami_change (provider_refresh): a model's CONTEXT WINDOW rewritten while the
// engine is ALREADY RUNNING has to reach the overflow check, not just the file.
//
// THE INCIDENT. The owner picked an LM Studio model at 84k. The extension ran
// `lms load -c 86016` and wrote `limit.context: 86016` into origami.json, over a
// stale 36096 left by an earlier smaller load. The engine never saw it, and the
// session auto-compacted FIVE times in four minutes, every time at ~27.1k total
// tokens - exactly `usable()` for a 36096 window (36096 - floor(36096/4) =
// 27072, session/overflow.ts). The baseline prompt was ~24.5k, so the stale
// threshold fired on nearly every turn.
//
// WHY NOTHING NOTICED. `session/prompt.ts` resolves the turn's model through
// `Provider.getModel`, whose provider list is an `InstanceState` built once from
// `config.get()` - and `limit.context` is baked into it there
// (provider/provider.ts's config merge). The merged config is a second
// `InstanceState`, the global file is cached at `Duration.infinity`, and there
// is no watcher. `resolveConfiguredModel`'s existing self-heal cannot help: it
// only fires when the model id is MISSING from the session snapshot, and a
// changed LIMIT leaves the id exactly where it was.
//
// So the assertion in the middle - the STALE reading after the file already
// holds the new number - is the defect, pinned. Without it this test could pass
// on a build that never cached anything and would prove nothing.
//
// This drives the PROJECT config rather than the global one. The global file's
// own cache is covered by provider-refresh.test.ts's second test; repeating it
// here would mean writing the developer's real ~/.config/origami/origami.json.

import { afterAll, describe, expect, it } from "bun:test"
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { OrigamiClient } from "@origami/sdk/v2"
import fs from "fs/promises"
import path from "path"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import type { ConfigV1 } from "@origami/core/v1/config/config"
import { Effect } from "effect"
import * as ACPService from "@/acp/service"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Provider } from "@/provider/provider"
import { usable } from "@/session/overflow"
import { tmpdir } from "../fixture/fixture"

/** The stale window the storm compacted against, and the real loaded one. */
const STALE = 36_096
const LOADED = 86_016
/** `context - floor(context / 4)` - overflow.ts's unknown-output reservation. */
const STALE_USABLE = 27_072
const LOADED_USABLE = 64_512

const created: InstanceContext[] = []

afterAll(async () => {
  for (const ctx of created) await InstanceRuntime.disposeInstance(ctx).catch(() => undefined)
})

describe("provider_refresh and the auto-compaction threshold", () => {
  it("a context window rewritten in config reaches usable() on the call, not before it", async () => {
    const dir = await tmpdir({ git: true, config: modelConfig(STALE) })
    await using _dir = dir
    const file = path.join(dir.path, "origami.json")

    const ctx = await InstanceRuntime.load({ directory: dir.path })
    created.push(ctx)

    // What the running session compacts against today.
    expect(await window(ctx)).toEqual({ context: STALE, usable: STALE_USABLE })

    // The extension's write: `lms load -c 86016`, then the new window persisted.
    await fs.writeFile(file, JSON.stringify(modelConfig(LOADED), null, 2))

    // Nothing notices on its own. THIS is the defect - the file says 86016 and
    // every turn still compacts at 27072.
    expect(await window(ctx)).toEqual({ context: STALE, usable: STALE_USABLE })

    expect(await Effect.runPromise(makeService().providerRefresh({ cwd: dir.path }))).toEqual({ ok: true })

    expect(await window(ctx)).toEqual({ context: LOADED, usable: LOADED_USABLE })
  }, 120_000)
})

/** The window the NEXT turn would resolve, read the way `session/prompt.ts`
 *  reads it: `Provider.getModel` in the session's own instance, then the same
 *  `usable()` the overflow check calls. */
function window(ctx: InstanceContext) {
  const cfg = {} as ConfigV1.Info
  const effect: Effect.Effect<{ context: number; usable: number }, never, AppServices> = Effect.gen(function* () {
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("ctxprobe"), ModelV2.ID.make("test-model"))
    return { context: model.limit.context, usable: usable({ cfg, model }) }
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

/** One openai-compatible provider whose single model declares `context`, with
 *  `output: 0` - the shape every probed local model is written with (the config
 *  schema makes `output` a required sibling of `context`). */
function modelConfig(context: number) {
  return {
    provider: {
      ctxprobe: {
        name: "ctxprobe",
        id: "ctxprobe",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context, output: 0 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "unused", baseURL: "http://127.0.0.1:1/v1" },
      },
    },
  }
}
