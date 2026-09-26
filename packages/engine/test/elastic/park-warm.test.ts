// t-z6ytkw: the rules of a cache warm handed over at a park (elastic/park-warm.ts).
// The byte identity of the warm itself is park-warm-bytes.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { jsonSchema, tool } from "ai"
import { ElasticParkWarm } from "@/elastic/park-warm"
import { SessionCacheWarm } from "@/session/cache-warm"

const MODEL = { id: "claude-x", providerID: "anthropic", api: { id: "claude-x", npm: "@ai-sdk/anthropic" } } as never
let root: string
const due = new Map<number, () => void>()
let next = 0

function arm(sessionID: string, env: Record<string, string | undefined> = {}) {
  SessionCacheWarm.armed({
    sessionID,
    model: MODEL,
    options: {},
    messages: [{ role: "user", content: "hi" }],
    send: async () => undefined,
    env,
    recipe: () => ({ input: { sessionID, messages: [{ role: "user", content: "hi" }], tools: {}, system: [] }, directory: root }),
  })
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "origami-park-warm-unit-"))
  SessionCacheWarm.reset()
  SessionCacheWarm.setClock({
    setTimeout: (fn) => (due.set(++next, fn), { id: next }),
    clearTimeout: (h) => void due.delete(h.id as number),
  })
})
afterEach(() => {
  SessionCacheWarm.reset()
  delete process.env[SessionCacheWarm.DISABLE_ENV]
  rmSync(root, { recursive: true, force: true })
})

describe("persist and take", () => {
  test("an armed warm is handed over with its due time, and taken once", async () => {
    arm("ses_a")
    const handed = await ElasticParkWarm.persist(root)
    expect(handed).toEqual([{ sessionId: "ses_a", dueAt: expect.any(Number) }])
    expect(handed[0]!.dueAt).toBeGreaterThan(Date.now() + 200_000) // 80% of the 5-minute cache
    SessionCacheWarm.reset() // the process stopped
    const taken = ElasticParkWarm.take("ses_a", root)
    expect("recipe" in taken && taken.recipe.input.sessionID).toBe("ses_a")
    expect(ElasticParkWarm.take("ses_a", root)).toEqual({ refused: "no warm was handed over" })
  })

  test("no warm armed (it already fired): nothing handed over, and an old file is removed", async () => {
    arm("ses_b")
    await ElasticParkWarm.persist(root)
    for (const fire of [...due.values()]) fire() // the warm fired while the engine was up
    expect(await ElasticParkWarm.persist(root)).toEqual([])
    expect(ElasticParkWarm.take("ses_b", root)).toEqual({ refused: "no warm was handed over" })
  })

  test("warming off: nothing is handed over, and a handed-over warm is not sent", async () => {
    arm("ses_c")
    await ElasticParkWarm.persist(root)
    process.env[SessionCacheWarm.DISABLE_ENV] = "1"
    arm("ses_d")
    expect(await ElasticParkWarm.persist(root)).toEqual([])
    SessionCacheWarm.reset()
    expect(ElasticParkWarm.take("ses_c", root)).toEqual({ refused: "cache warming is off" })
  })

  test("a woken engine that already sent a real request does not send the old warm", async () => {
    arm("ses_e")
    await ElasticParkWarm.persist(root)
    SessionCacheWarm.reset()
    arm("ses_e") // the user wrote in the restored chat
    expect(ElasticParkWarm.take("ses_e", root)).toEqual({ refused: "a real request went out since the park" })
    expect(existsSync(path.join(root, ElasticParkWarm.DIR, "ses_e.json"))).toBe(false)
  })
})

describe("encode / decode", () => {
  test("tools keep their JSON schema, binary parts and URLs survive", async () => {
    const schema = { type: "object" as const, properties: { q: { type: "string" as const } }, required: ["q"] }
    const text = await ElasticParkWarm.encode({
      input: {
        sessionID: "s",
        system: [],
        tools: { find: tool({ description: "Find", inputSchema: jsonSchema(schema), execute: async () => "x" }) },
        messages: [{ role: "user", content: [{ type: "image", image: new Uint8Array([1, 2, 255]) }, { type: "file", data: new URL("https://x.test/a.pdf"), mediaType: "application/pdf" }] }],
      } as never,
    })
    const back = ElasticParkWarm.decode(text)
    const find = back.input.tools["find"] as { description: string; inputSchema: { jsonSchema: unknown }; execute?: unknown }
    expect(find.description).toBe("Find")
    expect(await find.inputSchema.jsonSchema).toEqual(schema)
    expect(find.execute).toBeUndefined()
    const parts = back.input.messages[0]!.content as Array<Record<string, unknown>>
    expect(parts[0]!["image"]).toEqual(new Uint8Array([1, 2, 255]))
    expect(parts[1]!["data"]).toBeInstanceOf(URL)
  })
})
