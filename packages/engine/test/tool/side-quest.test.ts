// SIDE QUESTS, asserted where the controls actually live: in code.
//
// The two promises this feature makes the owner - it never blocks and it never
// floods - are not wording. "Never blocks" is the shape of the tool: it takes
// no ask, starts no session and injects nothing, and the layer stack below is
// the proof. There is no Session, no Database and no background-job registry in
// it, so a version of the tool that started a turn could not even build, let
// alone run. "Never floods" is the three caps, each with its own refusal here.
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fsp from "fs/promises"
import { Effect, Layer } from "effect"
import { PermissionV1 } from "@origami/core/v1/permission"
import { FSUtil } from "@origami/core/fs-util"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import {
  MAX_OPEN_PER_CHAT,
  claimQuestFile,
  normalizeTitle,
  nextNumber,
  questFile,
  sidequestsDir,
  SideQuestTool,
  turnKey,
} from "../../src/tool/side-quest"
import { forget } from "@/session/side-quest-budget"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([FSUtil.node, Truncate.node, Agent.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({})],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const itAgent = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Plugin.node, Provider.node, Auth.node, Config.node, Skill.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer({})]],
  ),
)

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

/** The only fields `turnKey` reads off a message are `info.role` and `info.id`.
 *  Cast rather than built in full: a whole User message is twenty fields of
 *  noise, none of which this function looks at. */
const turnMessages = (id: string) =>
  [{ info: { id: MessageID.make(id), role: "user" }, parts: [] }] as unknown as Tool.Context["messages"]

/** A tool context that RECORDS every permission ask, so "asked nobody" is an
 *  assertion and not a reading of the source. */
function makeCtx(session: string, turn: string) {
  const asks: Ask[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make(session),
    messageID: MessageID.make(`msg_${turn}`),
    callID: "sq-call",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: turnMessages(`msg_${turn}`),
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request)
      }),
  }
  return { ctx, asks }
}

const tool = Effect.gen(function* () {
  return yield* (yield* SideQuestTool).init()
})

/** Write a quest file straight to disk, the way an earlier chat would have left
 *  one behind. */
async function seed(
  dir: string,
  n: number,
  input: { title: string; session: string; status?: "open" | "started" | "dismissed" },
) {
  const file = path.join(dir, `SQ-${n}.md`)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    file,
    [
      "---",
      `id: SQ-${n}`,
      `title: ${input.title}`,
      `status: ${input.status ?? "open"}`,
      "created: 2020-01-01T00:00:00.000Z",
      `session: ${input.session}`,
      "---",
      "",
      "## Summary",
      "",
      "seeded",
      "",
      "## Instructions",
      "",
      "seeded",
      "",
    ].join("\n"),
    "utf8",
  )
  return file
}

const listQuests = async (dir: string) =>
  fsp
    .readdir(dir)
    .then((names) => names.sort())
    .catch(() => [] as string[])

afterEach(async () => {
  await disposeAllInstances()
})

