// The Flock pane's ACP surface, driven against a REAL flock store and a REAL
// config file in a temporary directory — never the owner's own global config
// dir, which is the whole reason `directory` is a parameter on every method.
//
// What is asserted here is what the pane cannot check for itself: that a write
// lands in the right one of the TWO files (friends and specialties in
// flock.json, model/budget/scope in origami.json), that `null` clears an
// override while absent leaves it alone, and that the model-required refusal
// survives the round trip so the pane's red line has something true to render.
import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agent } from "@/acp/agent"
import type * as ACPService from "@/acp/service"
import { ACPFlock } from "@/acp/flock"
import { FlockOwnerLease } from "@/flock/owner-lease"
import { FlockService } from "@/flock/service"
import { FlockFrontDesk } from "@/flock/frontdesk"
import { FlockIdentity } from "@/flock/identity"
import { FlockPolicy } from "@/flock/policy"
import { FlockStore } from "@/flock/store"

const dirs: string[] = []
const tmp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acp-flock-"))
  dirs.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

/** A second Origami's invite, made in its own directory so the two identities
 *  are genuinely different keypairs rather than a hand-built string. */
function inviteFrom(name: string): string {
  return FlockStore.Store.open({ directory: tmp(), name }).invite().invite
}

const readConfig = (directory: string) =>
  JSON.parse(fs.readFileSync(path.join(directory, "origami.json"), "utf8")) as Record<string, any>

describe("flock_state", () => {
  test("answers identity, an empty flock and an unavailable card on a first-ever open", () => {
    const directory = tmp()
    const state = ACPFlock.state({ directory })

    expect(state.identity.handle).toContain("@")
    expect(state.identity.fingerprint).toBe(state.identity.handle.split("@")[1]!)
    // FULL and SHORT both, because the pane needs both and must not compute the
    // short one from a slice of its own: the full handle is what every write
    // posts back, the short one is only a label.
    expect(state.identity.fingerprint).toHaveLength(43)
    expect(state.identity.handleShort).toBe(FlockIdentity.short(state.identity.handle))
    expect(state.identity.handle.startsWith(state.identity.handleShort)).toBe(true)
    expect(state.identity.handleShort).not.toBe(state.identity.handle)
    expect(state.identity.signPublicKey.length).toBeGreaterThan(0)
    expect(state.friends).toEqual([])
    expect(state.specialties).toEqual([])
    expect(state.answers).toEqual([])
    // The pane's red line comes from HERE, not from a string it invents: with no
    // model set the card itself says the desk is unavailable, and says why.
    expect(state.frontDesk.model).toBeUndefined()
    expect(state.availability).toContain(FlockPolicy.MODEL_UNSET)
    expect(state.frontDeskPath).toBe(path.join(directory, "origami.json"))
  })

  test("reports each friend's effective policy, their cap and what they spent today", () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "anthropic/claude-sonnet", dailyBudgetTokens: 1000 })
    expect(ACPFlock.accept({ directory, invite: inviteFrom("bob") }).ok).toBe(true)
    const handle = ACPFlock.state({ directory }).friends[0]!.handle

    FlockStore.Store.open({ directory }).charge(handle, 250, FlockPolicy.day())
    const friend = ACPFlock.state({ directory }).friends[0]!

    expect(friend.spentToday).toBe(250)
    // The cap is the DESK's, inherited: the friend set none of their own.
    expect(friend.budget).toBe(1000)
    expect(friend.effective.model).toBe("anthropic/claude-sonnet")
    expect(friend.effective.autoAnswer).toBe(false)
  })

  test("the desk-wide auto-answer default reaches a friend who has no override", () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "anthropic/claude-sonnet", autoAnswer: true })
    ACPFlock.accept({ directory, invite: inviteFrom("carol") })

    expect(ACPFlock.state({ directory }).friends[0]!.effective.autoAnswer).toBe(true)
    // And the default it came from is reported, so the switch can render on.
    expect(ACPFlock.state({ directory }).frontDesk.autoAnswer).toBe(true)
  })
})

