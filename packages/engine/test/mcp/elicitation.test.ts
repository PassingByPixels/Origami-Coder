import { describe, expect } from "bun:test"
import { Server, acceptedContent, createMcpHandler, inputRequired } from "@modelcontextprotocol/server"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Fiber } from "effect"
import { MCP } from "../../src/mcp/index"
import { McpElicitation } from "../../src/mcp/elicitation"
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

// One compiled tree so the Question service the MCP elicitation handler resolves
// is the SAME instance this test replies through — `LayerNode.compile` shares
// one cache across the whole tree, so the node appears once.
const it = testEffect(LayerNode.compile(LayerNode.group([MCP.node, Question.node])))

const SESSION = SessionID.make("ses_mrtr")

/**
 * A 2026-07-28 server whose `deploy` tool cannot answer until the human
 * confirms. On this revision that is NOT a server->client request: the tool
 * returns `resultType: "input_required"` with the elicitation embedded, and the
 * client is expected to fulfil it and retry the same call. Built with the SDK's
 * own `inputRequired` builder so the wire shape is the spec's, not this test's
 * idea of it.
 */
const mrtrServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const rounds: string[] = []
    const handler = createMcpHandler(() => {
      const protocol = new Server({ name: "mrtr", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler("tools/list", () =>
        Promise.resolve({
          tools: [
            {
              name: "deploy",
              description: "Deploy, once a human says so",
              inputSchema: { type: "object" as const, properties: { env: { type: "string" } }, required: ["env"] },
            },
          ],
        }),
      )
      protocol.setRequestHandler("tools/call", (request, ctx) => {
        const env = String(request.params.arguments?.env ?? "unknown")
        const answered = acceptedContent<{ confirm: boolean }>(ctx.mcpReq?.inputResponses, "confirm")
        rounds.push(answered === undefined ? "asked" : `answered:${answered.confirm}`)
        if (answered === undefined) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Deploy to ${env}?`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    confirm: { type: "boolean", title: "Confirm", description: "Really deploy?" },
                  },
                  required: ["confirm"],
                },
              }),
            },
          })
        }
        return {
          content: [{ type: "text" as const, text: answered.confirm ? `deployed to ${env}` : `skipped ${env}` }],
        }
      })
      return protocol
    })
    const http = Bun.serve({ port: 0, fetch: (request) => handler.fetch(request) })
    return {
      rounds,
      url: http.url.toString(),
      close: async () => {
        await http.stop(true)
        await handler.close()
      },
    }
  }),
  (server) => Effect.promise(server.close),
)

/** Call `deploy` the way a tool call does: with the asking session established. */
const callDeploy = (client: { callTool: (params: { name: string; arguments: Record<string, unknown> }) => unknown }) =>
  Effect.promise(
    () =>
      McpElicitation.withCaller({ sessionID: SESSION }, () =>
        client.callTool({ name: "deploy", arguments: { env: "prod" } }),
      ) as Promise<{ content: { type: string; text?: string }[] }>,
  )

const pendingQuestion = (question: Question.Interface) =>
  pollWithTimeout(
    question.list().pipe(Effect.map((requests) => requests[0])),
    "no elicitation reached the question service",
  )

describe("mcp MRTR elicitation", () => {
  it.instance("an input_required round trip is answered through the question tool and the call completes", () =>
    Effect.gen(function* () {
      const server = yield* mrtrServer
      const mcp = yield* MCP.Service
      const question = yield* Question.Service
      yield* mcp.add("mrtr", { type: "remote", url: server.url })
      const client = (yield* mcp.clients())["mrtr"]!

      const call = yield* Effect.forkScoped(callDeploy(client), { startImmediately: true })

      const asked = yield* pendingQuestion(question)
      // The server's message leads, the field's own description follows: the
      // human sees what is being asked and why, in one prompt.
      expect(asked.questions[0]?.question).toContain("Deploy to prod?")
      expect(asked.questions[0]?.question).toContain("Really deploy?")
      expect(asked.questions[0]?.header).toBe("Confirm")
      // A boolean field is a choice, so it must not offer free text.
      expect(asked.questions[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"])
      expect(asked.questions[0]?.custom).toBe(false)
      expect(asked.sessionID).toBe(SESSION)

      yield* question.reply({ requestID: asked.id, answers: [["Yes"]] })

      const result = yield* Fiber.join(call)
      expect(result.content[0]?.text).toBe("deployed to prod")
      // Two rounds on ONE call: the SDK auto-fulfilled and retried; `callTool`
      // never surfaced the intermediate result to us.
      expect(server.rounds).toEqual(["asked", "answered:true"])
    }),
  )

  it.instance(
    "dismissing the prompt cancels the elicitation rather than answering it",
    () =>
      Effect.gen(function* () {
        const server = yield* mrtrServer
        const mcp = yield* MCP.Service
        const question = yield* Question.Service
        yield* mcp.add("mrtr-cancel", { type: "remote", url: server.url })
        const client = (yield* mcp.clients())["mrtr-cancel"]!

        const call = yield* Effect.forkScoped(callDeploy(client).pipe(Effect.exit), { startImmediately: true })

        const asked = yield* pendingQuestion(question)
        yield* question.reject(asked.id)

        yield* Fiber.join(call)
        // The call terminates, the server never reached the deploy branch, and —
        // the point of the dismissal latch — the human was asked exactly once even
        // though this server re-asks on every retry round.
        expect(server.rounds.every((round) => round === "asked")).toBe(true)
        expect(yield* question.list()).toEqual([])
      }),
    // Tight on purpose. Without the dismissal latch this call does not finish at
    // all: round two raises a second question nobody is left to answer, and the
    // test hangs rather than failing on an assertion.
    15_000,
  )

  it.instance("an elicitation with no asking session is declined instead of hanging", () =>
    Effect.gen(function* () {
      const server = yield* mrtrServer
      const mcp = yield* MCP.Service
      const question = yield* Question.Service
      yield* mcp.add("mrtr-orphan", { type: "remote", url: server.url })
      const client = (yield* mcp.clients())["mrtr-orphan"]!

      // No withCaller: this is what a server-driven elicitation outside a tool
      // call looks like. It must resolve, not block on a question nobody sees.
      yield* Effect.promise(() => client.callTool({ name: "deploy", arguments: { env: "prod" } })).pipe(Effect.exit)

      expect(yield* question.list()).toEqual([])
      // The decline is a real answer, so this server — which asks again for any
      // non-acceptance — is retried until the SDK's `maxRounds` (default 10)
      // stops it. Bounded and terminating is the requirement; one round is not,
      // because how a server reacts to a decline is the server's choice.
      expect(server.rounds.every((round) => round === "asked")).toBe(true)
      expect(server.rounds.length).toBeLessThanOrEqual(11)
    }),
  )
})
