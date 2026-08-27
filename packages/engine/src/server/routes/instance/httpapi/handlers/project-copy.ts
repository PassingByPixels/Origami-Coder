import { Agent } from "@/agent/agent"
import { FlockHealth } from "@/flock/health"
import { FlockRouting } from "@/flock/routing"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Slug } from "@origami/core/util/slug"
import { LLMEvent } from "@origami/llm"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

const COPY_NAME_AGENT: Agent.Info = {
  name: "project-copy-name",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: "",
}

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service
    const flock = yield* FlockRouting.Service

    const generateName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()

      const generate = Effect.fnUntraced(function* (model: Provider.Model) {
        const sessionID = SessionID.descending()
        return yield* llm
          .stream({
            agent: COPY_NAME_AGENT,
            user: {
              id: MessageID.ascending(),
              sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: COPY_NAME_AGENT.name,
              model: { providerID: model.providerID, modelID: model.id },
            },
            system: [],
            small: true,
            tools: {},
            model,
            sessionID,
            retries: 2,
            messages: [{ role: "user", content: `Generate a short 2-3 word name that describes this task:\n${text}` }],
          })
          .pipe(
            Stream.filter(LLMEvent.is.textDelta),
            Stream.map((event) => event.text),
            Stream.mkString,
          )
      })

      // Project-copy naming is one of the subagent binding's hidden consumers.
      // With the binding unset, or Flock off, the chain is empty and the block
      // below runs unchanged, `small_model` and all.
      const routed = yield* FlockHealth.oneShot({ flock, provider, generate })
      const result =
        routed ??
        (yield* Effect.gen(function* () {
          const fallback = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!fallback) return undefined
          const model =
            (yield* provider.getSmallModel(fallback.providerID)) ??
            (yield* provider.getModel(fallback.providerID, fallback.modelID))
          return yield* generate(model)
        }))
      if (result === undefined) return Slug.create()
      const output = result.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
    })

    return handlers.handle("generateName", (ctx) =>
      generateName(ctx.payload.context).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project copy name generation failed", {
            projectID: ctx.params.projectID,
            cause,
          }).pipe(Effect.as(Slug.create())),
        ),
        Effect.map((name) => ({ name })),
      ),
    )
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
