/**
 * LLM runtime parity harness (phase 0).
 *
 * Records real OpenAI-compatible traffic through the production (AI SDK) path,
 * then replays each cassette through BOTH runtimes and diffs the `LLMEvent`
 * streams. `src/session/llm.ts` falls back to the AI SDK *silently* when the
 * native runtime reports `unsupported`, so a zero diff without the status
 * guard below would be a lie — the guard fails the cassette and reports the
 * reason instead.
 *
 * PROVIDERS (see `llm-parity/scenarios.ts`; cassettes live in
 * `test/cassettes/<family>/<provider>-<scenario>.json`):
 *
 *   id                 family             auth   credential
 *   vllm               openai-compatible  none   -
 *   lmstudio           openai-compatible  none   -
 *   openrouter         openai-compatible  key    $env:PARITY_KEY_OPENROUTER
 *   opencode-go        openai-compatible  key    $env:PARITY_KEY_OPENCODE_GO
 *   openrouter-native  openrouter         key    $env:PARITY_KEY_OPENROUTER
 *   anthropic          anthropic          key    $env:PARITY_KEY_ANTHROPIC
 *   openai             openai             oauth  $env:PARITY_AUTH_FILE (auth.json)
 *   xai                xai                oauth  $env:PARITY_AUTH_FILE (auth.json)
 *   copilot            copilot            oauth  $env:PARITY_AUTH_FILE (auth.json)
 *   copilot-responses  copilot            oauth  $env:PARITY_AUTH_FILE (auth.json)
 *   copilot-chat-gpt5  copilot            oauth  $env:PARITY_AUTH_FILE (auth.json)
 *   copilot-responses-long copilot        oauth  $env:PARITY_AUTH_FILE (auth.json)
 *
 * A KEYED provider takes its key from the env var above, and when that is
 * empty from the provider's `type: "api"` entry in PARITY_AUTH_FILE — the
 * same file the OAuth providers copy in — and when that has nothing from
 * `provider.<id>.options.apiKey` in PARITY_CONFIG_FILE (origami.json, where
 * a key entered in the extension's Connections pane lives). A live key
 * never has to be put in the environment.
 *
 * The two copilot entries share one CONFIG provider id ("github-copilot"),
 * because that is the id the Copilot plugin's auth loader and hooks key on;
 * `providerID` on the entry carries it. They still get separate cassettes.
 *
 * Record (PowerShell, from `packages/engine`). Recording is never implicit:
 * both RECORD and PARITY_PROVIDER are required, and a provider selected
 * without its credential fails before a single request leaves the machine.
 *
 *   Keyless local:
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="vllm,lmstudio"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *   OpenRouter:
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="openrouter"; $env:PARITY_KEY_OPENROUTER="<key>"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *   OpenCode GO:
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="opencode-go"; $env:PARITY_KEY_OPENCODE_GO="<key>"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *   OpenAI (ChatGPT OAuth) / xAI OAuth — both read the SAME auth.json:
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="openai,xai"; $env:PARITY_AUTH_FILE="$HOME/.local/share/origami/auth.json"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *   Anthropic (Haiku) / OpenRouter native — keys read from the same auth.json:
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="anthropic,openrouter-native"; $env:PARITY_AUTH_FILE="$HOME/.local/share/origami/auth.json"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *   or, when the key was entered in the extension's Connections pane (it then lives in origami.json, not auth.json):
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="anthropic,openrouter-native"; $env:PARITY_CONFIG_FILE="$HOME/.config/origami/origami.json"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *   GitHub Copilot OAuth (sign in again with the VS Code app id FIRST, so the
 *   catalog holds gpt-4.1 and gpt-5.4):
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="copilot,copilot-responses"; $env:PARITY_AUTH_FILE="$HOME/.local/share/origami/auth.json"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *   The three Copilot paths the six cassettes above do NOT cover — a gpt-5 id
 *   on /chat/completions (`verbosity`, `reasoning_opaque` replay) and a
 *   /responses answer with more than one reasoning summary part:
 *     $env:RECORD="true"; $env:PARITY_PROVIDER="copilot-chat-gpt5,copilot-responses-long"; $env:PARITY_AUTH_FILE="$HOME/.local/share/origami/auth.json"; bun test --timeout 300000 test/session/llm-parity.test.ts
 *
 * PARITY_AUTH_FILE is COPIED into the test sandbox and deleted again when the
 * run ends; the source file is never written. A refresh that rotates a token
 * inside the sandbox is reported (`PARITY-AUTH <provider> rotated: ...`) and
 * the rotated file is written to `<PARITY_AUTH_FILE>.refreshed` for the owner
 * to move into place by hand.
 *
 * Replay (the default) — no credentials, no network. OAuth providers get a
 * FIXTURE auth.json in the sandbox so their plugin loaders run as at record
 * time (the proxy never forwards, so the fake token goes nowhere):
 *   bun test --timeout 300000 test/session/llm-parity.test.ts
 */

