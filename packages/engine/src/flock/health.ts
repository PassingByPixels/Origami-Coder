import { SessionV1 } from "@origami/core/v1/session"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import type { SessionRetry } from "@/session/retry"
import { Effect } from "effect"
import type { Binding, FlockRouting } from "./routing"

/**
 * HTTP statuses that describe the BINDING rather than the request. 401/403 (this
 * endpoint will not have us), 404 (this endpoint does not serve that model), 408
 * (it did not answer in time), 429 (it is saturated). 5xx is handled separately
 * below.
 *
 * Deliberately absent: 400 and 422. A malformed request fails identically
 * everywhere, so walking it only spends the rest of the chain reproducing the
 * same failure and buries the real cause behind the last binding's message.
 */
const HEALTH_STATUS = new Set([401, 403, 404, 408, 429])

/**
 * Whether a failure is binding sickness — the one thing another binding could
 * survive. Classified against the shapes `MessageV2.fromError` actually
 * produces, which is the single funnel every provider and transport failure in
 * this engine passes through.
 */
export function isHealthClass(error: SessionRetry.Err): boolean {
  // No usable credential for this provider. Detected before the request left,
  // but it is the same fact a 401 reports: this binding cannot be talked to.
  if (SessionV1.AuthError.isInstance(error)) return true
  // Everything else that can be sickness arrives as APIError. Aborts, output
  // length, context overflow, content filter, structured-output and unknown
  // errors are all facts about the REQUEST or the user's intent, and answer
  // false by falling through.
  if (!SessionV1.APIError.isInstance(error)) return false
  const status = error.data.statusCode
  if (status === undefined) {
    // Nothing came back with a status: connection refused, DNS failure, socket
    // or header timeout, a reset or a truncated stream. The AI SDK marks its
    // own connect failures retryable ("Cannot connect to API"), and so do the
    // engine's transport wrappers (ECONNRESET, ZlibError, header timeout,
    // response-stream). A statusless error that is NOT retryable is a refusal
    // the provider reasoned about — quota exhausted, invalid prompt — and walks
    // nowhere.
    return error.data.isRetryable
  }
  return HEALTH_STATUS.has(status) || status >= 500
}

/**
 * Whether these parts are assistant output a second attempt would duplicate.
 * A tool part counts even when it produced no text: the side effect already
 * happened.
 */
export function produced(parts: readonly SessionV1.Part[]): boolean {
  return parts.some(
    (part) =>
      part.type === "tool" ||
      (part.type === "text" && part.text.trim() !== "") ||
      (part.type === "reasoning" && part.text.trim() !== ""),
  )
}

export interface Failure<A> {
  readonly error: SessionRetry.Err
  /** Whether the attempt had already written output when it failed. */
  readonly produced: boolean
  /**
   * What the failing attempt left behind, for callers that must carry on with
   * it — a subagent turn or a compaction still has a real message to finish
   * off. Absent when the attempt failed with nothing to hand back at all.
   */
  readonly value?: A
}

export type Trial<A> = { readonly ok: true; readonly value: A } | ({ readonly ok: false } & Failure<A>)

export function ok<A>(value: A): Trial<A> {
  return { ok: true, value }
}

export function failed<A>(error: SessionRetry.Err, hadOutput: boolean, value?: A): Trial<A> {
  return { ok: false, error, produced: hadOutput, value }
}

export type Outcome<A> =
  /** A candidate answered. */
  | { readonly kind: "ok"; readonly binding: Binding; readonly index: number; readonly value: A }
  /** A candidate ran and its failure is final — surface it, do not walk further. */
  | { readonly kind: "failed"; readonly binding: Binding; readonly index: number; readonly failure: Failure<A> }
  /** No candidate was usable at all: nothing ran, nothing was spent (D10). */
  | { readonly kind: "exhausted" }