describe("side_quest: the record", () => {
  const args = {
    title: "Fold the rail block's overflow guard",
    summary: "The rail block scrolls past its column on wide screens.",
    instructions: "Cap the rail at 720px in rail.css and add a width regression test.",
    rationale: "Noticed while fixing an unrelated selector in the same file.",
  }

  it.instance(
    "writes one SQ file to the agreed contract, returns inline, and asks nobody",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { ctx, asks } = makeCtx("ses_sq_record", "turn1")

        const result = yield* (yield* tool).execute(args, ctx)

        // Inline, and the wording that tells the model not to wait on it.
        expect(result.output).toBe(
          "Side quest recorded: SQ-1 Fold the rail block's overflow guard." +
            " Continue your own work; do not wait for or reference it.",
        )
        // NOTHING was put to a human. A tool that asked would park the turn.
        expect(asks).toEqual([])

        const dir = sidequestsDir(directory)
        expect(yield* Effect.promise(() => listQuests(dir))).toEqual(["SQ-1.md"])
        const text = yield* Effect.promise(() => fsp.readFile(path.join(dir, "SQ-1.md"), "utf8"))
        // LF, and the frontmatter keys in the order the drawer reads them.
        expect(text).not.toContain("\r\n")
        const lines = text.split("\n")
        expect(lines.slice(0, 4)).toEqual(["---", "id: SQ-1", `title: ${args.title}`, "status: open"])
        expect(lines[4]).toMatch(/^created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        expect(lines.slice(5, 7)).toEqual(["session: ses_sq_record", "---"])
        expect(text).toContain(`## Summary\n\n${args.summary}\n`)
        expect(text).toContain(`## Rationale\n\n${args.rationale}\n`)
        expect(text).toContain(`## Instructions\n\n${args.instructions}\n`)
        expect(result.metadata.file).toBe(path.join(dir, "SQ-1.md"))
      }),
    { git: true },
  )

  it.instance(
    "numbers from the highest file on disk, not from how many are open",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const dir = sidequestsDir(directory)
        yield* Effect.promise(() => seed(dir, 2, { title: "older", session: "ses_other", status: "dismissed" }))
        yield* Effect.promise(() => seed(dir, 7, { title: "newer", session: "ses_other", status: "started" }))
        // A file somebody half-edited. It must not wedge the tool, and its
        // NUMBER still counts - reusing SQ-9 would overwrite it.
        yield* Effect.promise(() => fsp.writeFile(path.join(dir, "SQ-9.md"), "no frontmatter here", "utf8"))

        const result = yield* (yield* tool).execute(args, makeCtx("ses_sq_number", "turn1").ctx)

        expect(result.metadata.id).toBe("SQ-10")
        expect(yield* Effect.promise(() => listQuests(dir))).toEqual([
          "SQ-10.md",
          "SQ-2.md",
          "SQ-7.md",
          "SQ-9.md",
        ])
      }),
    { git: true },
  )

  // No `{ git: true }`: a folder with no VCS is the global project, whose
  // worktree is the DRIVE ROOT. A quest written there would be shared by every
  // non-git folder on the machine and invisible to this workspace's drawer.
  it.instance("a workspace with no git repo keeps its quests in its own folder", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance

      const result = yield* (yield* tool).execute(args, makeCtx("ses_sq_nogit", "turn1").ctx)

      expect(result.metadata.file).toBe(path.join(sidequestsDir(directory), "SQ-1.md"))
      expect(yield* Effect.promise(() => listQuests(sidequestsDir(directory)))).toEqual(["SQ-1.md"])
    }),
  )
})

