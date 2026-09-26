// WHAT THE FRONT DESK DECIDES, before any model is asked anything.
//
// Three switches and one cage, and every one of them is a way the owner's money
// or files leak if it is wrong. Asserted here against the requirement, not
// against the implementation: "an owner who set no model answers nobody",
// "an owner who set no scope shares nothing", "a spent budget names when it
// refills", "the owner is told once and not once per stranger".
import { afterAll, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Permission } from "@/permission"
import { FlockFrontDesk } from "@/flock/frontdesk"
import { FlockPolicy } from "@/flock/policy"
import { FlockStore } from "@/flock/store"

// Each store gets its own directory; they are removed together at the end so a
// full run does not leave a few hundred of them behind.
const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flock-desk-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** Alice, and Bob in her friends list. Everything below is Bob asking Alice. */
function makeDesk(input: {
  config?: FlockPolicy.FrontDeskConfig
  overrides?: FlockPolicy.Overrides
  answer?: { text: string; tokens: number }
}) {
  const store = FlockStore.Store.open({ directory: tmp(), name: "alice" })
  const bob = FlockStore.Store.open({ directory: tmp(), name: "bob" })
  const friend = store.accept(bob.invite().invite, input.overrides)
  // Typed by their interfaces so `mock.calls` keeps the argument shape: an
  // untyped `mock(async () => …)` infers a zero-argument call signature, and
  // the assertions below are about WHAT the desk hands its runner.
  const runner = mock<FlockFrontDesk.Runner>(async () => input.answer ?? { text: "the answer", tokens: 500 })
  const notify = mock(() => {})
  const desk = FlockFrontDesk.make({
    store,
    ...(input.config ? { config: input.config } : {}),
    specialties: ["tax rules"],
    runner,
    notifyModelUnset: notify,
  })
  let n = 0
  /** One inbound question, under an id the mailbox can be checked against. */
  const ask = (question: string, id = `q${++n}`) => desk.ask({ friend, question, id })
  return { store, friend, desk, ask, runner, notify }
}

/** The desk answered on the spot. Narrows away the parked case, loudly. */
function answered(served: Awaited<ReturnType<FlockFrontDesk.Runner>> | { deferred: true } | { ok: boolean; text: string; tokens: number }) {
  if ("deferred" in served) throw new Error("the desk parked this question instead of answering it")
  return served as { ok: boolean; text: string; tokens: number }
}

describe("the model is required and has no default", () => {
  test("refuses with 'front desk model not set' and never runs a model", async () => {
    const { ask, runner } = makeDesk({ config: {} })
    const answer = answered(await ask("what does the tax form cover?"))

    expect(answer.ok).toBe(false)
    expect(answer.text).toBe("front desk model not set")
    expect(answer.tokens).toBe(0)
    expect(runner).not.toHaveBeenCalled()
  })

  // THE OTHER HALF OF DROPPING THE START GATE (`service.ts`). The engine now
  // opens its sockets with no model, so an owner in that state is REACHABLE and
  // every question they receive is refused — and the only place that fact can
  // reach them is the mailbox badge. A refusal that only reached the answer log
  // would be a silent one.
  test("files an UNREAD mailbox row so the owner sees why their desk refused", async () => {
    const { ask, store, friend } = makeDesk({ config: {} })
    const answer = answered(await ask("what does the tax form cover?", "q-nomodel"))
    expect(answer.ok).toBe(false)

    const row = store.thread("q-nomodel")
    expect(row?.direction).toBe("in")
    expect(row?.state).toBe("declined")
    expect(row?.unread).toBe(true)
    expect(row?.contact).toBe(friend.handle)
    expect(row?.question.text).toBe("what does the tax form cover?")
    expect(row?.reply?.declined?.reason ?? row?.reply?.text).toContain("front desk model not set")
  })

  // `peer.ts` settles the SAME thread again a beat later with the frame it put
  // on the wire. Before `settleIn` carried `unread` over, that second write
  // cleared the badge the refusal had just raised — the row was there and the
  // owner was never told about it.
  test("the badge survives peer.ts settling the same thread with what it sent", async () => {
    const { ask, store, friend } = makeDesk({ config: {} })
    await ask("?", "q-twice")
    store.settleIn({
      id: "q-twice",
      contact: friend.handle,
      question: "?",
      ok: false,
      text: "front desk model not set",
      tokens: 0,
    })
    expect(store.thread("q-twice")?.unread).toBe(true)
  })

  test("tells the owner once, not once per stranger's question", async () => {
    const { ask, notify } = makeDesk({ config: {} })
    await ask("one")
    await ask("two")
    await ask("three")
    // A notice per inbound question is how a person learns to ignore notices.
    expect(notify).toHaveBeenCalledTimes(1)
  })

  test("a per-friend model overrides the global one", async () => {
    const { ask, runner } = makeDesk({
      config: { model: "cheap/one" },
      overrides: { autoAnswer: true, model: "special/two" },
    })
    await ask("?")
    expect(runner.mock.calls[0]![0].model).toBe("special/two")
  })
})