describe("flock_invite / flock_accept / flock_revoke", () => {
  test("an invite carries public keys only and can be accepted by the other side", () => {
    const alice = tmp()
    const made = ACPFlock.invite({ directory: alice })
    expect(made.ok).toBe(true)
    expect(made.invite).toStartWith("origami://flock/invite#")
    // The private half must not be anywhere in the string a user pastes around.
    const identity = FlockStore.Store.open({ directory: alice }).identity()
    expect(made.invite!).not.toContain(identity.sign.privateKey.slice(0, 24))
    expect(made.invite!).not.toContain(identity.box.privateKey.slice(0, 24))

    const bob = tmp()
    expect(ACPFlock.accept({ directory: bob, invite: made.invite! }).ok).toBe(true)
    expect(ACPFlock.state({ directory: bob }).friends[0]!.handle).toBe(identity.handle)
  })

  test("accept carries the per-friend switches the pane offered at accept time", () => {
    const directory = tmp()
    ACPFlock.accept({ directory, invite: inviteFrom("dave"), autoAnswer: true, dailyBudgetTokens: 400 })
    const friend = ACPFlock.state({ directory }).friends[0]!
    expect(friend.policy.autoAnswer).toBe(true)
    expect(friend.budget).toBe(400)
  })

  test("a malformed invite is a refusal with the reason, never a throw", () => {
    const result = ACPFlock.accept({ directory: tmp(), invite: "origami://flock/invite#v9.nope" })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("invite")
  })

  test("revoke removes the friend; revoking a stranger says so", () => {
    const directory = tmp()
    ACPFlock.accept({ directory, invite: inviteFrom("erin") })
    const handle = ACPFlock.state({ directory }).friends[0]!.handle

    expect(ACPFlock.revoke({ directory, handle }).ok).toBe(true)
    expect(ACPFlock.state({ directory }).friends).toEqual([])
    // MUTATION PROOF: a revoke that only reported success without removing the
    // row would pass the line above and fail this one.
    expect(FlockStore.Store.open({ directory }).friends()).toEqual([])
    expect(ACPFlock.revoke({ directory, handle })).toEqual({ ok: false, message: `${handle} is not in this flock` })
  })
})

describe("the flock_set_identity wire method", () => {
  /** The dispatch alone, with the service faked: what is under test here is the
   *  reader in `acp/agent.ts`, not what the store does with what it reads. */
  const agentWith = (seen: Record<string, unknown>[]) =>
    new Agent({
      flockSetIdentity: (input: ACPFlock.SetIdentityRequest) => {
        seen.push({ ...input })
        return Effect.succeed({ ok: true } as ACPFlock.WriteResult)
      },
    } as unknown as ACPService.Interface)

  test("carries name and icon through to the service, and forwards neither when neither was sent", async () => {
    const seen: Record<string, unknown>[] = []
    const agent = agentWith(seen)

    expect(await agent.extMethod("flock_set_identity", { name: "Dana", icon: "fox" })).toEqual({ ok: true })
    // The `_` prefix is what a client actually puts on the wire for an ext
    // method, so the new one has to answer to both spellings like the nine
    // before it.
    await agent.extMethod("_flock_set_identity", { icon: "wolf" })
    await agent.extMethod("flock_set_identity", {})

    expect(seen[0]).toEqual({ name: "Dana", icon: "fox" })
    // ABSENT, not empty: "leave the name as it is" and "set the name to
    // nothing" are different intentions, and only one of them is expressible.
    expect(seen[1]).toEqual({ icon: "wolf" })
    expect(seen[2]).toEqual({})
  })

  test("refuses a name or an icon that is not a string, rather than storing one", () => {
    const seen: Record<string, unknown>[] = []
    const agent = agentWith(seen)
    // Thrown, not returned: a malformed button press must not reach the store
    // at all, which is what the empty `seen` below is asserting.
    const refused = (params: Record<string, unknown>) => {
      try {
        void agent.extMethod("flock_set_identity", params)
        return ""
      } catch (error) {
        return String((error as { data?: unknown }).data ?? error)
      }
    }
    expect(refused({ name: 42 })).toContain("name must be a string")
    expect(refused({ icon: ["fox"] })).toContain("icon must be a string")
    expect(seen).toEqual([])
  })
})