describe("side_quest: the caps", () => {
  const quest = (title: string) => ({
    title,
    summary: "One sentence of what it is.",
    instructions: "What a fresh agent would do first.",
  })

  it.instance(
    "one per turn: the second call in the same turn is refused, the next turn is free",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const built = yield* tool

        const first = yield* built.execute(quest("Rail overflow"), makeCtx("ses_sq_turn", "turn1").ctx)
        expect(first.metadata.id).toBe("SQ-1")

        const second = yield* built.execute(quest("Toolbar focus ring"), makeCtx("ses_sq_turn", "turn1").ctx)
        expect(second.metadata.refused).toBe("turn")
        expect(second.output).toContain("one side quest per turn")

        // A new user message is a new turn, and the budget comes back.
        const later = yield* built.execute(quest("Toolbar focus ring"), makeCtx("ses_sq_turn", "turn2").ctx)
        expect(later.metadata.id).toBe("SQ-2")
        expect(yield* Effect.promise(() => listQuests(sidequestsDir(directory)))).toEqual(["SQ-1.md", "SQ-2.md"])
      }),
    { git: true },
  )

  it.instance(
    "a deleted chat takes its per-turn budget with it",
    () =>
      Effect.gen(function* () {
        // t-fijy8a F9. The budget map kept one entry per session FOREVER, so a
        // deleted chat stayed in it. `Session.remove` calls `forget`; this is
        // that call, and the budget coming back is how it is seen from outside.
        const built = yield* tool
        const first = yield* built.execute(quest("Rail overflow"), makeCtx("ses_sq_forget", "turn1").ctx)
        expect(first.metadata.id).toBe("SQ-1")
        const second = yield* built.execute(quest("Toolbar focus ring"), makeCtx("ses_sq_forget", "turn1").ctx)
        expect(second.metadata.refused).toBe("turn")

        forget("ses_sq_forget")

        const afterDelete = yield* built.execute(quest("Toolbar focus ring"), makeCtx("ses_sq_forget", "turn1").ctx)
        expect(afterDelete.metadata.id).toBe("SQ-2")
      }),
    { git: true },
  )

  it.instance(
    "five open per chat: the sixth is refused and the refusal names the cap",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const dir = sidequestsDir(directory)
        for (let n = 1; n <= MAX_OPEN_PER_CHAT; n++)
          yield* Effect.promise(() => seed(dir, n, { title: `seeded ${n}`, session: "ses_sq_cap" }))
        // A settled quest of this chat's, and another chat's open one: neither
        // is this chat's open work, so neither may push it over the cap.
        yield* Effect.promise(() => seed(dir, 6, { title: "settled", session: "ses_sq_cap", status: "dismissed" }))
        yield* Effect.promise(() => seed(dir, 7, { title: "someone else's", session: "ses_elsewhere" }))

        const refused = yield* (yield* tool).execute(quest("One too many"), makeCtx("ses_sq_cap", "turn1").ctx)

        expect(refused.metadata.refused).toBe("cap")
        expect(refused.output).toContain(`already has ${MAX_OPEN_PER_CHAT} open side quests`)
        // Refused means NOT WRITTEN: no SQ-8 appeared.
        expect(yield* Effect.promise(() => listQuests(dir))).not.toContain("SQ-8.md")
      }),
    { git: true },
  )

  it.instance(
    "the cap counts OPEN files only, so a dismissed one leaves room",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const dir = sidequestsDir(directory)
        for (let n = 1; n <= MAX_OPEN_PER_CHAT; n++)
          yield* Effect.promise(() =>
            seed(dir, n, { title: `seeded ${n}`, session: "ses_sq_room", status: n === 3 ? "dismissed" : "open" }),
          )

        const result = yield* (yield* tool).execute(quest("Room for one more"), makeCtx("ses_sq_room", "turn1").ctx)

        expect(result.metadata.id).toBe("SQ-6")
        expect(result.metadata.open).toBe(MAX_OPEN_PER_CHAT)
      }),
    { git: true },
  )

  it.instance(
    "a duplicate title is refused by the id that already holds it, whoever raised it",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const dir = sidequestsDir(directory)
        yield* Effect.promise(() => seed(dir, 4, { title: "Fold the rail block", session: "ses_elsewhere" }))

        // Same title through different punctuation, case and spacing.
        const refused = yield* (yield* tool).execute(
          quest("  fold THE   rail-block!  "),
          makeCtx("ses_sq_dupe", "turn1").ctx,
        )

        expect(refused.metadata.refused).toBe("duplicate")
        expect(refused.output).toContain("SQ-4 is already open with the same title")
        expect(yield* Effect.promise(() => listQuests(dir))).toEqual(["SQ-4.md"])

        // The cap is one CALL per turn, not one success: a refused call does
        // not buy a retry in the same turn.
        const retry = yield* (yield* tool).execute(quest("Something else entirely"), makeCtx("ses_sq_dupe", "turn1").ctx)
        expect(retry.metadata.refused).toBe("turn")
      }),
    { git: true },
  )

  it.instance(
    "a dismissed title is not a duplicate - the owner said no, the work can come back",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* Effect.promise(() =>
          seed(sidequestsDir(directory), 1, {
            title: "Fold the rail block",
            session: "ses_sq_redo",
            status: "dismissed",
          }),
        )

        const result = yield* (yield* tool).execute(quest("Fold the rail block"), makeCtx("ses_sq_redo", "turn1").ctx)

        expect(result.metadata.id).toBe("SQ-2")
      }),
    { git: true },
  )

  it.instance(
    "a quest with nothing a fresh agent could start from is refused, not written",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const refused = yield* (yield* tool).execute(
          { title: "Something", summary: "  ", instructions: "" },
          makeCtx("ses_sq_empty", "turn1").ctx,
        )

        expect(refused.metadata.refused).toBe("arguments")
        expect(yield* Effect.promise(() => listQuests(sidequestsDir(directory)))).toEqual([])
      }),
    { git: true },
  )
})

describe("side_quest: who may call it", () => {
  const action = (agent: Agent.Info): PermissionV1.Action =>
    Permission.evaluate("side_quest", "*", agent.permission).action

  itAgent.instance("the main agent may raise one and both native sub-agents may not", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      expect(action(yield* agents.get("build"))).toBe("allow")
      expect(action(yield* agents.get("general"))).toBe("deny")
      expect(action(yield* agents.get("explore"))).toBe("deny")
    }),
  )
})

