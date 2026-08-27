import { Cause, Effect, Exit, Option, Record } from "effect"
import { Auth } from "@/auth"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { ProviderAuth } from "@/provider/auth"
import { ProviderV2 } from "@origami/core/provider"
import { errorMessage } from "@/util/error"

/**
 * The provider OAuth flow, over ACP.
 *
 * The engine already owns every moving part: each provider plugin
 * (`plugin/openai/codex.ts`, `plugin/xai.ts`) implements PKCE, its own loopback
 * listener and its device-code poll, and `provider/auth.ts` orchestrates them
 * and persists the credential through `Auth.Service`. The CLI drives that with
 * `cli/cmd/providers.ts`'s `handlePluginAuth`. The VS Code extension could not,
 * because it talks ACP over stdio and has NO HTTP channel to the engine, so the
 * existing `/provider/auth/*` routes were unreachable from it.
 *
 * These three thin proxies are that missing channel. They add no flow logic —
 * `handlePluginAuth` is the reference and the semantics are mirrored, not
 * reinvented:
 *
 *   list      -> ProviderAuth.methods() + the credential TYPES on file
 *   authorize -> ProviderAuth.authorize(), which starts the plugin's flow and
 *                returns its url/instructions IMMEDIATELY (the loopback server
 *                is already listening at that point)
 *   callback  -> ProviderAuth.callback(), which awaits the plugin's own
 *                `callback()` and persists the credential on success
 *
 * WHY `callback` MAY BLOCK FOR MINUTES AND THAT IS SAFE: the ACP SDK's read
 * loop calls `processMessage` WITHOUT awaiting it
 * (`@agentclientprotocol/sdk/dist/acp.js` — `try { this.processMessage(message) }`
 * inside `receive()`), so a slow request handler does not stall the channel;
 * other requests keep being dispatched and answered while this one waits.
 * `provider-auth.test.ts` pins that behaviour through the real transport.
 *
 * NEVER RETURNS A TOKEN. `list` reports only each credential's `type` and, for
 * an oauth credential, its `expires` — an access/refresh token has no business
 * crossing into a webview process.
 */

/** One login method a provider's plugin offers, as `ProviderAuth.Methods` has it. */
export type Method = {
  readonly type: "oauth" | "api"
  readonly label: string
}

export type Credential = {
  readonly type: "oauth" | "api" | "wellknown"
  /** Epoch millis, oauth credentials only. */
  readonly expires?: number
}

export type ListResult = {
  /** providerID -> the plugin's login methods, in the index order `authorize` takes. */
  readonly methods: Record<string, readonly Method[]>
  /** providerID -> the credential on file. Types only, never a token. */
  readonly connected: Record<string, Credential>
}

export type AuthorizeResult =
  | {
      readonly ok: true
      readonly url: string
      /** "auto" = the plugin is already waiting (loopback / device poll); call
       *  `callback` with no code. "code" = the user pastes a code first. */
      readonly method: "auto" | "code"
      readonly instructions: string
    }
  | { readonly ok: false; readonly message: string }

export type CallbackResult =
  | { readonly ok: true; readonly credential: Credential }
  | { readonly ok: false; readonly message: string }

/**
 * One authorize per provider at a time, PROCESS-wide rather than per-instance.
 *
 * Both shipped OAuth plugins bind a FIXED loopback port (1455 for ChatGPT,
 * 56121 for xAI) because the port is part of the registered redirect_uri, and
 * both keep their pending PKCE state in a module-level variable. A second
 * authorize for the same provider therefore does not start a second
 * independent flow — it supersedes the first (xai.ts's
 * `waitForOAuthCallback` rejects the earlier one outright), which would leave
 * the first caller waiting on a callback that can never arrive. Refusing is
 * the honest answer.
 *
 * Cleared by `callback` (success OR failure), so an abandoned sign-in only
 * blocks retries until the caller stops waiting.
 */
const inflight = new Set<string>()

/** Visible for tests: no sign-in leaks across test cases. */
export function resetInflight(): void {
  inflight.clear()
}

/**
 * How long `callback` waits before answering "timed out".
 *
 * Neither plugin bounds its own wait usefully for a UI: xAI's loopback wait
 * has a 5-minute timeout, but the ChatGPT device-code `callback()` polls in an
 * unbounded `while (true)`. Without a cap here a user who closes the browser
 * tab leaves the pane waiting forever. The plugin's own promise is NOT
 * cancellable, so it keeps running in the background after a timeout — the
 * same leak the CLI has, not a new one; the guard above is released either
 * way so a retry is possible.
 */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

const credentialOf = (info: Auth.Info): Credential =>
  info.type === "oauth" ? { type: "oauth", expires: info.expires } : { type: info.type }

/**
 * Runs against the process-wide AppRuntime, which already provides
 * `ProviderAuth.Service` and `Auth.Service`. `ProviderAuth` keeps its hook table
 * in `InstanceState`, which reads `InstanceRef`, so the instance is loaded and
 * provided here exactly as `ACPAgentPlugins.list` does it.
 */