describe("flock_set_identity", () => {
  test("writes the display name and the icon, and leaves the handle where it is", () => {
    const directory = tmp()
    const before = ACPFlock.state({ directory }).identity

    const result = ACPFlock.setIdentity({ directory, name: "Passing by Pixels", icon: "fox" })
    expect(result.ok).toBe(true)

    const after = ACPFlock.state({ directory }).identity
    expect(after.name).toBe("Passing by Pixels")
    expect(after.icon).toBe("fox")
    // The pane shows the name; every contact MATCHES on the handle, so it must
    // survive a rename untouched — the short form and the fingerprint with it.
    expect(after.handle).toBe(before.handle)
    expect(after.handleShort).toBe(before.handleShort)
    expect(after.fingerprint).toBe(before.fingerprint)
    // Said out loud on the pane, because "did I just re-mint myself" is exactly
    // what a person renaming an identity is afraid of.
    expect(result.message).toContain(before.handle)
  })

  test("either field alone, and an icon that is not a short id becomes the default", () => {
    const directory = tmp()
    ACPFlock.setIdentity({ directory, name: "Dana" })
    expect(ACPFlock.state({ directory }).identity.icon).toBe(FlockIdentity.ICON_DEFAULT)

    ACPFlock.setIdentity({ directory, icon: "wolf" })
    expect(ACPFlock.state({ directory }).identity.name).toBe("Dana")
    expect(ACPFlock.state({ directory }).identity.icon).toBe("wolf")

    ACPFlock.setIdentity({ directory, icon: "https://example.invalid/x.png" })
    expect(ACPFlock.state({ directory }).identity.icon).toBe(FlockIdentity.ICON_DEFAULT)
  })

  test("every contact row carries the icon THEY chose", () => {
    const directory = tmp()
    const theirs = tmp()
    const sender = FlockStore.Store.open({ directory: theirs, name: "bob" })
    sender.setIdentity({ name: "Bob at the garage", icon: "deer" })

    expect(ACPFlock.accept({ directory, invite: sender.invite().invite }).ok).toBe(true)

    const row = ACPFlock.state({ directory }).friends[0]!
    expect(row.name).toBe("Bob at the garage")
    expect(row.icon).toBe("deer")
    // The owner's own icon is theirs alone; accepting somebody did not move it.
    expect(ACPFlock.state({ directory }).identity.icon).toBe(FlockIdentity.ICON_DEFAULT)
  })
})