import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Global } from "@origami/core/global"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { HttpRecorderInternal } from "@origami/http-recorder/internal"
import type { LLMEvent } from "@origami/llm"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Auth } from "@/auth"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { LLMParityDiff } from "./llm-parity/diff"
import {
  LLMParityScenarios,
  type ParityProvider,
  type ParityScenario,
} from "./llm-parity/scenarios"
import { LLMParityServer, type CapturedRequest } from "./llm-parity/server"

const TIMEOUT = 300_000

const shouldRecord = process.env["RECORD"] === "true"
// Recording talks to real endpoints, so it is never implicit: with no
// PARITY_PROVIDER, nothing records.
const selected = new Set(
  (process.env["PARITY_PROVIDER"] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
)

/**
 * Where the sandbox keeps credentials. `test/preload.ts` redirects
 * XDG_DATA_HOME to a per-run temp directory before any `src/` import, so this
 * resolves under that temp directory and the owner's real
 * `~/.local/share/origami/auth.json` is invisible to the harness.
 */
const SANDBOX_AUTH = path.join(Global.Path.data, "auth.json")
const AUTH_SOURCE = process.env["PARITY_AUTH_FILE"]
/** The owner's origami.json — keyed providers connected from the extension keep their key there. Read only. */
const CONFIG_SOURCE = process.env["PARITY_CONFIG_FILE"]
/** Record copies the owner's file in; replay writes a FIXTURE (below). */
const usesAuthFile = shouldRecord && Boolean(AUTH_SOURCE)
let authBefore: string | undefined

/**
 * Replay-mode auth.json: one fixture OAuth entry per OAuth provider, so the
 * plugin auth loaders run exactly as they did at record time. That matters
 * because the loaders are where the production path diverges from a keyed
 * one — the codex loader installs the signing fetch and its options, and the
 * engine keys other choices on `auth.type`. Nothing here is a real
 * credential; the proxy answers from the cassette and never forwards.
 */
const REPLAY_AUTH = Object.fromEntries(
  LLMParityScenarios.PROVIDERS.filter((provider) => LLMParityScenarios.auth(provider) === "oauth").map((provider) => [
    LLMParityScenarios.providerKey(provider),
    {
      type: "oauth",
      refresh: "parity-replay-refresh",
      access: "parity-replay-access",
      expires: Date.now() + 24 * 60 * 60 * 1000,
      ...(LLMParityScenarios.providerKey(provider) === "openai" ? { accountId: "parity-replay-account" } : {}),
    },
  ]),
)
const usesReplayAuth = !shouldRecord && Object.keys(REPLAY_AUTH).length > 0

const readIfPresent = (file: string) =>
  fs.readFile(file, "utf8").then(
    (text) => text as string | undefined,
    () => undefined,
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

const parseAuth = (text: string | undefined): Record<string, Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(text ?? "{}")
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, entry]) => (isRecord(entry) ? [[id, entry] as const] : [])),
    )
  } catch {
    return {}
  }
}

/**
 * Which FIELDS of which provider entry a refresh rewrote. Names only — a token
 * value must never reach stdout or a CI log.
 */
const rotationLines = (before: string | undefined, after: string) => {
  const left = parseAuth(before)
  const right = parseAuth(after)
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].toSorted().flatMap((id) => {
    const a = left[id] ?? {}
    const b = right[id] ?? {}
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      .toSorted()
    return fields.length ? [`PARITY-AUTH ${id} rotated: ${fields.join(", ")}`] : []
  })
}

// The AI SDK side must really be the AI SDK: a family that is on by default
// is forced OFF with the family list, and the native side forced on with the
// legacy all-on flag. Neither run is left to the route table's defaults.
// WebSockets are forced OFF: the codex plugin would otherwise open
// `ws://` against the record/replay proxy (pre-release channels default it
// on), which speaks HTTP only.
//
// `Provider.node` already declares `Plugin.node` among its dependencies and
// `LayerNode.compile` walks dependencies transitively, so the built-in auth
// plugins (CodexAuthPlugin, XaiAuthPlugin, ...) load here without a separate
// node: the provider layer calls `plugin.list()` and then runs every
// `auth.loader`, which is what installs `options.fetch`. Record mode asserts
// that install actually happened rather than trusting this comment.
const parityLayer = (native: boolean) =>
  AppNodeBuilder.build(LayerNode.group([Provider.node, LLM.node, Auth.node]), [
    [
      RuntimeFlags.node,
      RuntimeFlags.layer(
        native
          ? { experimentalNativeLlm: true, disableWebSockets: true }
          : { experimentalNativeLlm: false, nativeLlmFamilies: "none", disableWebSockets: true },
      ),
    ],
  ])

