import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@origami/core/model"
import { ProviderV2 } from "@origami/core/provider"
import type { Model } from "../../src/provider/provider"
import {
  discoverOpenAICompatContext,
  fetchOpenAICompatContext,
  mapOpenAICompatContext,
} from "../../src/origami/openai-compat-context"

function makeModel(id: string, context: number): Model {
  return {
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make("spark1"),
    name: id,
    family: "",
    api: { id, url: "http://127.0.0.1:8000/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output: 0 },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

// The exact body observed live from `curl -s http://127.0.0.1:8000/v1/models` on the vLLM host
// on 2026-09-14 (t-d94t8t), field names and shape byte-for-byte, permission/id
// noise trimmed to what this module reads.
const VLLM_BODY = {
  object: "list",
  data: [
    {
      id: "Qwen/Qwen3.8-Flash-Next",
      object: "model",
      created: 1789406292,
      owned_by: "vllm",
      root: "/models/Qwen3.8-Flash-Next-hibrid48",
      parent: null,
      max_model_len: 262144,
    },
  ],
}

describe("mapOpenAICompatContext", () => {
  test("reads vLLM's max_model_len", () => {
    expect(mapOpenAICompatContext(VLLM_BODY)).toEqual({ "Qwen/Qwen3.8-Flash-Next": 262144 })
  })

  test("falls back to context_length (OpenRouter-style aggregators)", () => {
    const body = { data: [{ id: "some/model", context_length: 131072 }] }
    expect(mapOpenAICompatContext(body)).toEqual({ "some/model": 131072 })
  })

  test("falls back to max_context_length", () => {
    const body = { data: [{ id: "some/model", max_context_length: 32768 }] }
    expect(mapOpenAICompatContext(body)).toEqual({ "some/model": 32768 })
  })

  test("max_model_len wins over context_length when a server sends both", () => {
    const body = { data: [{ id: "m", max_model_len: 262144, context_length: 4096 }] }
    expect(mapOpenAICompatContext(body)).toEqual({ m: 262144 })
  })

  test("accepts a bare array with no data wrapper", () => {
    expect(mapOpenAICompatContext([{ id: "m", max_model_len: 8192 }])).toEqual({ m: 8192 })
  })

  test("a zero or negative window is dropped, not passed through", () => {
    expect(mapOpenAICompatContext({ data: [{ id: "m", max_model_len: 0 }] })).toEqual({})
    expect(mapOpenAICompatContext({ data: [{ id: "m", max_model_len: -1 }] })).toEqual({})
  })

  test("a row with no usable id is skipped, not crashed on", () => {
    expect(mapOpenAICompatContext({ data: [{ max_model_len: 8192 }] })).toEqual({})
  })

  test("a malformed payload answers empty, never throws", () => {
    expect(mapOpenAICompatContext(null)).toEqual({})
    expect(mapOpenAICompatContext("not json")).toEqual({})
    expect(mapOpenAICompatContext({ data: "not an array" })).toEqual({})
  })
})

describe("fetchOpenAICompatContext", () => {
  test("normalizes a /v1-suffixed baseURL and GETs /v1/models", async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(VLLM_BODY), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchOpenAICompatContext("http://127.0.0.1:8000/v1", fetchImpl)
    expect(calls).toEqual(["http://127.0.0.1:8000/v1/models"])
    expect(result).toEqual({ "Qwen/Qwen3.8-Flash-Next": 262144 })
  })

  test("a non-200 answers empty, not a throw", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    expect(await fetchOpenAICompatContext("http://127.0.0.1:8000", fetchImpl)).toEqual({})
  })

  test("an unreachable server (fetch rejects) answers empty, not a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await fetchOpenAICompatContext("http://127.0.0.1:8000", fetchImpl)).toEqual({})
  })
})

describe("discoverOpenAICompatContext", () => {
  test("backfills only the declared, still-zero model — proves the ticket's acceptance case", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(VLLM_BODY), { status: 200 })) as unknown as typeof fetch
    const models: Record<string, Model> = { "Qwen/Qwen3.8-Flash-Next": makeModel("Qwen/Qwen3.8-Flash-Next", 0) }
    const result = await discoverOpenAICompatContext(
      "http://127.0.0.1:8000/v1",
      models,
      ["Qwen/Qwen3.8-Flash-Next"],
      fetchImpl,
    )
    expect(result["Qwen/Qwen3.8-Flash-Next"]?.limit.context).toBe(262144)
  })

  test("never introduces a model the config did not name, even if the server serves it", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(VLLM_BODY), { status: 200 })) as unknown as typeof fetch
    // targetModelIDs deliberately omits the id the server reports.
    const result = await discoverOpenAICompatContext("http://127.0.0.1:8000/v1", {}, [], fetchImpl)
    expect(result).toEqual({})
  })

  test("a target with no matching server row is left out, not zeroed", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(VLLM_BODY), { status: 200 })) as unknown as typeof fetch
    const models: Record<string, Model> = { "other/model": makeModel("other/model", 0) }
    const result = await discoverOpenAICompatContext("http://127.0.0.1:8000/v1", models, ["other/model"], fetchImpl)
    expect(result).toEqual({})
  })
})