describe("flock_set_policy", () => {
  test("sets an override, and `null` clears it back to the desk default", () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "anthropic/desk", dailyBudgetTokens: 900 })
    ACPFlock.accept({ directory, invite: inviteFrom("frank") })
    const handle = ACPFlock.state({ directory }).friends[0]!.handle

    ACPFlock.setPolicy({ directory, handle, dailyBudgetTokens: 100, model: "local/cheap", autoAnswer: true })
    let friend = ACPFlock.state({ directory }).friends[0]!
    expect(friend.budget).toBe(100)
    expect(friend.effective.model).toBe("local/cheap")
    expect(friend.effective.autoAnswer).toBe(true)

    // `null` = "no override of my own"; the desk's numbers come back.
    ACPFlock.setPolicy({ directory, handle, dailyBudgetTokens: null, model: null })
    friend = ACPFlock.state({ directory }).friends[0]!
    expect(friend.policy.dailyBudgetTokens).toBeUndefined()
    expect(friend.budget).toBe(900)
    expect(friend.effective.model).toBe("anthropic/desk")
    // ...and the switch the caller did NOT send is untouched.
    expect(friend.effective.autoAnswer).toBe(true)
  })

  // REVOKING A DEFAULT, per friend. The owner turns auto-answer on for everyone
  // and off for one person; then puts that person back on the default. Without
  // the second half the pane could make an override and never unmake one.
  test("`autoAnswer: null` revokes the override and the desk default applies again", () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "anthropic/desk", autoAnswer: true })
    ACPFlock.accept({ directory, invite: inviteFrom("grace") })
    ACPFlock.accept({ directory, invite: inviteFrom("henry") })
    const [grace, henry] = ACPFlock.state({ directory }).friends

    ACPFlock.setPolicy({ directory, handle: grace!.handle, autoAnswer: false })
    let friends = ACPFlock.state({ directory }).friends
    expect(friends[0]!.effective.autoAnswer).toBe(false)
    // The OTHER friend is untouched — that is what "without touching the
    // others" means, and a shared-object bug here would flip both.
    expect(friends[1]!.effective.autoAnswer).toBe(true)
    expect(henry!.handle).toBe(friends[1]!.handle)

    ACPFlock.setPolicy({ directory, handle: grace!.handle, autoAnswer: null })
    friends = ACPFlock.state({ directory }).friends
    expect(friends[0]!.policy.autoAnswer).toBeUndefined()
    expect(friends[0]!.effective.autoAnswer).toBe(true)
  })

  test("a per-friend scope override REPLACES the default list, and `null` gives it back", () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "anthropic/desk", scope: { repos: ["a", "b"], wiki: ["w"] } })
    ACPFlock.accept({ directory, invite: inviteFrom("ivy") })
    const handle = ACPFlock.state({ directory }).friends[0]!.handle

    // Switching ONE default entry off for this friend is the default list minus
    // that entry, written as their own scope — the seam the pane's off-switch
    // uses, and the reason it posts three arrays rather than a delta.
    ACPFlock.setPolicy({ directory, handle, scope: { repos: ["a"], wiki: ["w"] } })
    expect(ACPFlock.state({ directory }).friends[0]!.policy.scope).toEqual({ repos: ["a"], wiki: ["w"] })

    ACPFlock.setPolicy({ directory, handle, scope: null })
    expect(ACPFlock.state({ directory }).friends[0]!.policy.scope).toBeUndefined()
  })

  test("a display name is stored beside the friend, not inside their policy", () => {
    const directory = tmp()
    ACPFlock.accept({ directory, invite: inviteFrom("dana") })
    const handle = ACPFlock.state({ directory }).friends[0]!.handle

    ACPFlock.setPolicy({ directory, handle, displayName: "  Dana from the gym  ", dailyBudgetTokens: 250 })
    let friend = ACPFlock.state({ directory }).friends[0]!
    expect(friend.displayName).toBe("Dana from the gym")
    // The declared name is what signed the invite and stays visible beside it.
    expect(friend.name).toBe("dana")
    expect(friend.policy).toEqual({ dailyBudgetTokens: 250 })

    // A later policy write that says nothing about the label leaves it alone...
    ACPFlock.setPolicy({ directory, handle, autoAnswer: true })
    expect(ACPFlock.state({ directory }).friends[0]!.displayName).toBe("Dana from the gym")
    // ...and `null` clears it back to the declared name.
    ACPFlock.setPolicy({ directory, handle, displayName: null })
    friend = ACPFlock.state({ directory }).friends[0]!
    expect(friend.displayName).toBeUndefined()
    expect(friend.policy.autoAnswer).toBe(true)
  })

  test("a handle nobody holds is refused rather than written", () => {
    expect(ACPFlock.setPolicy({ directory: tmp(), handle: "ghost@0000", autoAnswer: true })).toEqual({
      ok: false,
      message: "ghost@0000 is not in this flock",
    })
  })
})

