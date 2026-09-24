import { Cause, Effect, Exit, Stream } from "effect"
import { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { SecondOpinion } from "@/session/second-opinion"
import { Session } from "@/session/session"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import { LLMEvent } from "@origami/llm"
import { errorMessage } from "@/util/error"

/**
 * "Second opinion", over ACP: hand the LAST COMPLETED TURN of a chat to a DIFFERENT
 * model, chosen by the user, and answer with what it says.
 *
 * The model is the USER'S EXPLICIT CHOICE, so it is resolved with a plain
 * `provider.getModel(providerID, modelID)` and NOT routed through
 * `FlockHealth.oneShot` the way `ensureTitle` is - routing it elsewhere would
 * silently answer with a second opinion from a third model.
 *
 * REVIEW-ONLY IS ENFORCED, NOT ASKED FOR: `tools: {}` hands the reviewer no tool
 * schema at all, where a prompt-level instruction alone would be a request. The
 * digest itself is session/second-opinion.ts; this file is the wiring.
 */

/** The synthetic agent the one-shot runs as. Same shape project-copy.ts's
 *  COPY_NAME_AGENT uses: a native agent with no prompt of its own. */
const REVIEWER: Agent.Info = {
  name: "second-opinion",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

/**
 * Fraction of the reviewing model's context window the digest may occupy. The rest
 * pays for the model's own reply, its system prompt and the wire; a review is a
 * LONG answer by design, so the reserve is generous.
 */
const DIGEST_WINDOW_SHARE = 0.6

/** Characters per token used to turn that share into the digest's character budget.
 *  BELOW the engine's own `Token.estimate` constant of 4 on purpose: a digest is
 *  diff-heavy and diffs tokenise worse than prose, so 3 errs toward a smaller brief. */
const CHARS_PER_TOKEN = 3

export type SecondOpinionResult =
  | { readonly ok: true; readonly text: string; readonly trimmed: readonly string[] }
  | { readonly ok: false; readonly message: string }

/** Runs against the process-wide AppRuntime, which provides Session, Provider and
 *  LLM. `InstanceRef` is loaded exactly as acp/provider-auth.ts does it - the
 *  session store, provider list and model catalogue are all per-instance. */
const withInstance = <A, E, R>(directory: string, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const ctx = yield* store.load({ directory })
    return yield* body.pipe(Effect.provideService(InstanceRef, ctx))
  })

export const review = Effect.fn("ACPSecondOpinion.review")(function* (input: {
  directory: string
  sessionId: string
  providerID: string
  modelID: string
  /** How the CHAT names the model that did the work. Display text only — it
   *  goes into the preamble so the reviewer knows whose work it is judging. */
  currentModelLabel: string
}) {
  const exit = yield* withInstance(
    input.directory,
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const provider = yield* Provider.Service
      const llm = yield* LLM.Service

      const model = yield* provider.getModel(
        ProviderV2.ID.make(input.providerID),
        ModelV2.ID.make(input.modelID),
      )
      const history = yield* sessions.messages({ sessionID: SessionID.make(input.sessionId) })
      const budget =
        model.limit.context > 0 ? Math.floor(model.limit.context * DIGEST_WINDOW_SHARE) * CHARS_PER_TOKEN : 0
      const digest = SecondOpinion.buildDigest({
        history,
        currentModelLabel: input.currentModelLabel,
        budget,
      })
      // NOT an error and NOT an empty review: a reviewer handed nothing answers
      // anyway, and that answer would read as a verdict on the session.
      if (!digest) return { found: false as const }

      const sessionID = SessionID.descending()
      const text = yield* llm
        .stream({
          agent: REVIEWER,
          user: {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: REVIEWER.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          // `small: false`: the user picked THIS model, and the small-model
          // substitution exists to spend less on work nobody reads.
          small: false,
          tools: {},
          model,
          sessionID,
          retries: 2,
          messages: [{ role: "user", content: digest.prompt }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
        )
      return { found: true as const, text, trimmed: digest.trimmed }
    }).pipe(Effect.exit),
  )

  if (Exit.isFailure(exit)) {
    return { ok: false, message: errorMessage(Cause.squash(exit.cause)) } satisfies SecondOpinionResult
  }
  if (!exit.value.found) {
    return {
      ok: false,
      message: "This chat has no completed turn to review yet — send a message and let it finish first.",
    } satisfies SecondOpinionResult
  }
  // Reasoning models leak <think> blocks through providers that do not split them
  // out; the same belt session/prompt.ts's title cleanup carries.
  const cleaned = exit.value.text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .replace(/<\/?think>\s*/g, "")
    .trim()
  if (!cleaned) {
    return {
      ok: false,
      message: `${input.providerID}/${input.modelID} answered with nothing. It may not be reachable, or the digest may not fit its context window.`,
    } satisfies SecondOpinionResult
  }
  return { ok: true, text: cleaned, trimmed: exit.value.trimmed } satisfies SecondOpinionResult
})

export * as ACPSecondOpinion from "./second-opinion"
