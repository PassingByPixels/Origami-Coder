export * as ElasticWarm from "./warm"

import { Cause, Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { SystemPrompt } from "@/session/system"

/**
 * t-woacbl: THE FIRST PROMPT OF AN ENGINE PROCESS builds per-folder state that
 * every later prompt reuses:
 *  - the provider catalog (`Provider` state, 350-450 ms, most of it one
 *    uninterrupted block of the main thread, soak_elastic.md section 8);
 *  - the folder's location services behind the system prompt's environment
 *    block (project and git discovery, the plugin boot: 600+ ms, with git
 *    processes started on the main thread).
 * A new chat, an adopted warm spare and a restored engine all paid this on the
 * user's first message. `afterSession` builds the same state right after a
 * session call (new, load, resume, fork) has answered, in the background. The
 * first message then finds it built, or joins the build in flight (both caches
 * share one lookup between callers), and never builds it twice.
 *
 * Nothing here is sent anywhere, and nothing is read that the first prompt would
 * not read itself from the same folder instance: request bytes cannot change.
 * The spare stays inert until adoption: its first session call is what starts this.
 *
 * origami_change (t-xnvp72): the two builds run AT THE SAME TIME (they were one
 * after the other: a slow provider discovery, 3 s on the owner's remote vLLM,
 * held the environment block back too), and a new chat starts them when its
 * session call starts (`atOpen`), not after it answered. The log line's
 * `providerMs` / `environmentMs` are each part's end, from the warm's start;
 * `totalMs` is the whole warm.
 */

/** Off switch, for a before/after measurement only: `ORIGAMI_FIRST_TURN_WARM=0`. */
export const ENV = "ORIGAMI_FIRST_TURN_WARM"

/**
 * The environment block names the model in one line; the warm throws the text
 * away, and only `providerID` and `api.id` are read to write it. What is built
 * and kept is the folder state behind the text (project and git discovery, the
 * location services), which does not depend on the model. So the environment
 * part need not wait for the provider state to say which model it is.
 */
const TEXT_ONLY_MODEL = { providerID: "warm", api: { id: "warm" } } as unknown as Provider.Model

/** Build the state of `directory` that the first prompt needs. Never fails. */
export const warm = (directory: string) =>
  Effect.gen(function* () {
    const started = performance.now()
    const since = () => Math.round(performance.now() - started)
    const ctx = yield* InstanceStore.Service.use((store) => store.load({ directory }))
    yield* Effect.gen(function* () {
      const provider = yield* Provider.Service
      const system = yield* SystemPrompt.Service
      const [providerMs, environmentMs] = yield* Effect.all(
        [
          Effect.gen(function* () {
            const chosen = yield* provider.defaultModel()
            yield* provider.getModel(chosen.providerID, chosen.modelID)
            return since()
          }),
          system.environment(TEXT_ONLY_MODEL).pipe(Effect.map(since)),
        ],
        { concurrency: "unbounded" },
      )
      yield* Effect.logInfo("first-turn warm", { directory, providerMs, environmentMs, totalMs: since() })
    }).pipe(Effect.provideService(InstanceRef, ctx))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logInfo("first-turn warm skipped", { directory, reason: Cause.pretty(cause).split("\n")[0] }),
    ),
    Effect.withSpan("ElasticWarm.warm"),
  )

/** After a session call answered: warm its folder on the next turn of the event loop. */
export function afterSession(directory: string | undefined): void {
  if (!directory || process.env[ENV] === "0") return
  setTimeout(() => {
    AppRuntime.runPromise(warm(directory)).catch(() => undefined)
  }, 0)
}

/** t-xnvp72: a new chat's session call is starting: warm its folder now, beside it. The
 *  warm loads the same folder instance the call boots (one boot, shared), and the
 *  first message joins whatever is still being built. */
export function atOpen(directory: string | undefined): void {
  afterSession(directory)
}