describe("flock_front_desk / flock_set_specialties — which file each lands in", () => {
  test("model, budget and scope go to origami.json; the specialties do not", () => {
    const directory = tmp()
    const result = ACPFlock.frontDesk({
      directory,
      model: "anthropic/claude-sonnet",
      dailyBudgetTokens: 5000,
      scope: { repos: ["work/api"], wiki: ["wiki/public"] },
    })
    expect(result.ok).toBe(true)
    expect(result.path).toBe(path.join(directory, "origami.json"))

    const config = readConfig(directory)
    expect(config["flock"]["frontDesk"]).toEqual({
      model: "anthropic/claude-sonnet",
      dailyBudgetTokens: 5000,
      scope: { repos: ["work/api"], wiki: ["wiki/public"] },
    })

    ACPFlock.setSpecialties({ directory, specialties: [" WordPress ", "", "UK MOT rules"] })
    // Trimmed, blanks dropped, and NOT in the config file — the card's prose
    // lives beside the friends, which is the split the module documents.
    expect(ACPFlock.state({ directory }).specialties).toEqual(["WordPress", "UK MOT rules"])
    expect(readConfig(directory)["flock"]["frontDesk"]["specialties"]).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(path.join(directory, "flock.json"), "utf8")).desk.specialties).toEqual([
      "WordPress",
      "UK MOT rules",
    ])
  })

  test("a partial write leaves the fields it was not given alone, and `null` removes one", () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "a/one", dailyBudgetTokens: 100 })
    ACPFlock.frontDesk({ directory, model: "a/two" })
    expect(readConfig(directory)["flock"]["frontDesk"]).toEqual({ model: "a/two", dailyBudgetTokens: 100 })

    ACPFlock.frontDesk({ directory, dailyBudgetTokens: null })
    expect(readConfig(directory)["flock"]["frontDesk"]).toEqual({ model: "a/two" })
  })

  test("an existing origami.json keeps its other keys and its comments", () => {
    const directory = tmp()
    fs.writeFileSync(
      path.join(directory, "origami.json"),
      '{\n  // keep me\n  "theme": "meadow"\n}\n',
      "utf8",
    )
    ACPFlock.frontDesk({ directory, model: "a/one" })
    const text = fs.readFileSync(path.join(directory, "origami.json"), "utf8")
    expect(text).toContain("// keep me")
    expect(text).toContain('"theme": "meadow"')
    // Read back through the module, not JSON.parse: the file is now JSONC, and
    // a reader that could not cope with the comment it just preserved would be
    // the bug this test exists to catch.
    expect(ACPFlock.state({ directory }).frontDesk.model).toBe("a/one")
  })

  test("MUTATION PROOF — with no model set the desk refuses, and the state says so", async () => {
    const directory = tmp()
    ACPFlock.accept({ directory, invite: inviteFrom("gail") })
    const store = FlockStore.Store.open({ directory })
    const desk = FlockFrontDesk.make({
      store,
      runner: async () => {
        throw new Error("the runner must never be reached with no model set")
      },
    })

    const refusal = await desk.ask({ friend: store.friends()[0]!, question: "anything", id: "q-nomodel" })
    expect(refusal).toEqual({ ok: false, text: FlockPolicy.MODEL_UNSET, tokens: 0 })
    expect(ACPFlock.state({ directory }).frontDesk.model).toBeUndefined()

    // Set one, and BOTH the refusal and the pane's line go away. Delete the
    // model line from `policy.ts` and the first half of this test passes while
    // this half never changes — which is why both halves are here.
    ACPFlock.frontDesk({ directory, model: "anthropic/claude-sonnet" })
    expect(ACPFlock.state({ directory }).frontDesk.model).toBe("anthropic/claude-sonnet")
    expect(ACPFlock.state({ directory }).availability).not.toContain(FlockPolicy.MODEL_UNSET)
  })
})

