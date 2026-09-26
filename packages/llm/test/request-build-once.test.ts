import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CacheHint, GenerationOptions, LLM, LLMRequest, Message, ToolCallPart, ToolDefinition, ToolResultPart } from "../src"
import { AnthropicMessages, OpenAIChat } from "../src/protocols"
import { Auth, LLMClient } from "../src/route"
import type { AnyRoute } from "../src/route/client"
import { it } from "./lib/effect"

// t-w2r1kf: compiling a request (route defaults merge, then the cache policy)
// must not parse the message window again. Each extra parse made a new Message
// instance for every message: 20-30 ms per step in a big chat. The request the
// transport receives must hold the caller's own Message instances.

const history = () => [
  Message.user("first question"),
  Message.assistant([
    { type: "text", text: "calling a tool" },
    ToolCallPart.make({ id: "call_1", name: "read", input: { path: "a.txt" } }),
  ]),
  Message.tool(ToolResultPart.make({ id: "call_1", name: "read", result: "file body" })),
  Message.assistant("done reading"),
  Message.user("latest question"),
]

const tool = new ToolDefinition({
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
})

// Wrap the route's transport so the test sees the request `compile` hands on.
const capturing = (route: AnyRoute) => {
  const seen: LLMRequest[] = []
  const wrapped = route.with({
    transport: {
      ...route.transport,
      prepare: (input) => {
        seen.push(input.request)
        return route.transport.prepare(input)
      },
    },
  })
  return { route: wrapped, seen }
}

describe("request is built once per step", () => {
  it.effect("OpenAI Chat with route and model defaults keeps the caller's messages and tools", () =>
    Effect.gen(function* () {
      const { route, seen } = capturing(
        OpenAIChat.route.with({
          endpoint: { baseURL: "https://api.openai.test/v1/" },
          auth: Auth.bearer("test"),
          generation: { maxTokens: 10 },
          providerOptions: { openai: { store: false } },
        }),
      )
      const request = LLM.request({
        model: route.model({ id: "gpt-4o-mini", defaults: { generation: { temperature: 0.5 } } }),
        messages: history(),
        tools: [tool],
        generation: { topP: 0.9 },
      })

      yield* LLMClient.prepare(request)

      expect(seen).toHaveLength(1)
      const resolved = seen[0]!
      // The option merge did happen (the patched fields are new)...
      expect(resolved.generation).toMatchObject({ maxTokens: 10, temperature: 0.5, topP: 0.9 })
      // ...but the window was not parsed again.
      expect(resolved.messages).toHaveLength(request.messages.length)
      resolved.messages.forEach((message, i) => expect(message).toBe(request.messages[i]!))
      resolved.tools.forEach((definition, i) => expect(definition).toBe(request.tools[i]!))
    }),
  )

  it.effect("Anthropic cache policy rebuilds only the message it marks", () =>
    Effect.gen(function* () {
      const { route, seen } = capturing(
        AnthropicMessages.route.with({
          endpoint: { baseURL: "https://api.anthropic.test/v1/" },
          auth: Auth.header("x-api-key", "test"),
        }),
      )
      const request = LLM.request({
        model: route.model({ id: "claude-sonnet-4-5" }),
        system: "You are concise.",
        messages: history(),
        tools: [tool],
      })

      const prepared = yield* LLMClient.prepare(request)

      const resolved = seen[0]!
      const latestUser = request.messages.length - 1
      resolved.messages.forEach((message, i) => {
        if (i === latestUser) return
        expect(message).toBe(request.messages[i]!)
      })
      // The marked message is new and carries the cache hint on the wire.
      expect(resolved.messages[latestUser]).not.toBe(request.messages[latestUser]!)
      expect(resolved.messages[latestUser]).toBeInstanceOf(Message)
      expect(prepared.body).toMatchObject({
        messages: expect.arrayContaining([
          { role: "user", content: [{ type: "text", text: "latest question", cache_control: { type: "ephemeral" } }] },
        ]),
        tools: [{ name: "read", cache_control: { type: "ephemeral" } }],
        system: [{ type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } }],
      })
    }),
  )
})

describe("LLMRequest.update", () => {
  // The fast path must give the same request as a full construction from the
  // merged input, for every field kind, patched or not.
  const base = () =>
    LLM.request({
      model: OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "gpt-4o-mini" }),
      system: "System A",
      messages: history(),
      tools: [tool],
      toolChoice: "auto",
      generation: { maxTokens: 5 },
    })

  const full = (request: LLMRequest, patch: Partial<LLMRequest.Input>) =>
    new LLMRequest({ ...LLMRequest.input(request), ...patch, model: patch.model ?? request.model })

  const patches: Record<string, (request: LLMRequest) => Partial<LLMRequest.Input>> = {
    "option fields": () => ({ generation: new GenerationOptions({ temperature: 0.2 }), providerOptions: { openai: { store: true } } }),
    "appended message (plain input)": (request) => ({
      messages: [...request.messages, { role: "user", content: [{ type: "text", text: "next" }] }],
    }),
    "one message replaced": (request) => ({
      messages: request.messages.map((message, i) =>
        i === 0
          ? new Message({
              ...message,
              content: message.content.map((part) => ({ ...part, cache: new CacheHint({ type: "ephemeral" }) })),
            })
          : message,
      ),
    }),
    "system and tools replaced": (request) => ({
      system: [{ ...request.system[0]!, cache: new CacheHint({ type: "ephemeral" }) }],
      tools: [new ToolDefinition({ ...request.tools[0]!, cache: new CacheHint({ type: "ephemeral" }) })],
    }),
  }

  for (const [name, patchOf] of Object.entries(patches)) {
    test(`equals a full construction: ${name}`, () => {
      const request = base()
      const patch = patchOf(request)
      const fast = LLMRequest.update(request, patch)
      const reference = full(request, patch)
      expect(fast).toBeInstanceOf(LLMRequest)
      expect(Object.keys(fast)).toEqual(Object.keys(reference))
      expect(JSON.stringify(fast)).toBe(JSON.stringify(reference))
      expect(fast).toEqual(reference)
      fast.messages.forEach((message) => expect(message).toBeInstanceOf(Message))
      fast.tools.forEach((definition) => expect(definition).toBeInstanceOf(ToolDefinition))
    })
  }

  test("still rejects an invalid patched value", () => {
    const request = base()
    expect(() =>
      LLMRequest.update(request, { messages: [...request.messages, { role: "nope" } as never] }),
    ).toThrow()
  })
})
