import { describe, expect, test } from "bun:test"
import {
  createDescendantCheck,
  permissionWarning,
  resolvePermissionAsk,
} from "@/cli/cmd/run/permission.descendant"

const RUN = "ses_run"
const CHILD = "ses_child"
const GRANDCHILD = "ses_grandchild"
const STRANGER = "ses_stranger"

// parent chain: grandchild -> child -> run; stranger belongs to another run.
const TREE: Record<string, string | undefined> = {
  [CHILD]: RUN,
  [GRANDCHILD]: CHILD,
  [STRANGER]: "ses_other_run",
}

function tree(counter?: { calls: number }) {
  return async (sessionID: string) => {
    if (counter) counter.calls++
    return TREE[sessionID]
  }
}

function ask(sessionID: string) {
  return {
    id: "per_1",
    sessionID,
    permission: "external_directory",
    patterns: ["/outside/*"],
  }
}

function recorder() {
  const replies: Array<{ requestID: string; reply: string }> = []
  const warnings: string[] = []
  return {
    replies,
    warnings,
    reply: async (input: { requestID: string; reply: "once" | "reject" }) => {
      replies.push(input)
    },
    warn: (message: string) => {
      warnings.push(message)
    },
  }
}

describe("createDescendantCheck", () => {
  test("recognises the run session, its child and its grandchild", async () => {
    const check = createDescendantCheck({ rootSessionID: RUN, parentOf: tree() })
    expect(await check(RUN)).toBe(true)
    expect(await check(CHILD)).toBe(true)
    expect(await check(GRANDCHILD)).toBe(true)
  })

  test("a session from an unrelated run is not a descendant", async () => {
    const check = createDescendantCheck({ rootSessionID: RUN, parentOf: tree() })
    expect(await check(STRANGER)).toBe(false)
  })

  test("memoises the verdict instead of re-walking per ask", async () => {
    const counter = { calls: 0 }
    const check = createDescendantCheck({ rootSessionID: RUN, parentOf: tree(counter) })

    await check(GRANDCHILD)
    const afterFirst = counter.calls
    expect(afterFirst).toBeGreaterThan(0)

    await check(GRANDCHILD)
    await check(GRANDCHILD)
    expect(counter.calls).toBe(afterFirst)
  })

  test("a parent cycle terminates instead of spinning", async () => {
    const cyclic: Record<string, string> = { a: "b", b: "a" }
    const check = createDescendantCheck({ rootSessionID: RUN, parentOf: async (id) => cyclic[id] })
    expect(await check("a")).toBe(false)
  })

  test("stops walking at the hop cap", async () => {
    // Every session claims a fresh parent, so only the cap can end the walk.
    let seen = 0
    const check = createDescendantCheck({
      rootSessionID: RUN,
      parentOf: async () => `ses_${seen++}`,
      maxHops: 3,
    })
    expect(await check("ses_deep")).toBe(false)
    expect(seen).toBe(3)
  })
})

describe("resolvePermissionAsk", () => {
  // The bug this guards: a subagent's ask carries the CHILD session id, the old
  // exact-match check dropped it, and NOTHING ever replied - so the subagent's tool
  // call hung forever. Asserting the reply is what makes this a real regression test;
  // asserting only that the session matched would pass against the broken code.
  test("replies 'once' to a CHILD session's ask under --auto", async () => {
    const rec = recorder()
    const outcome = await resolvePermissionAsk({
      ask: ask(CHILD),
      isDescendant: createDescendantCheck({ rootSessionID: RUN, parentOf: tree() }),
      auto: true,
      reply: rec.reply,
      warn: rec.warn,
    })

    expect(outcome).toBe("allowed")
    expect(rec.replies).toEqual([{ requestID: "per_1", reply: "once" }])
  })

  test("rejects AND warns on a CHILD session's ask without --auto", async () => {
    const rec = recorder()
    const outcome = await resolvePermissionAsk({
      ask: ask(CHILD),
      isDescendant: createDescendantCheck({ rootSessionID: RUN, parentOf: tree() }),
      auto: false,
      reply: rec.reply,
      warn: rec.warn,
    })

    expect(outcome).toBe("rejected")
    expect(rec.replies).toEqual([{ requestID: "per_1", reply: "reject" }])
    expect(rec.warnings).toEqual([permissionWarning(ask(CHILD))])
  })

  test("still answers the run session's own ask", async () => {
    const rec = recorder()
    const outcome = await resolvePermissionAsk({
      ask: ask(RUN),
      isDescendant: createDescendantCheck({ rootSessionID: RUN, parentOf: tree() }),
      auto: true,
      reply: rec.reply,
      warn: rec.warn,
    })

    expect(outcome).toBe("allowed")
    expect(rec.replies).toHaveLength(1)
  })

  test("ignores an unrelated session's ask - it is not ours to answer", async () => {
    const rec = recorder()
    const outcome = await resolvePermissionAsk({
      ask: ask(STRANGER),
      isDescendant: createDescendantCheck({ rootSessionID: RUN, parentOf: tree() }),
      auto: true,
      reply: rec.reply,
      warn: rec.warn,
    })

    expect(outcome).toBe("ignored")
    expect(rec.replies).toEqual([])
    expect(rec.warnings).toEqual([])
  })
})