describe("the answer log the Inbox reads", () => {
  test("records BOTH an answered question and a refused one, with what each cost", async () => {
    const directory = tmp()
    ACPFlock.frontDesk({ directory, model: "anthropic/claude-sonnet", autoAnswer: true })
    ACPFlock.accept({ directory, invite: inviteFrom("hana") })
    const store = FlockStore.Store.open({ directory })
    const friend = store.friends()[0]!
    const desk = FlockFrontDesk.make({
      store,
      config: { model: "anthropic/claude-sonnet", autoAnswer: true },
      runner: async () => ({ text: "the answer", tokens: 412 }),
    })

    await desk.ask({ friend, question: "how does the MOT check work?", id: "q-log-1" })

    const answered = ACPFlock.state({ directory }).answers
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({
      from: friend.handle,
      question: "how does the MOT check work?",
      tokens: 412,
      ok: true,
    })

    // A REFUSAL is logged too. A log that held only the successes would hide
    // exactly the entries worth reading — the contact burning through a budget,
    // and the questions being turned away.
    const declining = FlockFrontDesk.make({
      store,
      config: { model: "anthropic/claude-sonnet", dailyBudgetTokens: 10, autoAnswer: true },
      runner: async () => {
        throw new Error("must not run once the budget is spent")
      },
    })
    await declining.ask({ friend, question: "and this one?", id: "q-log-2" })

    const both = ACPFlock.state({ directory }).answers
    expect(both).toHaveLength(2)
    expect(both[1]).toMatchObject({ question: "and this one?", tokens: 0, ok: false })
  })

  test("the ring is bounded, so the file cannot grow without limit", () => {
    const directory = tmp()
    const store = FlockStore.Store.open({ directory })
    for (let i = 0; i < FlockStore.ANSWER_LOG_MAX + 5; i++) {
      store.logAnswer({ at: new Date().toISOString(), from: "a@1", question: `q${i}`, tokens: 1, ok: true })
    }
    const answers = ACPFlock.state({ directory }).answers
    expect(answers).toHaveLength(FlockStore.ANSWER_LOG_MAX)
    // Oldest dropped, newest kept.
    expect(answers[0]!.question).toBe("q5")
    expect(answers.at(-1)!.question).toBe(`q${FlockStore.ANSWER_LOG_MAX + 4}`)
  })
})

describe("flock_mailbox and flock_pending — what the mail manager renders", () => {
  /** Alice with one contact, and a directory the reads can be pointed at. */
  function mailbox() {
    const directory = tmp()
    ACPFlock.accept({ directory, invite: inviteFrom("bob") })
    const store = FlockStore.Store.open({ directory })
    return { directory, store, contact: store.friends()[0]! }
  }

  test("a row carries the contact's NAME and icon, which a handle alone cannot give a reader", () => {
    const { directory, store, contact } = mailbox()
    store.openIn({ id: "q1", contact: contact.handle, question: "how does the MOT check work?" })

    const rows = ACPFlock.mailbox({ directory })
    expect(rows.threads).toHaveLength(1)
    expect(rows.threads[0]!.name).toBe(contact.name)
    expect(rows.threads[0]!.icon).toBe("crane")
    expect(rows.threads[0]!.handleShort).toContain("@")
    expect(rows.waiting).toBe(1)
    expect(rows.unread).toBe(1)
  })

  test("waiting counts inbound questions only; unread counts every row the owner has not seen", () => {
    const { directory, store, contact } = mailbox()
    store.openIn({ id: "in1", contact: contact.handle, question: "?" })
    store.openOut({ id: "out1", contact: contact.handle, question: "mine" })
    store.settleOut("out1", { ok: true, text: "theirs", tokens: 12, signatureOk: true })

    const rows = ACPFlock.mailbox({ directory })
    // A reply of theirs is unread but is NOT waiting on a decision: the badge
    // has to tell an owner which of the two kinds is on the mat.
    expect(rows.waiting).toBe(1)
    expect(rows.unread).toBe(2)
  })

  test("flock_pending is the questions waiting, with the thread id the decision names", () => {
    const { directory, store, contact } = mailbox()
    store.openIn({ id: "q1", contact: contact.handle, question: "how does the MOT check work?" })
    store.openIn({ id: "q2", contact: contact.handle, question: "already dealt with" })
    store.settleIn({ id: "q2", contact: contact.handle, ok: true, text: "done", tokens: 5 })

    const rows = ACPFlock.pending({ directory }).questions
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: "q1",
      sessionID: "",
      from: contact.handle,
      name: contact.name,
      question: "how does the MOT check work?",
    })
  })

  test("marking a row read clears it from the unread count, and delivering records the session", () => {
    const { directory, store, contact } = mailbox()
    store.openOut({ id: "out1", contact: contact.handle, question: "mine" })
    store.settleOut("out1", { ok: true, text: "theirs", tokens: 3, signatureOk: true })

    expect(ACPFlock.mark({ directory, thread: "out1", mark: "delivered", sessionID: "ses_7" })).toEqual({ ok: true })
    const delivered = ACPFlock.mailbox({ directory }).threads[0]!
    expect(delivered.deliveredTo).toEqual(["ses_7"])
    expect(delivered.state).toBe("delivered")
    expect(ACPFlock.mailbox({ directory }).unread).toBe(0)

    // A row nobody holds is a refusal with a sentence, not a silent no-op: the
    // pane would otherwise show a button that does nothing.
    expect(ACPFlock.mark({ directory, thread: "nope", mark: "read" })).toEqual({
      ok: false,
      message: "thread nope is not in this mailbox",
    })
  })
})

