import { HttpRecorderInternal } from "@origami/http-recorder/internal"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LLMParityServer } from "./server"

// The parity test replays one cassette twice — once per runtime — so the
// cursor rewind and the per-run request capture are load-bearing. Phase 0
// never reaches the second run (native reports unsupported), so prove the
// contract here instead of assuming it.
const CASSETTE = "openai-compatible/vllm-tool-loop"
const REAL_BASE_URL = "http://192.0.2.10:8000/v1"

const present = HttpRecorderInternal.hasCassetteSync(CASSETTE, { directory: LLMParityServer.CASSETTE_DIR })
const it = present ? test : test.skip

describe("llm parity replay server", () => {
  it("serves the cassette in order, then rewinds for the next run", async () => {
    const server = await LLMParityServer.start({ mode: "replay", cassette: CASSETTE, realBaseURL: REAL_BASE_URL })
    try {
      expect(server.recorded).toHaveLength(2)

      const send = (body: string) =>
        fetch(`${server.baseURL}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }).then((response) => response.text())

      // Two requests, two different recorded responses — served in cassette order.
      const first = await send('{"run":"a","turn":1}')
      const second = await send('{"run":"a","turn":2}')
      expect(first).not.toBe(second)

      const runA = server.requests()
      expect(runA.map((request) => request.body)).toEqual(['{"run":"a","turn":1}', '{"run":"a","turn":2}'])
      expect(runA.map((request) => request.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"])

      // Second run: same cassette from the top, and the capture buffer is empty.
      const replayed = await send('{"run":"b","turn":1}')
      expect(replayed).toBe(first)

      const runB = server.requests()
      expect(runB.map((request) => request.body)).toEqual(['{"run":"b","turn":1}'])
    } finally {
      await server.close()
    }
  })

  it("fails the request when the cassette runs out of interactions", async () => {
    const server = await LLMParityServer.start({ mode: "replay", cassette: CASSETTE, realBaseURL: REAL_BASE_URL })
    try {
      const send = () => fetch(`${server.baseURL}/chat/completions`, { method: "POST", body: "{}" })
      await send()
      await send()
      const overrun = await send()

      expect(overrun.status).toBe(500)
      expect(await overrun.text()).toContain("holds 2 interactions; request 3")
    } finally {
      await server.close()
    }
  })

  it("fails the request when the path does not match the recorded interaction", async () => {
    const server = await LLMParityServer.start({ mode: "replay", cassette: CASSETTE, realBaseURL: REAL_BASE_URL })
    try {
      const response = await fetch(`${server.baseURL}/responses`, { method: "POST", body: "{}" })

      expect(response.status).toBe(500)
      expect(await response.text()).toContain("request was POST /v1/responses")
    } finally {
      await server.close()
    }
  })
})

// Record mode is what a hosted provider needs: a credential the plugin put on
// the request has to survive the hop to the real endpoint, and the ChatGPT
// backend needs a body the runtime did not send. Both are exercised against a
// local stub upstream — these tests make no external call.
const SCRATCH_DIR = path.join(LLMParityServer.CASSETTE_DIR, "parity-selftest")

type Received = { readonly headers: Record<string, string>; readonly body: string }

const stubUpstream = (reply = '{"ok":true}', contentType = "application/json") => {
  const received: Received[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push({ headers: Object.fromEntries(request.headers.entries()), body: await request.text() })
      return new Response(reply, { status: 200, headers: { "content-type": contentType } })
    },
  })
  return {
    received,
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close: () => server.stop(true),
  }
}

const readCassette = async (name: string): Promise<Record<string, any>> =>
  JSON.parse(await fs.readFile(path.join(LLMParityServer.CASSETTE_DIR, `${name}.json`), "utf8"))

describe("llm parity record server", () => {
  afterEach(async () => {
    await fs.rm(SCRATCH_DIR, { recursive: true, force: true })
  })

  test("forwards the allowlisted headers upstream and drops the rest", async () => {
    const upstream = stubUpstream()
    const cassette = "parity-selftest/headers"
    const proxy = await LLMParityServer.start({ mode: "record", cassette, realBaseURL: upstream.baseURL })
    try {
      await fetch(`${proxy.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer caller-key",
          "x-api-key": "caller-api-key",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "beta-a",
          "openai-beta": "responses=v1",
          "chatgpt-account-id": "acct-1234",
          "session-id": "sess-1234",
          "user-agent": "origami-parity/1",
          "http-referer": "https://origami.test",
          "x-title": "Origami Parity",
          // Not on the allowlist: a runtime's own noise must not reach the
          // real endpoint, and a cookie must never be forwarded at all.
          "x-runtime-note": "leak-me",
          cookie: "sid=leak-me",
        },
        body: '{"model":"m"}',
      })

      expect(upstream.received).toHaveLength(1)
      const sent = upstream.received[0].headers
      expect(sent["authorization"]).toBe("Bearer caller-key")
      expect(sent["x-api-key"]).toBe("caller-api-key")
      expect(sent["anthropic-version"]).toBe("2023-06-01")
      expect(sent["anthropic-beta"]).toBe("beta-a")
      expect(sent["openai-beta"]).toBe("responses=v1")
      expect(sent["chatgpt-account-id"]).toBe("acct-1234")
      expect(sent["session-id"]).toBe("sess-1234")
      expect(sent["user-agent"]).toBe("origami-parity/1")
      expect(sent["http-referer"]).toBe("https://origami.test")
      expect(sent["x-title"]).toBe("Origami Parity")
      expect(sent["x-runtime-note"]).toBeUndefined()
      expect(sent["cookie"]).toBeUndefined()

      // The cassette shows the header names but never the secrets.
      const recorded = (await readCassette(cassette)).interactions[0].request.headers
      expect(recorded["authorization"]).toBe("[REDACTED]")
      expect(recorded["x-api-key"]).toBe("[REDACTED]")
      expect(recorded["chatgpt-account-id"]).toBe("[REDACTED]")
      expect(recorded["x-title"]).toBe("Origami Parity")
      expect(recorded["x-runtime-note"]).toBeUndefined()
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  // OpenAI and Copilot echo a stable per-account `safety_identifier` in every
  // response event. It names the account, so no committed cassette may hold it:
  // whatever its value, and also when the JSON sits escaped inside a string.
  test("the cassette holds no safety_identifier value, raw or escaped", async () => {
    const accountId = "user-AccountId0123456789"
    const accountHash = "0123456789abcdef0123456789abcdef"
    const sse = [
      `data: {"type":"response.created","response":{"safety_identifier":"${accountId}"}}`,
      `data: {"type":"response.completed","response":{"safety_identifier" : "${accountHash}"}}`,
      `data: {"type":"note","text":${JSON.stringify(JSON.stringify({ safety_identifier: accountHash }))}}`,
      "",
    ].join("\n\n")
    const upstream = stubUpstream(sse, "text/event-stream")
    const cassette = "parity-selftest/safety-identifier"
    const proxy = await LLMParityServer.start({ mode: "record", cassette, realBaseURL: upstream.baseURL })
    try {
      const reply = await fetch(`${proxy.baseURL}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", note: JSON.stringify({ safety_identifier: accountId }) }),
      }).then((response) => response.text())
      // The caller still gets the upstream reply unchanged; only the file is scrubbed.
      expect(reply).toBe(sse)

      const file = await fs.readFile(path.join(LLMParityServer.CASSETTE_DIR, `${cassette}.json`), "utf8")
      expect(file).not.toContain(accountId)
      expect(file).not.toContain(accountHash)
      const interaction = (await readCassette(cassette)).interactions[0]
      expect(interaction.response.body.match(/user_redacted/g)).toHaveLength(3)
      expect(interaction.request.body).toContain("user_redacted")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test("applies forwardBody upstream while the captured request keeps the original", async () => {
    const upstream = stubUpstream()
    const cassette = "parity-selftest/forward-body"
    const original = '{"model":"m","temperature":0,"top_p":1}'
    const proxy = await LLMParityServer.start({
      mode: "record",
      cassette,
      realBaseURL: upstream.baseURL,
      forwardBody: (body) => body.replace('"temperature":0,', ""),
    })
    try {
      await fetch(`${proxy.baseURL}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: original,
      })

      expect(upstream.received[0].body).toBe('{"model":"m","top_p":1}')

      const captured = proxy.requests()
      expect(captured.map((request) => request.body)).toEqual([original])
      // The cassette is the baseline both runtimes are diffed against on
      // replay, and a runtime sends the untransformed body — so it holds the
      // original too, not what went upstream.
      expect((await readCassette(cassette)).interactions[0].request.body).toBe(original)
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  test("options.apiKey overrides an authorization header the caller already set", async () => {
    const upstream = stubUpstream()
    const cassette = "parity-selftest/api-key"
    const proxy = await LLMParityServer.start({
      mode: "record",
      cassette,
      realBaseURL: upstream.baseURL,
      apiKey: "override-key",
    })
    try {
      await fetch(`${proxy.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-key" },
        body: "{}",
      })

      expect(upstream.received[0].headers["authorization"]).toBe("Bearer override-key")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })

  // Anthropic's credential header. A bearer added next to it is a SECOND
  // credential the Messages API reads as an OAuth token, and it refuses the
  // request — so the override stands down and forwards the x-api-key instead.
  test("options.apiKey adds no bearer when the caller sent x-api-key", async () => {
    const upstream = stubUpstream()
    const cassette = "parity-selftest/x-api-key"
    const proxy = await LLMParityServer.start({
      mode: "record",
      cassette,
      realBaseURL: upstream.baseURL,
      apiKey: "override-key",
    })
    try {
      await fetch(`${proxy.baseURL}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "caller-key", "anthropic-version": "2023-06-01" },
        body: "{}",
      })

      expect(upstream.received[0].headers["authorization"]).toBeUndefined()
      expect(upstream.received[0].headers["x-api-key"]).toBe("caller-key")
      expect(upstream.received[0].headers["anthropic-version"]).toBe("2023-06-01")
      // ...and the cassette keeps the header NAME with the value redacted.
      const recorded = (await readCassette(cassette)).interactions[0].request.headers
      expect(recorded["x-api-key"]).toBe("[REDACTED]")
    } finally {
      await proxy.close()
      await upstream.close()
    }
  })
})