describe("auto-answer", () => {
  test("off by default: the question becomes a mailbox row and NOTHING is answered", async () => {
    const { ask, store, friend, runner } = makeDesk({ config: { model: "test/fake" } })
    const served = await ask("what is in the safe?", "q-safe")

    // Deferred, not refused: the asker gets no frame at all until the owner
    // decides, which is the whole difference from the old approval prompt.
    expect(served).toEqual({ deferred: true })
    expect(runner).not.toHaveBeenCalled()
    const thread = store.thread("q-safe")
    expect(thread?.direction).toBe("in")
    expect(thread?.state).toBe("pending")
    expect(thread?.contact).toBe(friend.handle)
    expect(thread?.question.text).toBe("what is in the safe?")
    expect(thread?.unread).toBe(true)
  })

  test("a resend of a parked question does not become a second row", async () => {
    const { ask, store } = makeDesk({ config: { model: "test/fake" } })
    await ask("same question", "q-dup")
    await ask("same question", "q-dup")
    expect(store.mailbox().filter((thread) => thread.id === "q-dup")).toHaveLength(1)
  })

  test("on: the desk answers on the spot, with its cost, and files no decision", async () => {
    const { ask, store, runner } = makeDesk({
      config: { model: "test/fake" },
      overrides: { autoAnswer: true },
      answer: { text: "read section 4", tokens: 812 },
    })
    const answer = answered(await ask("?", "q-auto"))

    expect(runner).toHaveBeenCalledTimes(1)
    expect(answer).toEqual({ ok: true, text: "read section 4", tokens: 812 })
    // `peer.ts` files the closed thread when it sends; the desk itself parks
    // nothing for an auto-answered contact.
    expect(store.thread("q-auto")).toBeUndefined()
  })
})

describe("the budget", () => {
  test("charges what the turn actually cost, per friend, per UTC day", async () => {
    const { ask, friend, store } = makeDesk({
      config: { model: "test/fake", dailyBudgetTokens: 10_000 },
      overrides: { autoAnswer: true },
      answer: { text: "ok", tokens: 700 },
    })
    await ask("one")
    await ask("two")
    expect(store.spent(friend.handle, FlockPolicy.day())).toBe(1400)
  })

  test("refuses once it is spent, and names when it refills", async () => {
    const { ask, friend, store, runner } = makeDesk({
      config: { model: "test/fake", dailyBudgetTokens: 1000 },
      overrides: { autoAnswer: true },
      answer: { text: "ok", tokens: 1200 },
    })
    expect(answered(await ask("one")).ok).toBe(true)

    const refused = answered(await ask("two"))
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain("daily budget of 1000 tokens is spent")
    // A refusal that does not say when it lifts sends the asker back to retry.
    expect(refused.text).toContain("it resets at")
    expect(refused.text).toMatch(/\d{4}-\d{2}-\d{2}T00:00:00\.000Z/)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(store.spent(friend.handle, FlockPolicy.day())).toBe(1200)
  })

  test("the budget is checked before the question is put in front of the owner", async () => {
    const { ask, friend, store } = makeDesk({
      config: { model: "test/fake", dailyBudgetTokens: 100 },
    })
    store.charge(friend.handle, 100, FlockPolicy.day())
    const answer = answered(await ask("?", "q-broke"))
    // A row asking the owner to decide on a question the next check refuses
    // anyway is a row that wastes their attention. Refused, not parked.
    expect(store.thread("q-broke")).toBeUndefined()
    expect(answer.text).toContain("daily budget")
  })

  test("no budget configured means no cap, not a cap of zero", async () => {
    const { ask } = makeDesk({ config: { model: "test/fake" }, overrides: { autoAnswer: true } })
    expect(answered(await ask("one")).ok).toBe(true)
    expect(answered(await ask("two")).ok).toBe(true)
  })
})