const aiSdkLayer = parityLayer(false)
const nativeLayer = parityLayer(true)
const it = testEffect(aiSdkLayer)

const say = (line: string) => process.stdout.write(`${line}\n`)

/**
 * `PARITY_DUMP=<dir>` writes every request body each runtime sent, pretty
 * printed, as `<dir>/<provider>-<scenario>.<runtime>.<n>.json` — the full
 * text the clipped request-diff lines cannot show.
 */
const dump = (name: string, runtime: string, sent: ReadonlyArray<CapturedRequest>) => {
  const dir = process.env["PARITY_DUMP"]
  if (!dir) return
  sent.forEach((request, index) => {
    const file = path.join(dir, `${name}.${runtime}.${index}.json`)
    let text = request.body
    try {
      text = JSON.stringify(JSON.parse(request.body), null, 2)
    } catch {}
    Bun.write(file, text)
  })
}

/** Collect through the LLM service already in context (the AI SDK layer). */
const collect = (input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    return Array.from(yield* llm.stream(input).pipe(Stream.runCollect))
  })

/**
 * Collect through a second, isolated runtime so the native flag fully owns LLM
 * and its transitive dependencies, while still pointing at the same instance
 * directory (and therefore the same config and replay server).
 */
const collectIn = (layer: Layer.Layer<LLM.Service>, input: LLM.StreamInput) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* Effect.promise(() =>
      Effect.runPromise(
        LLM.Service.use((svc) => svc.stream(input).pipe(Stream.runCollect)).pipe(
          Effect.map((events): LLMEvent[] => Array.from(events)),
          Effect.provide(layer),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
    )
  })

const canonicalBody = (body: string) => {
  try {
    return LLMParityDiff.canonicalJson(JSON.parse(body))
  } catch {
    return body
  }
}

const clip = (value: string) => (value.length > 400 ? `${value.slice(0, 400)}…` : value)

/** `text-delta x7, finish x1` — shows at a glance which paths a cassette exercises. */
const histogram = (events: ReadonlyArray<LLMEvent>) => {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  return [...counts.entries()].map(([type, count]) => `${type} x${count}`).join(", ")
}

const requestDiffLines = (
  label: string,
  sent: ReadonlyArray<CapturedRequest>,
  recorded: ReadonlyArray<CapturedRequest>,
) =>
  sent.flatMap((request, index) => {
    const target = recorded[index]
    if (!target) return [`  request-diff ${label}[${index}]: no recorded interaction to compare against`]
    if (canonicalBody(request.body) === canonicalBody(target.body))
      return [`  request-diff ${label}[${index}]: equal`]
    const left = parseBody(request.body)
    const right = parseBody(target.body)
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .filter((key) => LLMParityDiff.canonicalJson(left[key]) !== LLMParityDiff.canonicalJson(right[key]))
      .toSorted()
    return [
      `  request-diff ${label}[${index}]: differs on ${keys.length ? keys.join(", ") : "(non-JSON body)"}`,
      ...keys.map(
        (key) =>
          `    ${key}: sent=${clip(LLMParityDiff.canonicalJson(left[key]) ?? "undefined")} recorded=${clip(LLMParityDiff.canonicalJson(right[key]) ?? "undefined")}`,
      ),
    ]
  })

const parseBody = (body: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed === null || typeof parsed !== "object") return {}
    return Object.fromEntries(Object.entries(parsed))
  } catch {
    return {}
  }
}

const startServer = (options: Parameters<typeof LLMParityServer.start>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => LLMParityServer.start(options)),
    (server) => Effect.promise(() => server.close()),
  )

const resolve = (provider: ParityProvider) =>
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const model = yield* providers.getModel(
      ProviderV2.ID.make(LLMParityScenarios.providerKey(provider)),
      ModelV2.ID.make(provider.modelID),
    )
    // Config-declared models carry no `api.endpoint`; production's Copilot
    // models hook writes one. See `stampEndpoint`.
    return { providers, model: LLMParityScenarios.stampEndpoint(provider, model) }
  })