const withInstance = <A, E, R>(directory: string, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const ctx = yield* store.load({ directory })
    return yield* body.pipe(Effect.provideService(InstanceRef, ctx))
  })

export const list = Effect.fn("ACPProviderAuth.list")(function* (directory: string) {
  return yield* withInstance(
    directory,
    Effect.gen(function* () {
      const providerAuth = yield* ProviderAuth.Service
      const auth = yield* Auth.Service
      const methods = yield* providerAuth.methods()
      const stored = yield* auth.all().pipe(Effect.orElseSucceed(() => ({}) as globalThis.Record<string, Auth.Info>))
      return {
        methods: Record.map(methods, (list) => list.map((m) => ({ type: m.type, label: m.label }))),
        connected: Record.map(stored, credentialOf),
      } satisfies ListResult
    }),
  )
})

export const authorize = Effect.fn("ACPProviderAuth.authorize")(function* (
  directory: string,
  providerID: string,
  methodIndex: number,
) {
  if (inflight.has(providerID)) {
    return {
      ok: false,
      message: `A ${providerID} sign-in is already in progress. Finish or abandon it before starting another.`,
    } satisfies AuthorizeResult
  }
  inflight.add(providerID)
  // On SUCCESS the guard stays held until callback() releases it — that is the
  // whole serialization. But a defect in withInstance's own preamble (a failed
  // instance load) escapes the body's Effect.exit wrapping and would skip both
  // manual deletes below, locking the provider out until engine restart —
  // onError releases on failure/defect/interrupt while leaving success held.
  const exit = yield* withInstance(
    directory,
    Effect.gen(function* () {
      const providerAuth = yield* ProviderAuth.Service
      const available = (yield* providerAuth.methods())[providerID] ?? []
      if (!available[methodIndex]) {
        return yield* Effect.fail(new Error(`methodIndex ${methodIndex} is out of range for ${providerID} (${available.length} methods).`))
      }
      return yield* providerAuth.authorize({
        providerID: ProviderV2.ID.make(providerID),
        method: methodIndex,
      })
    }).pipe(Effect.exit),
  ).pipe(Effect.onError(() => Effect.sync(() => inflight.delete(providerID))))
  if (Exit.isFailure(exit)) {
    inflight.delete(providerID)
    return { ok: false, message: failureMessage(exit.cause) } satisfies AuthorizeResult
  }
  if (!exit.value) {
    // `ProviderAuth.authorize` answers `undefined` for a non-oauth method — the
    // "Manually enter API Key" entry every plugin also carries. There is no
    // browser flow to start, so say so rather than leaving the caller waiting.
    inflight.delete(providerID)
    return {
      ok: false,
      message: `Method ${methodIndex} for ${providerID} is not an OAuth method — use the API key connection instead.`,
    } satisfies AuthorizeResult
  }
  return {
    ok: true,
    url: exit.value.url,
    method: exit.value.method,
    instructions: exit.value.instructions,
  } satisfies AuthorizeResult
})

export const callback = Effect.fn("ACPProviderAuth.callback")(function* (
  directory: string,
  providerID: string,
  methodIndex: number,
  code: string | undefined,
) {
  const exit = yield* withInstance(
    directory,
    Effect.gen(function* () {
      const providerAuth = yield* ProviderAuth.Service
      const auth = yield* Auth.Service
      yield* providerAuth.callback({
        providerID: ProviderV2.ID.make(providerID),
        method: methodIndex,
        ...(code !== undefined ? { code } : {}),
      })
      const stored = yield* auth.get(providerID)
      return stored
    }).pipe(Effect.timeoutOption(CALLBACK_TIMEOUT_MS), Effect.exit),
  ).pipe(Effect.ensuring(Effect.sync(() => inflight.delete(providerID))))

  if (Exit.isFailure(exit)) return { ok: false, message: failureMessage(exit.cause) } satisfies CallbackResult
  if (Option.isNone(exit.value)) {
    return {
      ok: false,
      message: `${providerID} sign-in timed out — no callback arrived within ${CALLBACK_TIMEOUT_MS / 60000} minutes. Start it again.`,
    } satisfies CallbackResult
  }
  const stored = exit.value.value
  if (!stored) {
    // The flow reported success but nothing landed in the credential store —
    // reporting "connected" here would light a pill for a provider that cannot
    // make a single call.
    return { ok: false, message: `${providerID} reported success but stored no credential.` } satisfies CallbackResult
  }
  return { ok: true, credential: credentialOf(stored) } satisfies CallbackResult
})

/**
 * A failure OR a defect, as one sentence. Both channels are live here: a
 * `ProviderAuth` error is a typed failure, while a plugin's own `fetch` throwing
 * (xAI answering 403 to a device-code request, a token exchange rejecting)
 * arrives as a defect through `Effect.promise`. Squashing keeps the provider's
 * own wording — which is the only wording that tells a user what to do.
 */
function failureMessage(cause: Cause.Cause<unknown>): string {
  return errorMessage(Cause.squash(cause))
}

export * as ACPProviderAuth from "./provider-auth"