/**
 * Walk the subagent binding's ordered candidate chain, at most once per
 * candidate.
 *
 * Two failure layers, one loop. A candidate the provider registry does not have
 * is skipped without spending anything. A candidate that runs and fails is
 * walked past only when the failure is binding sickness AND the attempt wrote
 * no output — re-running a turn that already produced output would duplicate
 * the output and the bill, which is worse than a visible failure.
 *
 * There is no circuit breaker and no cooldown memory: a chain is walked afresh
 * on every request, so the bound on attempts is the chain length. Remembering
 * which bindings were sick last time is future work, not v1.
 */
export const walk = <A, E, R>(input: {
  candidates: readonly Binding[]
  provider: Provider.Interface
  attempt: (model: Provider.Model, binding: Binding) => Effect.Effect<Trial<A>, E, R>
}): Effect.Effect<Outcome<A>, E, R> =>
  Effect.gen(function* () {
    let last: { binding: Binding; index: number; failure: Failure<A> } | undefined
    for (const [index, binding] of input.candidates.entries()) {
      const reference = `${binding.providerID}/${binding.modelID}`
      const model = yield* input.provider
        .getModel(binding.providerID, binding.modelID)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!model) {
        yield* Effect.logWarning("flock binding is unavailable, skipping it", { binding: reference })
        continue
      }

      const trial = yield* input.attempt(model, binding)
      if (trial.ok) return { kind: "ok", binding, index, value: trial.value }

      const failure: Failure<A> = { error: trial.error, produced: trial.produced, value: trial.value }
      last = { binding, index, failure }
      if (trial.produced) {
        yield* Effect.logWarning("flock binding failed after it had already produced output, not walking", {
          binding: reference,
          error: trial.error.name,
        })
        return { kind: "failed", binding, index, failure }
      }
      if (!isHealthClass(trial.error)) {
        return { kind: "failed", binding, index, failure }
      }
      yield* Effect.logWarning("flock binding is unhealthy, walking to the next candidate", {
        binding: reference,
        error: trial.error.name,
      })
    }
    // Every candidate that ran was unhealthy and there is nothing left to walk
    // to, so the last sickness IS the answer — a chain of dead endpoints is a
    // real failure, not an absence of routing.
    if (last) return { kind: "failed", ...last }
    return { kind: "exhausted" }
  })

/**
 * Run a one-shot generation on the subagent chain — the engine's cheap
 * background work (titles, summarisation, project-copy names) rides the same
 * binding, because it is the same answer to the same question: which model does
 * this user want the work they are not watching to run on. Answers `undefined`
 * when Flock is off, when the profile binds no subagent model, or when the chain
 * could not produce a result — the caller then runs its own resolution, which is
 * today's code and today's behaviour byte for byte.
 *
 * A one-shot generation writes nothing into the session until it has finished,
 * so a failed attempt has no output to duplicate and the chain walks on any
 * sickness. A failure the chain cannot survive still hands the caller back to
 * its own model: that model is what would have run with Flock off, and it is
 * the only thing standing between the user and no title at all.
 */
export const oneShot = <A, E, R>(input: {
  flock: FlockRouting.Interface
  provider: Provider.Interface
  generate: (model: Provider.Model) => Effect.Effect<A, E, R>
}): Effect.Effect<A | undefined, never, R> =>
  Effect.gen(function* () {
    const candidates = yield* input.flock.resolveSubagents()
    if (!candidates?.length) return undefined
    const outcome = yield* walk({
      candidates,
      provider: input.provider,
      attempt: (model) =>
        input.generate(model).pipe(
          Effect.map((value): Trial<A> => ok(value)),
          // Defects are deliberately NOT caught: a broken generation is a bug
          // here just as it is with Flock off, and no binding survives it.
          Effect.catch((error) =>
            Effect.succeed(failed<A>(MessageV2.fromError(error, { providerID: model.providerID }), false)),
          ),
        ),
    })
    if (outcome.kind === "ok") return outcome.value
    if (outcome.kind === "failed") {
      yield* Effect.logWarning("flock subagent chain produced nothing, using the caller's own model", {
        binding: `${outcome.binding.providerID}/${outcome.binding.modelID}`,
        error: outcome.failure.error.name,
      })
    }
    return undefined
  })

export * as FlockHealth from "./health"