const record = (provider: ParityProvider, scenario: ParityScenario) =>
  Effect.gen(function* () {
    // Before the server, before the config, before anything leaves the box.
    const blocker = LLMParityScenarios.recordBlocker(provider, AUTH_SOURCE, CONFIG_SOURCE)
    if (blocker) throw new Error(blocker)

    const instance = yield* TestInstance
    const cassette = LLMParityScenarios.cassetteName(provider, scenario)
    const server = yield* startServer({
      mode: "record",
      cassette,
      realBaseURL: provider.realBaseURL,
      apiKey: LLMParityScenarios.recordKey(provider, AUTH_SOURCE, CONFIG_SOURCE),
      forwardBody: provider.forwardBody,
      metadata: {
        family: provider.family,
        provider: provider.id,
        model: provider.modelID,
        scenario: scenario.id,
        recordedWith: "ai-sdk",
      },
    })
    yield* LLMParityScenarios.writeConfig(
      instance.directory,
      LLMParityScenarios.providerConfig(
        provider,
        server.baseURL,
        LLMParityScenarios.recordKey(provider, AUTH_SOURCE, CONFIG_SOURCE),
      ),
    )

    const { providers, model } = yield* resolve(provider)

    // An OAuth provider whose plugin loader did not run would record a cassette
    // of 401s and call it a success. `options.fetch` is what the loader
    // installs, so its absence is the honest signal that the wiring is wrong.
    if (LLMParityScenarios.auth(provider) === "oauth") {
      const key = LLMParityScenarios.providerKey(provider)
      const info = yield* providers.getProvider(ProviderV2.ID.make(key))
      if (typeof info.options["fetch"] !== "function")
        throw new Error(
          `parity: no auth fetch override on provider "${key}" — the plugin auth loader did not run. Check that PARITY_AUTH_FILE holds an "${key}" entry of type "oauth".`,
        )
    }

    const events = yield* LLMParityScenarios.drive({ provider, scenario, model, collect })
    const sent = server.requests()

    say(`PARITY-RECORD ${provider.id}-${scenario.id} | requests=${sent.length} | events=${events.length}`)
    expect(HttpRecorderInternal.hasCassetteSync(cassette, { directory: LLMParityServer.CASSETTE_DIR })).toBe(true)
    expect(sent).toHaveLength(scenario.interactions)
  })

const replay = (provider: ParityProvider, scenario: ParityScenario) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const cassette = LLMParityScenarios.cassetteName(provider, scenario)
    const server = yield* startServer({ mode: "replay", cassette, realBaseURL: provider.realBaseURL })
    yield* LLMParityScenarios.writeConfig(
      instance.directory,
      LLMParityScenarios.providerConfig(provider, server.baseURL, LLMParityScenarios.replayKey(provider)),
    )

    const { providers, model } = yield* resolve(provider)
    const aiSdk = yield* LLMParityScenarios.drive({ provider, scenario, model, collect })
    const aiSdkRequests = server.requests()
    expect(aiSdkRequests).toHaveLength(scenario.interactions)
    say(`  ai-sdk events=${aiSdk.length}: ${histogram(aiSdk)}`)

    // False-green guard: llm.ts falls back to the AI SDK without telling the
    // caller, so ask the native runtime directly whether it would have run.
    const info = yield* providers.getProvider(ProviderV2.ID.make(LLMParityScenarios.providerKey(provider)))
    const authService = yield* Auth.Service
    const auth = yield* authService
      .get(LLMParityScenarios.providerKey(provider))
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    const status = LLMNativeRuntime.status({ model, provider: info, auth })
    const native = status.type === "supported" ? "supported" : `native unsupported: ${status.reason}`

    if (status.type !== "supported") {
      say(
        `PARITY ${provider.id}-${scenario.id} | native=${native} | semantic=skipped | strict=skipped | requests=${aiSdkRequests.length}`,
      )
      for (const line of requestDiffLines("ai-sdk", aiSdkRequests, server.recorded)) say(line)
      expect(native).toBe("supported")
      return
    }

    const nativeEvents = yield* LLMParityScenarios.drive({
      provider,
      scenario,
      model,
      collect: (input) => collectIn(nativeLayer, input),
    })
    const nativeRequests = server.requests()
    say(`  native events=${nativeEvents.length}: ${histogram(nativeEvents)}`)
    dump(`${provider.id}-${scenario.id}`, "ai-sdk", aiSdkRequests)
    dump(`${provider.id}-${scenario.id}`, "native", nativeRequests)

    const semantic = LLMParityDiff.diff(LLMParityDiff.semantic(aiSdk), LLMParityDiff.semantic(nativeEvents))
    const strict = LLMParityDiff.diff(LLMParityDiff.canonicalize(aiSdk), LLMParityDiff.canonicalize(nativeEvents))
    const metadata = LLMParityDiff.diff(LLMParityDiff.metadata(aiSdk), LLMParityDiff.metadata(nativeEvents))

    say(
      `PARITY ${provider.id}-${scenario.id} | native=${native} | semantic=${LLMParityDiff.describe(semantic)} | strict=${LLMParityDiff.describe(strict)} | requests=${nativeRequests.length}`,
    )
    say(`  metadata=${LLMParityDiff.describe(metadata)}`)
    if (strict.firstDiffIndex !== -1)
      say(`  strict first diff: ai-sdk=${JSON.stringify(strict.a)} native=${JSON.stringify(strict.b)}`)
    if (metadata.firstDiffIndex !== -1)
      say(`  metadata first diff: ai-sdk=${clip(JSON.stringify(metadata.a) ?? "undefined")} native=${clip(JSON.stringify(metadata.b) ?? "undefined")}`)
    for (const line of requestDiffLines("ai-sdk", aiSdkRequests, server.recorded)) say(line)
    for (const line of requestDiffLines("native", nativeRequests, server.recorded)) say(line)
    // The two runtimes against each other: the only request baseline for a
    // cassette whose recorded body was not built by the AI SDK.
    for (const line of requestDiffLines("native-vs-ai-sdk", nativeRequests, aiSdkRequests)) say(line)

    expect({ firstDiffIndex: semantic.firstDiffIndex, a: semantic.a, b: semantic.b }).toEqual({
      firstDiffIndex: -1,
      a: undefined,
      b: undefined,
    })
    expect(semantic.aLength).toBe(semantic.bLength)
  })