describe("the scope cage", () => {
  const evaluate = (rules: ReturnType<typeof FlockPolicy.scopeRuleset>, file: string) =>
    Permission.evaluate("read", file, rules).action

  test("an owner who shared nothing shares nothing", () => {
    const rules = FlockPolicy.scopeRuleset({})
    expect(evaluate(rules, "README.md")).toBe("deny")
    expect(evaluate(rules, "src/secret.ts")).toBe("deny")
  })

  test("a shared folder covers what is inside it, and nothing beside it", () => {
    const rules = FlockPolicy.scopeRuleset({ repos: ["acme_website"], wiki: ["wiki/public"] })
    expect(evaluate(rules, "acme_website")).toBe("allow")
    expect(evaluate(rules, "acme_website/wp-content/theme.php")).toBe("allow")
    expect(evaluate(rules, "wiki/public/tax.md")).toBe("allow")
    // The whole point of the cage.
    expect(evaluate(rules, "wiki/private/salary.md")).toBe("deny")
    expect(evaluate(rules, "acme_website_backup/dump.sql")).toBe("deny")
    expect(evaluate(rules, ".env")).toBe("deny")
    expect(evaluate(rules, "packages/engine/src/auth/index.ts")).toBe("deny")
  })

  test("a Windows-shaped relative path matches a forward-slash scope glob", () => {
    // `tool/read.ts` asks with `path.relative(worktree, filepath)`, which on
    // win32 comes back with backslashes, while a scope is written with forward
    // slashes in a config file that has to be portable. `Wildcard.match`
    // normalises both sides — asserted here rather than assumed, because the
    // failure mode is a cage that quietly allows nothing on one platform.
    const rules = FlockPolicy.scopeRuleset({ repos: ["acme_website"] })
    expect(evaluate(rules, "acme_website\\wp-content\\theme.php")).toBe("allow")
    expect(evaluate(rules, "other\\secret.php")).toBe("deny")
  })

  test("an explicit glob is honoured as written", () => {
    const rules = FlockPolicy.scopeRuleset({ folders: ["notes/*/PLAN.md"] })
    expect(evaluate(rules, "notes/deploy/PLAN.md")).toBe("allow")
    expect(evaluate(rules, "notes/deploy/other.md")).toBe("deny")
  })

  test("a shared FOLDER is caged exactly the way a repo is", () => {
    // The third list is not a third rule shape. It exists because "shareable"
    // used to mean a registered repo or a wiki subfolder and nothing else, so
    // an owner with a plain folder had nothing to tick — the cage it produces
    // has to be the one they already understand.
    const rules = FlockPolicy.scopeRuleset({ folders: ["D:/notes"] })
    expect(evaluate(rules, "D:/notes")).toBe("allow")
    expect(evaluate(rules, "D:/notes/2026/tax.md")).toBe("allow")
    expect(evaluate(rules, "D:/private/salary.md")).toBe("deny")
  })

  test("the deny comes first so the allows can override it, never the reverse", () => {
    const rules = FlockPolicy.scopeRuleset({ repos: ["shared"] })
    expect(rules[0]).toEqual({ permission: "read", pattern: "*", action: "deny" })
  })

  test("the desk composes the archetype cage with this owner's scope", () => {
    const { desk, friend } = makeDesk({
      config: { model: "test/fake", scope: { repos: ["shared"] } },
    })
    const rules = desk.permissionFor(friend)
    // The scope rules must land AFTER whatever the archetype said, because
    // `evaluate` is findLast: appended the other way round, a broad archetype
    // allow would win over the owner's narrowing.
    expect(rules.at(-1)).toEqual({ permission: "read", pattern: "shared/**", action: "allow" })
    expect(Permission.evaluate("read", "elsewhere/x.ts", rules).action).toBe("deny")
  })

  test("hands the composed cage and the chosen model to whatever runs the turn", async () => {
    const { ask, friend, runner } = makeDesk({
      config: { model: "test/fake", scope: { wiki: ["wiki/public"] } },
      overrides: { autoAnswer: true },
    })
    await ask("what does the tax form cover?")

    const call = runner.mock.calls[0]![0]
    expect(call.model).toBe("test/fake")
    expect(call.agent).toBe(FlockFrontDesk.AGENT)
    expect(call.from).toBe(friend.handle)
    expect(call.question).toBe("what does the tax form cover?")
    expect(Permission.evaluate("read", "wiki/public/tax.md", call.permission).action).toBe("allow")
    expect(Permission.evaluate("read", "wiki/private/x.md", call.permission).action).toBe("deny")
  })
})

describe("the card the desk publishes", () => {
  test("advertises the scope and the availability the policy actually produces", async () => {
    const { desk, friend } = makeDesk({
      config: { model: "test/fake", dailyBudgetTokens: 200_000, scope: { repos: ["acme_website"] } },
    })
    const card = await desk.card({ friend })
    expect(card.specialties).toEqual(["tax rules"])
    expect(card.shareable).toEqual(["acme_website"])
    expect(card.availability).toBe("answers on approval, up to 200000 tokens/day")
    expect(card.model).toBe("test/fake")
  })

  test("says so plainly when the desk cannot answer at all", async () => {
    const { desk, friend } = makeDesk({ config: {} })
    const card = await desk.card({ friend })
    // An asker reading this must not spend a turn discovering it by asking.
    expect(card.availability).toBe("unavailable — front desk model not set")
    expect(card.model).toBeUndefined()
  })
})