describe("side_quest: the pure parts", () => {
  test("a title matches through case, punctuation and spacing, and keeps its letters", () => {
    expect(normalizeTitle("  Fold THE rail-block!  ")).toBe(normalizeTitle("fold the rail block"))
    // Two different non-ASCII titles must not collapse into one another.
    expect(normalizeTitle("Tel de jaren")).not.toBe(normalizeTitle("Tel de dagen"))
    // Written as escapes so this file stays ASCII on disk: a CP1252 round trip
    // through an editor turns a literal umlaut into mojibake and the assertion
    // would then pass for the wrong reason.
    expect(normalizeTitle("Z\u00e4hle die Jahre")).not.toBe(normalizeTitle("Z\u00e4hle die Tage"))
    // t-fijy8a F9. A title with no letters or digits at all used to normalise
    // to "", so the second symbol-only quest was refused as a duplicate of the
    // first. Escapes, not literals: this file stays ASCII on disk.
    expect(normalizeTitle("\u{1F680}")).not.toBe(normalizeTitle("\u{1F41B}"))
    expect(normalizeTitle("\u{1F680}")).not.toBe("")
    // ...and the same symbol twice is still one quest.
    expect(normalizeTitle(" \u{1F680} ")).toBe(normalizeTitle("\u{1F680}"))
  })

  it.instance("two writers claiming the SAME next number produce SQ-N and SQ-N+1, nothing overwritten", () =>
    Effect.gen(function* () {
      // t-fijy8a F9. The in-process lock does not reach a SECOND engine on the
      // same workspace, and both read the same highest number. This is that
      // race with the lock out of the way: two claims, one folder, no ordering
      // between them.
      const dir = sidequestsDir((yield* TestInstance).directory)
      yield* Effect.promise(() => seed(dir, 1, { title: "already here", session: "ses_old" }))

      const [first, second] = yield* Effect.all(
        [claimQuestFile(dir, (id) => `body of ${id}`), claimQuestFile(dir, (id) => `body of ${id}`)],
        { concurrency: "unbounded" },
      )

      expect([first.id, second.id].sort()).toEqual(["SQ-2", "SQ-3"])
      // Both files are on disk with their OWN content: the loser re-numbered
      // rather than replacing the winner.
      for (const claim of [first, second]) {
        expect(yield* Effect.promise(() => fsp.readFile(claim.file, "utf8"))).toBe(`body of ${claim.id}`)
      }
      const names = yield* Effect.promise(() => fsp.readdir(dir))
      expect(names.sort()).toEqual(["SQ-1.md", "SQ-2.md", "SQ-3.md"])
    }),
  )

  it.instance("gives up rather than spinning when it can never claim a number", () =>
    Effect.gen(function* () {
      const dir = sidequestsDir((yield* TestInstance).directory)
      const exit = yield* claimQuestFile(dir, () => "never written", 0).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* Effect.promise(() => fsp.readdir(dir))).toEqual([])
    }),
  )

  test("numbering takes the highest id on disk and ignores anything else in the folder", () => {
    expect(nextNumber([])).toBe(1)
    expect(nextNumber(["SQ-1.md", "SQ-12.md", "SQ-3.md"])).toBe(13)
    expect(nextNumber(["notes.md", "SQ-2.md", "SQ-x.md"])).toBe(3)
  })

  test("the rationale HEADING is absent when there is no rationale", () => {
    const text = questFile({
      id: "SQ-1",
      title: "t",
      summary: "s",
      instructions: "i",
      created: "2020-01-01T00:00:00.000Z",
      session: "ses_x",
    })
    expect(text).not.toContain("## Rationale")
    expect(text.indexOf("## Summary")).toBeLessThan(text.indexOf("## Instructions"))
  })

  test("the turn is the user message being answered, not the per-step assistant message", () => {
    expect(turnKey({ messageID: MessageID.make("msg_step_2"), messages: turnMessages("msg_user_1") })).toBe(
      "msg_user_1",
    )
    // No user message at all: fall back to the message, which is stricter.
    expect(turnKey({ messageID: MessageID.make("msg_step_2"), messages: [] })).toBe("msg_step_2")
  })
})

// t-fijeld. `metadata.open` means THIS CHAT's open count on every branch; the
// duplicate refusal used to report the workspace-wide number.
describe("side_quest: metadata.open has one meaning", () => {
  it.instance(
    "a duplicate refusal reports this chat's open count, not the workspace's",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const dir = sidequestsDir(directory)
        yield* Effect.promise(() => seed(dir, 1, { title: "Fold the rail block", session: "ses_elsewhere" }))
        yield* Effect.promise(() => seed(dir, 2, { title: "Another one", session: "ses_elsewhere" }))
        yield* Effect.promise(() => seed(dir, 3, { title: "Mine already", session: "ses_sq_open" }))

        const refused = yield* (yield* tool).execute(
          { title: "fold the rail block", summary: "Same work again.", instructions: "What a fresh agent would do first." },
          makeCtx("ses_sq_open", "turn1").ctx,
        )
        expect(refused.metadata.refused).toBe("duplicate")
        // Three open in the workspace, one of them this chat's.
        expect(refused.metadata.open).toBe(1)
      }),
    { git: true },
  )
})