describe("session.llm runtime parity", () => {
  // The OAuth loaders read auth.json from `Global.Path.data`, which the layer
  // resolves at construction — so the copy has to be in place before the first
  // test builds a layer, not inside one.
  beforeAll(async () => {
    if (usesReplayAuth) {
      await fs.mkdir(path.dirname(SANDBOX_AUTH), { recursive: true })
      await fs.writeFile(SANDBOX_AUTH, JSON.stringify(REPLAY_AUTH), { mode: 0o600 })
      return
    }
    if (!usesAuthFile) return
    authBefore = await readIfPresent(AUTH_SOURCE!)
    if (authBefore === undefined) throw new Error(`parity: PARITY_AUTH_FILE "${AUTH_SOURCE}" cannot be read.`)
    await fs.mkdir(path.dirname(SANDBOX_AUTH), { recursive: true })
    await fs.writeFile(SANDBOX_AUTH, authBefore, { mode: 0o600 })
  })

  // Runs on failure too: a live credential must not survive the run in a temp
  // directory, and the rotated copy must not overwrite the owner's source file.
  afterAll(async () => {
    if (usesReplayAuth) {
      await fs.rm(SANDBOX_AUTH, { force: true })
      return
    }
    if (!usesAuthFile) return
    try {
      const after = await readIfPresent(SANDBOX_AUTH)
      if (after === undefined || after === authBefore) return
      const target = `${AUTH_SOURCE}.refreshed`
      await fs.writeFile(target, after, { mode: 0o600 })
      for (const line of rotationLines(authBefore, after)) say(line)
      say(`PARITY-AUTH refreshed -> ${target}`)
    } finally {
      await fs.rm(SANDBOX_AUTH, { force: true })
    }
  })

  for (const provider of LLMParityScenarios.PROVIDERS) {
    for (const scenario of LLMParityScenarios.SCENARIOS) {
      const name = `${provider.id}-${scenario.id}`
      const cassette = LLMParityScenarios.cassetteName(provider, scenario)

      if (!LLMParityScenarios.runs(provider, scenario)) {
        test.skip(`${name}: not in this provider's scenario list`, () => {})
        continue
      }

      if (shouldRecord) {
        if (!selected.has(provider.id)) {
          test.skip(`${name}: records the production path`, () => {})
          continue
        }
        it.instance(`${name}: records the production path`, () => record(provider, scenario), TIMEOUT)
        continue
      }

      if (!HttpRecorderInternal.hasCassetteSync(cassette, { directory: LLMParityServer.CASSETTE_DIR })) {
        test.skip(`${name}: replays both runtimes`, () => {})
        continue
      }
      it.instance(`${name}: replays both runtimes`, () => replay(provider, scenario), TIMEOUT)
    }
  }
})