// WHICH ENGINE HOLDS THE LINKS. Everything else on `flock_state` is a file
// read; this one field is live process state, and it is here because the pane
// already re-reads this on every write.
describe("flock_state — transport", () => {
  test("an engine that never started the flock reports none, not a guess", () => {
    expect(ACPFlock.state({ directory: tmp() }).transport).toBe("none")
    expect(FlockService.kind()).toBe("none")
  })

  test("it is the SERVICE's answer, not a file: the second engine reports other-engine", () => {
    const lease = tmp()
    const flock = tmp()
    const mine = FlockStore.Store.open({ directory: flock, name: "alice" })
    mine.accept(inviteFrom("bob"))

    const noDial = {
      connect: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      setTimer: () => 0,
      clearTimer: () => {},
    }
    const owning = FlockService.start({
      store: FlockStore.Store.open({ directory: flock }),
      config: { model: "test/fake" },
      runner: async () => ({ text: "", tokens: 0 }),
      deps: noDial,
      owner: new FlockOwnerLease.Owner({ directory: lease, pid: 101, alive: () => true }),
      log: () => {},
    })
    expect(ACPFlock.state({ directory: flock }).transport).toBe("relay")

    const second = FlockService.start({
      store: FlockStore.Store.open({ directory: flock }),
      config: { model: "test/fake" },
      runner: async () => ({ text: "", tokens: 0 }),
      deps: noDial,
      owner: new FlockOwnerLease.Owner({ directory: lease, pid: 202, alive: () => true }),
      log: () => {},
    })
    expect(ACPFlock.state({ directory: flock }).transport).toBe("other-engine")

    second.stop()
    owning.stop()
    expect(ACPFlock.state({ directory: flock }).transport).toBe("none")
  })
})

describe("the scope readers on the two scope-writing wire methods", () => {
  /** The dispatch alone, service faked: under test is `flockScope` in
   *  `acp/agent.ts`, the ONE reader both methods share. A list it does not
   *  name never reaches the store, whatever the store would do with it. */
  const agentWith = (seen: Record<string, unknown>[]) =>
    new Agent({
      flockSetPolicy: (input: ACPFlock.SetPolicyRequest) => {
        seen.push({ ...input })
        return Effect.succeed({ ok: true } as ACPFlock.WriteResult)
      },
      flockFrontDesk: (input: ACPFlock.FrontDeskRequest) => {
        seen.push({ ...input })
        return Effect.succeed({ ok: true } as ACPFlock.WriteResult)
      },
    } as unknown as ACPService.Interface)

  test("carries scope.folders through on BOTH methods — a browsed folder that the reader dropped was a share nobody made", async () => {
    const seen: Record<string, unknown>[] = []
    const agent = agentWith(seen)
    const scope = { repos: ["a"], wiki: ["w"], folders: ["/srv/shared"] }

    await agent.extMethod("flock_set_policy", { handle: "dana@abc", scope })
    await agent.extMethod("flock_front_desk", { scope })

    expect(seen[0]!["scope"]).toEqual(scope)
    expect(seen[1]!["scope"]).toEqual(scope)
  })

  test("does not carry a `skills` list — it stopped being a permission in 0.4.106", async () => {
    const seen: Record<string, unknown>[] = []
    const agent = agentWith(seen)
    await agent.extMethod("flock_set_policy", { handle: "dana@abc", scope: { repos: ["a"], skills: ["s"] } })
    expect(seen[0]!["scope"]).toEqual({ repos: ["a"] })
  })
})
