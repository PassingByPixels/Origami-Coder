import { describe, expect } from "bun:test"
import os from "os"
import path from "path"
import fsp from "fs/promises"
import { execFileSync } from "child_process"
import { Effect, Layer } from "effect"
import { PermissionV1 } from "@origami/core/v1/permission"
import { FSUtil } from "@origami/core/fs-util"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import {
  BoardCreateTool,
  BoardRegisterTool,
  BoardReposTool,
  BoardTicketsTool,
  BoardUpdateTool,
  BoardWorktreesTool,
} from "../../src/tool/board"
import { fmSet, mergeReposText, newTicketFile, parseRepos } from "../../src/tool/board-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The board tools capture FSUtil at define time and resolve the instance inside
// execute, so the stack is FSUtil plus the Tool.define wrapper's own Truncate +
// Agent. No session store and no question service — board_* asks through
// ctx.ask, which the literal ctx below supplies. Git is here for the two tools
// that shell out (board_register's rev-parse, board_worktrees' worktree list).
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([FSUtil.node, Truncate.node, Agent.node, CrossSpawnSpawner.node, InstanceStore.node, Git.node]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

type Ask = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

/** A literal tool context that RECORDS every permission ask for assertion. */
function makeCtx() {
  const asks: Ask[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_board-test"),
    messageID: MessageID.make("msg_board-test"),
    callID: "board-call",
    agent: "heron",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        asks.push(request)
      }),
  }
  return { ctx, asks }
}

const tools = Effect.gen(function* () {
  return {
    repos: yield* (yield* BoardReposTool).init(),
    tickets: yield* (yield* BoardTicketsTool).init(),
    create: yield* (yield* BoardCreateTool).init(),
    update: yield* (yield* BoardUpdateTool).init(),
    register: yield* (yield* BoardRegisterTool).init(),
    worktrees: yield* (yield* BoardWorktreesTool).init(),
  }
})

/** Run a real git command in a test tree. Sync and throwing — a broken fixture
 *  must fail the test loudly, not leave it asserting against a half-built repo. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString()
}

/**
 * A scratch directory OUTSIDE every git repo, removed when the scope closes.
 * The instance tmpdir cannot stand in: it IS a repo under `{ git: true }`, so
 * anything under it answers `rev-parse` and can never exercise the non-git path.
 */
const scratch = (label: string) =>
  Effect.gen(function* () {
    const made = yield* Effect.promise(() => fsp.mkdtemp(path.join(os.tmpdir(), `origami-board-${label}-`)))
    // realpath: macOS hands out /var/... for a /private/var/... directory, and
    // git answers with the real one, so an unresolved path never compares equal.
    const dir = yield* Effect.promise(() => fsp.realpath(made))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fsp.rm(made, { recursive: true, force: true }).catch(() => undefined)),
    )
    return dir
  })

/**
 * Point `~` at a subdirectory of the test instance for the duration of the
 * test, so `Global.Path.origami` (a getter) resolves repos.json inside the
 * scratch tree instead of the shared preload home.
 */
const useHome = (dir: string) =>
  Effect.gen(function* () {
    const home = path.join(dir, "home")
    const previous = process.env.ORIGAMI_TEST_HOME
    process.env.ORIGAMI_TEST_HOME = home
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.env.ORIGAMI_TEST_HOME = previous
      }),
    )
    return home
  })

/** Write `~/.origami/repos.json` naming `dir` as the repo `name`. `extra` adds
 *  fields to that one entry — `primary`, or a key the engine has never heard of. */
async function registerRepo(home: string, name: string, root: string, extra: Record<string, unknown> = {}) {
  const file = path.join(home, ".origami", "repos.json")
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(
    file,
    JSON.stringify({ version: 1, repos: [{ root, name, workspace: false, addedAt: 0, ...extra }] }, null, 2),
    "utf8",
  )
  return file
}

/** Write a whole registry document verbatim — for the merge-preservation tests. */
async function writeRegistry(home: string, doc: unknown) {
  const file = path.join(home, ".origami", "repos.json")
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8")
  return file
}

const readRegistry = async (home: string) =>
  JSON.parse(await fsp.readFile(path.join(home, ".origami", "repos.json"), "utf8"))

async function writeTicket(root: string, id: string, text: string) {
  const file = path.join(root, ".origami", "tickets", `${id}.md`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, "utf8")
  return file
}

const read = (file: string) => fsp.readFile(file, "utf8")

const exists = (file: string) =>
  fsp
    .stat(file)
    .then(() => true)
    .catch(() => false)

/** The file path a tool reported, or a loud failure — never a silent "". */
function fileOf(result: { metadata: { file?: string } }): string {
  if (!result.metadata.file) throw new Error("tool result carried no file path")
  return result.metadata.file
}

/**
 * A hand-authored ticket exactly as §2 documents it — inline comment on
 * `priority`, quoted-empty `assignee`, plus two keys the engine has never heard
 * of (`sprint`, `blocked-by`) that a rewrite must not eat.
 */
const SEEDED = [
  "---",
  "id: t-seed01",
  "title: Scroll block needs a max-width",
  "status: todo",
  "priority: normal        # low | normal | high",
  "labels: [ui]",
  "assignee: ''",
  "created: 2020-01-01T00:00:00Z",
  "updated: 2020-01-01T00:00:00Z",
  "fold: ''",
  "branch: ''",
  "sprint: alpha",
  "blocked-by: [t-other1]",
  "---",
  "",
  "Block grows past the column on wide screens.",
  "",
  "## Acceptance",
  "",
  "- [x] block never exceeds 720px",
  "- [ ] centred at every width",
  "- [ ] no horizontal scrollbar",
  "",
  "## Log",
  "",
  "- 2020-01-01T00:00:00Z passing: created via quick-add",
  "",
].join("\n")

/** A ticket written by the SLIM template (§12 item 5): only id/title/status/
 *  priority/created/updated + body — no labels/assignee/fold/branch line was
 *  ever written. */
const MINIMAL = [
  "---",
  "id: t-min001",
  "title: Minimal ticket, no scaffolding",
  "status: todo",
  "priority: normal",
  "created: 2020-01-01T00:00:00Z",
  "updated: 2020-01-01T00:00:00Z",
  "---",
  "",
  "Body prose only, no other keys ever written.",
  "",
  "## Acceptance",
  "",
  "- [ ] one thing",
  "- [x] another",
  "",
].join("\n")

describe("fmSet / newTicketFile (§12 item 5 slim template)", () => {
  it.effect(
    "newTicketFile writes only the slim keys, and labels only when given",
    Effect.sync(() => {
      const idea = newTicketFile({ id: "t-1", title: "Bare idea", status: "triage", priority: "normal", labels: [], who: "heron" })
      for (const missing of ["labels:", "assignee:", "fold:", "branch:"]) expect(idea).not.toContain(missing)
      for (const present of ["id: t-1", "title: Bare idea", "status: triage", "priority: normal", "created:", "updated:"])
        expect(idea).toContain(present)

      const specd = newTicketFile({ id: "t-2", title: "Spec'd", status: "todo", priority: "high", labels: ["ui"], who: "heron" })
      expect(specd).toContain("labels: [ui]")
      for (const missing of ["assignee:", "fold:", "branch:"]) expect(specd).not.toContain(missing)
    }),
  )

  it.effect(
    "inserts a missing key right after updated, and keeps TAIL_KEYS order across repeated inserts",
    Effect.sync(() => {
      const base = ["id: t-1", "title: T", "status: todo", "priority: normal", "created: c", "updated: u"]

      const withAssignee = fmSet(base, "assignee", "heron")
      // assignee is the only tail key here — it lands as the very last line.
      expect(withAssignee).toEqual([...base, "assignee: heron"])

      // labels sorts BEFORE assignee in TAIL_KEYS, so it must be inserted
      // BEFORE the assignee line already there, not appended after it.
      const withLabels = fmSet(withAssignee, "labels", "[ui]")
      expect(withLabels).toEqual([...base, "labels: [ui]", "assignee: heron"])

      // fold/branch sort AFTER assignee, so they append at the very end, in order.
      const withFold = fmSet(fmSet(withLabels, "fold", "w-1"), "branch", "origami/t-1-x")
      expect(withFold).toEqual([...base, "labels: [ui]", "assignee: heron", "fold: w-1", "branch: origami/t-1-x"])
    }),
  )

  it.effect(
    "updates an EXISTING key in place, at its own line, never moving or duplicating it",
    Effect.sync(() => {
      const fm = ["id: t-1", "title: T", "status: todo", "priority: normal", "labels: []", "assignee: ''", "created: c", "updated: u", "fold: ''", "branch: ''"]
      const next = fmSet(fm, "assignee", "heron")
      expect(next).toHaveLength(fm.length) // no line added
      expect(next[5]).toBe("assignee: heron") // same position assignee already held
      expect(next[4]).toBe("labels: []") // neighbours untouched
      expect(next[6]).toBe("created: c")
    }),
  )

  it.effect(
    "skips PAST an unknown key rather than displacing it",
    Effect.sync(() => {
      const fm = ["id: t-1", "title: T", "status: todo", "priority: normal", "created: c", "updated: u", "sprint: alpha"]
      const withFold = fmSet(fm, "fold", "w-1")
      expect(withFold).toEqual([...fm, "fold: w-1"]) // sprint keeps its line; fold lands after it
    }),
  )
})

describe("parseRepos (displayName, display-only)", () => {
  it.effect(
    "carries an optional displayName through, and omits the key entirely when absent",
    Effect.sync(() => {
      const doc = JSON.stringify({
        repos: [
          { root: "/a", name: "a", displayName: "Pretty A" },
          { root: "/b", name: "b" },
        ],
      })
      const [a, b] = parseRepos(doc)
      expect(a.displayName).toBe("Pretty A")
      expect(Object.prototype.hasOwnProperty.call(b, "displayName")).toBe(false)
    }),
  )

  it.effect(
    "resolveRepo-relevant identity (`name`) is untouched by a displayName override",
    Effect.sync(() => {
      const [a] = parseRepos(JSON.stringify({ repos: [{ root: "/a", name: "aetheron-darklands", displayName: "Aetheron — The Darklands" }] }))
      expect(a.name).toBe("aetheron-darklands")
    }),
  )
})

describe("mergeReposText (the registry merge rule)", () => {
  it.effect(
    "changes only the entry it was given and leaves every other byte of meaning alone",
    Effect.sync(() => {
      const before = {
        version: 1,
        lastOpened: "keep-me",
        repos: [
          { root: "/a", name: "a", workspace: false, addedAt: 1, sprint: "alpha" },
          { root: "/b", name: "b", workspace: true, addedAt: 2 },
        ],
      }
      const after = JSON.parse(mergeReposText(JSON.stringify(before, null, 2), [{ root: "/b", primary: "/b/wt" }]))

      expect(after.lastOpened).toBe("keep-me")
      expect(after.repos[0]).toEqual(before.repos[0])
      expect(after.repos[1]).toEqual({ ...before.repos[1], primary: "/b/wt" })
      expect(after.repos).toHaveLength(2)
    }),
  )

  it.effect(
    "a malformed file reads as no repos rather than destroying the keys around it",
    Effect.sync(() => {
      // Broken JSON: nothing can be preserved, so start clean rather than throw.
      const fromJunk = JSON.parse(mergeReposText("{ not json", [{ root: "/a", name: "a", workspace: false, addedAt: 5 }]))
      expect(fromJunk).toEqual({ version: 1, repos: [{ root: "/a", name: "a", workspace: false, addedAt: 5 }] })

      // Readable object, unusable `repos`: the surrounding keys DO survive.
      const fromBadList = JSON.parse(
        mergeReposText(JSON.stringify({ version: 1, lastOpened: "keep-me", repos: "nonsense" }), [
          { root: "/a", name: "a", workspace: false, addedAt: 5 },
        ]),
      )
      expect(fromBadList.lastOpened).toBe("keep-me")
      expect(fromBadList.repos).toEqual([{ root: "/a", name: "a", workspace: false, addedAt: 5 }])
    }),
  )

  it.effect(
    "keys the same root case-insensitively on Windows, so one repo never gets two cards",
    Effect.sync(() => {
      const before = JSON.stringify({ version: 1, repos: [{ root: "C:\\Repos\\X", name: "x", workspace: false, addedAt: 1 }] })
      const after = JSON.parse(mergeReposText(before, [{ root: "c:\\repos\\x", primary: "C:\\Repos\\X.wt\\y" }]))
      // One entry either way; on Windows it is the SAME entry, updated in place.
      expect(after.repos).toHaveLength(process.platform === "win32" ? 1 : 2)
      if (process.platform === "win32") {
        expect(after.repos[0].root).toBe("C:\\Repos\\X") // the stored spelling wins
        expect(after.repos[0].primary).toBe("C:\\Repos\\X.wt\\y")
      }
    }),
  )

  it.effect(
    "writes the shape the extension reads back: version 1, 2-space JSON, trailing newline",
    Effect.sync(() => {
      const text = mergeReposText(undefined, [{ root: "/a", name: "a", workspace: false, addedAt: 5 }])
      expect(text.endsWith("\n")).toBe(true)
      expect(text).toContain('\n  "version": 1')
      expect(JSON.parse(text).version).toBe(1)
    }),
  )
})

describe("board tools", () => {
  it.instance(
    "a missing repos.json reads as an empty board, and reads never ask permission",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* useHome(directory)
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.repos.execute({}, ctx)

        expect(result.metadata.repos).toBe(0)
        expect(result.output).toContain("No repos are registered")
        expect(asks).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    'repo "." resolves to the session\'s own worktree even with no registry',
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* useHome(directory)
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const created = yield* tool.create.execute({ repo: ".", title: "Wire the board" }, ctx)

        const file = fileOf(created)
        expect(file).toBe(path.join(directory, ".origami", "tickets", `${created.metadata.id}.md`))
        expect(yield* Effect.promise(() => read(file))).toContain("title: Wire the board")
        // A write DOES gate on permission, under the "board" key.
        expect(asks.map((ask) => ask.permission)).toEqual(["board"])
      }),
    { git: true },
  )

  it.instance('repo "." is refused in a non-git workspace instead of writing to the drive root', () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* useHome(directory)
      const tool = yield* tools
      const { ctx, asks } = makeCtx()

      // No { git: true }: the worktree resolves to "/", so "." would put
      // tickets in C:\.origami\tickets — shared with every other non-git folder.
      const result = yield* tool.create.execute({ repo: ".", title: "would land at the drive root" }, ctx)

      expect(result.title).toBe("board_create: refused")
      expect(result.output).toContain("is not a git repo")
      expect(asks).toEqual([])
      expect(yield* Effect.promise(() => exists(path.join(path.parse(directory).root, ".origami", "tickets")))).toBe(
        false,
      )
    }),
  )

  it.instance(
    "create lands in triage without acceptance and in todo with it",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const idea = yield* tool.create.execute({ repo: "demo", title: "Maybe a dark theme" }, ctx)
        const spec = yield* tool.create.execute(
          {
            repo: "demo",
            title: "Scroll block max-width",
            body: "Wide screens overflow.",
            acceptance: ["block never exceeds 720px", "centred at every width"],
            priority: "high",
            labels: ["ui"],
          },
          ctx,
        )

        expect(idea.metadata.status).toBe("triage")
        expect(spec.metadata.status).toBe("todo")

        const ideaText = yield* Effect.promise(() => read(fileOf(idea)))
        expect(ideaText).toContain("status: triage")
        expect(ideaText).not.toContain("## Acceptance")
        // Slim template (§12 item 5): a bare idea never gets blank scaffolding.
        for (const missing of ["labels:", "assignee:", "fold:", "branch:"]) expect(ideaText).not.toContain(missing)

        const specText = yield* Effect.promise(() => read(fileOf(spec)))
        expect(specText).toContain("status: todo")
        expect(specText).toContain("priority: high")
        expect(specText).toContain("labels: [ui]")
        expect(specText).toContain("- [ ] block never exceeds 720px")
        // Given labels but never an assignee/fold/branch — only labels is real.
        for (const missing of ["assignee:", "fold:", "branch:"]) expect(specText).not.toContain(missing)
        // The Log opens with a real entry, so the file is never a bare stub.
        expect(specText).toContain("heron: created via board_create")
        // Ids are the documented shape: t- plus six base36 characters.
        expect(String(spec.metadata.id)).toMatch(/^t-[0-9a-z]{6}$/)
        expect(spec.metadata.id).not.toBe(idea.metadata.id)
      }),
    { git: true },
  )

  it.instance(
    "an unknown frontmatter key survives an update",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const file = yield* Effect.promise(() => writeTicket(directory, "t-seed01", SEEDED))
        const tool = yield* tools
        const { ctx } = makeCtx()

        yield* tool.update.execute({ repo: "demo", id: "t-seed01", status: "closed", title: "Renamed" }, ctx)

        const text = yield* Effect.promise(() => read(file))
        // The keys the engine does not model are byte-identical, comment and all.
        expect(text).toContain("sprint: alpha")
        expect(text).toContain("blocked-by: [t-other1]")
        expect(text).toContain("priority: normal        # low | normal | high")
        // …and the keys it does model changed, in place.
        expect(text).toContain("status: closed")
        expect(text).toContain("title: Renamed")
        expect(text).not.toContain("updated: 2020-01-01T00:00:00Z")
        // Body untouched by a frontmatter-only edit.
        expect(text).toContain("Block grows past the column on wide screens.")
      }),
    { git: true },
  )

  it.instance(
    "a claim is refused when somebody else already holds the ticket",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const file = yield* Effect.promise(() =>
          writeTicket(directory, "t-seed01", SEEDED.replace("assignee: ''", "assignee: nyx")),
        )
        const before = yield* Effect.promise(() => read(file))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const taken = yield* tool.update.execute({ repo: "demo", id: "t-seed01", claim: "heron" }, ctx)

        // A refusal STRING, not a thrown error — the model has to be able to
        // read it and pick another ticket.
        expect(taken.title).toBe("board_update: refused")
        expect(taken.output).toContain("already claimed by @nyx")
        // The file is byte-identical: a refused claim writes NOTHING, not even
        // the `updated` stamp.
        expect(yield* Effect.promise(() => read(file))).toBe(before)
        // A doomed claim must not cost the user a permission prompt either.
        expect(asks).toEqual([])

        // Re-claiming under the SAME name is a no-op, not a conflict.
        const kept = yield* tool.update.execute({ repo: "demo", id: "t-seed01", claim: "nyx" }, ctx)
        expect(kept.title).toBe("board_update: t-seed01")
        expect(kept.output).toContain("claimed by @nyx")
        expect(asks.length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "an agent cannot set a lifecycle status",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const file = yield* Effect.promise(() => writeTicket(directory, "t-seed01", SEEDED))
        const before = yield* Effect.promise(() => read(file))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const refused = yield* tool.update.execute({ repo: "demo", id: "t-seed01", status: "in_progress" }, ctx)
        const allowed = yield* tool.update.execute({ repo: "demo", id: "t-seed01", status: "triage" }, ctx)

        expect(refused.title).toBe("board_update: refused")
        expect(refused.output).toContain("stamped by the fold lifecycle")
        expect(allowed.output).toContain("status triage")
        expect(before).toContain("status: todo")
        expect(yield* Effect.promise(() => read(file))).toContain("status: triage")
        // Only the ALLOWED update asked.
        expect(asks.length).toBe(1)
      }),
    { git: true },
  )

  it.instance(
    "a comment appends to the Log and bumps updated",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const file = yield* Effect.promise(() => writeTicket(directory, "t-seed01", SEEDED))
        const tool = yield* tools
        const { ctx } = makeCtx()

        yield* tool.update.execute({ repo: "demo", id: "t-seed01", comment: "picked this up" }, ctx)

        const lines = (yield* Effect.promise(() => read(file))).split("\n")
        const log = lines.indexOf("## Log")
        const entries = lines.slice(log + 1).filter((line) => line.startsWith("- "))
        // Appended AFTER the existing entry, so the log stays chronological.
        expect(entries.length).toBe(2)
        expect(entries[0]).toBe("- 2020-01-01T00:00:00Z passing: created via quick-add")
        expect(entries[1]).toMatch(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z heron: picked this up$/)

        const updated = lines.find((line) => line.startsWith("updated: "))
        expect(updated).toBeDefined()
        expect(updated).not.toBe("updated: 2020-01-01T00:00:00Z")
        // created is NOT touched by an update.
        expect(lines).toContain("created: 2020-01-01T00:00:00Z")
      }),
    { git: true },
  )

  it.instance(
    "acceptance boxes are counted, and a rewrite keeps the ticks it was not told to change",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        yield* Effect.promise(() => writeTicket(directory, "t-seed01", SEEDED))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const listed = yield* tool.tickets.execute({ repo: "demo" }, ctx)
        // 1 of 3 ticked, and the inline `# low | normal | high` comment did NOT
        // leak into the parsed priority.
        expect(listed.output).toContain("t-seed01  todo  [normal]  Scroll block needs a max-width  1/3")

        const ticked = yield* tool.update.execute(
          {
            repo: "demo",
            id: "t-seed01",
            acceptance: ["block never exceeds 720px", "[x] centred at every width", "no horizontal scrollbar"],
          },
          ctx,
        )

        expect(ticked.output).toContain("acceptance 2/3")
        const full = yield* tool.tickets.execute({ repo: "demo", id: "t-seed01" }, ctx)
        expect(full.output).toContain("- [x] block never exceeds 720px")
        expect(full.output).toContain("- [x] centred at every width")
        expect(full.output).toContain("- [ ] no horizontal scrollbar")
      }),
    { git: true },
  )

  it.instance(
    "a malformed ticket is surfaced on the board, not dropped",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        yield* Effect.promise(() => writeTicket(directory, "t-seed01", SEEDED))
        yield* Effect.promise(() => writeTicket(directory, "t-broke1", "no frontmatter here, just prose\n"))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const listed = yield* tool.tickets.execute({ repo: "demo" }, ctx)
        const counted = yield* tool.repos.execute({}, ctx)

        expect(listed.metadata.tickets).toBe(2)
        expect(listed.output).toContain("t-broke1  MALFORMED (no frontmatter block)")
        expect(listed.output).toContain("t-seed01")
        expect(counted.output).toContain("malformed 1")

        // And a rewrite of a malformed file is refused rather than attempted.
        const refused = yield* tool.update.execute({ repo: "demo", id: "t-broke1", comment: "fix me" }, ctx)
        expect(refused.title).toBe("board_update: refused")
        expect(refused.output).toContain("malformed")
      }),
    { git: true },
  )

  it.instance(
    "an unregistered repo name is refused with the list of known repos",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.create.execute({ repo: "nope", title: "goes nowhere" }, ctx)

        expect(result.output).toContain('no repo "nope"')
        expect(result.output).toContain("Registered: demo")
        expect(asks).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "a minimal-format ticket (§12 item 5) defaults labels/assignee/fold/branch, and its head line counts acceptance",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        yield* Effect.promise(() => writeTicket(directory, "t-min001", MINIMAL))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const full = yield* tool.tickets.execute({ repo: "demo", id: "t-min001" }, ctx)
        // No crash on the missing keys, and the head line's optional bits
        // (@assignee, labels:, fold:) never show because they default absent.
        expect(full.output).toContain("t-min001  todo  [normal]  Minimal ticket, no scaffolding  1/2")
        expect(full.output).not.toContain("@")
        expect(full.output).not.toContain("labels:")
        expect(full.output).not.toContain("fold:")

        const listed = yield* tool.tickets.execute({ repo: "demo" }, ctx)
        expect(listed.output).toContain("t-min001")
      }),
    { git: true },
  )

  it.instance(
    "board_update on a minimal ticket INSERTS assignee/labels after updated, in TAIL_KEYS order",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const file = yield* Effect.promise(() => writeTicket(directory, "t-min001", MINIMAL))
        const tool = yield* tools
        const { ctx } = makeCtx()

        yield* tool.update.execute({ repo: "demo", id: "t-min001", claim: "heron" }, ctx)
        const afterClaim = (yield* Effect.promise(() => read(file))).split("\n")
        // The claim also bumps `updated:` to a fresh stamp, so match the LINE,
        // not the (now stale) 2020 value MINIMAL was seeded with.
        const updatedAt = afterClaim.findIndex((line) => line.startsWith("updated:"))
        expect(afterClaim.indexOf("assignee: heron")).toBe(updatedAt + 1)

        // labels sorts BEFORE assignee: inserting it now must land ABOVE the
        // assignee line the claim just added, not tacked on after it.
        yield* tool.update.execute({ repo: "demo", id: "t-min001", labels: ["ui"] }, ctx)
        const afterLabels = (yield* Effect.promise(() => read(file))).split("\n")
        const labelsAt = afterLabels.indexOf("labels: [ui]")
        expect(labelsAt).toBeGreaterThan(-1)
        expect(labelsAt).toBeLessThan(afterLabels.indexOf("assignee: heron"))
      }),
    { git: true },
  )

  it.instance(
    "a first claim on an old-format ticket updates the existing blank line in place",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const file = yield* Effect.promise(() => writeTicket(directory, "t-seed01", SEEDED))
        const before = (yield* Effect.promise(() => read(file))).split("\n")
        const tool = yield* tools
        const { ctx } = makeCtx()

        yield* tool.update.execute({ repo: "demo", id: "t-seed01", claim: "heron" }, ctx)

        const after = (yield* Effect.promise(() => read(file))).split("\n")
        const assigneeAt = after.findIndex((line) => line.startsWith("assignee:"))
        // The blank line was already on disk at this exact position — a first
        // claim edits it in place, it does not insert a new line elsewhere.
        expect(assigneeAt).toBe(before.findIndex((line) => line.startsWith("assignee:")))
        expect(after[assigneeAt]).toBe("assignee: heron")
        expect(after.length).toBe(before.length)
      }),
    { git: true },
  )
})

// ========================== primary checkout =============================
//
// A repo may own several checkouts (worktrees). ONE of them holds the tickets:
// `primary`, absent = the registered root. A repo named BY NAME resolves to
// that checkout; repo:"." never does — a fold session reads and writes tickets
// in its OWN checkout and the apply step carries them back.

describe("primary checkout", () => {
  it.instance(
    "a repo resolved BY NAME does ticket IO in its primary checkout, not the registered root",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const primary = path.join(directory, "primary")
        yield* Effect.promise(() => fsp.mkdir(primary, { recursive: true }))
        yield* Effect.promise(() => registerRepo(home, "demo", directory, { primary }))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const created = yield* tool.create.execute({ repo: "demo", title: "lands in the primary" }, ctx)

        expect(fileOf(created)).toBe(path.join(primary, ".origami", "tickets", `${created.metadata.id}.md`))
        // …and NOTHING was written under the registered root.
        expect(yield* Effect.promise(() => exists(path.join(directory, ".origami", "tickets")))).toBe(false)

        // The read path follows it too, or the ticket the tool just made is invisible.
        const listed = yield* tool.tickets.execute({ repo: "demo" }, ctx)
        expect(listed.output).toContain(String(created.metadata.id))

        // And an update finds it.
        const updated = yield* tool.update.execute(
          { repo: "demo", id: String(created.metadata.id), comment: "still here" },
          ctx,
        )
        expect(updated.output).toContain("logged a comment")
      }),
    { git: true },
  )

  it.instance(
    'repo "." keeps writing into the session\'s own checkout even when the entry names a primary',
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const primary = path.join(directory, "primary")
        yield* Effect.promise(() => fsp.mkdir(primary, { recursive: true }))
        // The SESSION's own worktree is the registered root, and its tickets
        // are owned by another checkout. A fold session must still write here:
        // the apply step is what carries the file back.
        yield* Effect.promise(() => registerRepo(home, "demo", directory, { primary }))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const created = yield* tool.create.execute({ repo: ".", title: "stays in this checkout" }, ctx)

        expect(fileOf(created)).toBe(path.join(directory, ".origami", "tickets", `${created.metadata.id}.md`))
        expect(yield* Effect.promise(() => exists(path.join(primary, ".origami", "tickets")))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "a primary that is not on disk is refused, not silently created",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const typo = path.join(directory, "primry")
        yield* Effect.promise(() => registerRepo(home, "demo", directory, { primary: typo }))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.create.execute({ repo: "demo", title: "must not land in a typo" }, ctx)

        expect(result.title).toBe("board_create: refused")
        expect(result.output).toContain(typo)
        expect(asks).toEqual([])
        expect(yield* Effect.promise(() => exists(typo))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "board_repos names the primary when it differs from the registered root, and counts its tickets",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const primary = path.join(directory, "primary")
        yield* Effect.promise(() => writeTicket(primary, "t-seed01", SEEDED))
        yield* Effect.promise(() => registerRepo(home, "demo", directory, { primary }))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const listed = yield* tool.repos.execute({}, ctx)

        expect(listed.output).toContain(primary)
        expect(listed.output).toContain("todo 1")
      }),
    { git: true },
  )
})

// ============================ board_register =============================
//
// Registering is the one board write that is NOT a ticket, so it carries its
// own hazards: never nest a repo inside a repo, never put one repository on
// the board twice under two checkouts, and never rewrite the registry whole —
// merge into it, because the extension owns entries and fields the engine has
// never heard of.

describe("board_register", () => {
  it.instance(
    "refuses a folder INSIDE a repo and names the root to register instead",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => fsp.mkdir(path.join(directory, "packages", "thing"), { recursive: true }))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        // Relative, so this also pins the resolution rule: against the session worktree.
        const result = yield* tool.register.execute({ path: "packages/thing" }, ctx)

        expect(result.title).toBe("board_register: refused")
        expect(result.output).toContain("inside the repo at")
        expect(result.output).toContain(directory)
        expect(asks).toEqual([])
        expect(yield* Effect.promise(() => exists(path.join(home, ".origami", "repos.json")))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "refuses a path that is not on disk",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        yield* useHome(directory)
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.register.execute({ path: path.join(directory, "nowhere") }, ctx)

        expect(result.title).toBe("board_register: refused")
        expect(result.output).toContain("no folder")
        expect(asks).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "refuses a non-git folder, and says init:true is the way in",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const plain = yield* scratch("plain")
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.register.execute({ path: plain }, ctx)

        expect(result.title).toBe("board_register: refused")
        expect(result.output).toContain("not a git repo")
        expect(result.output).toContain("init: true")
        expect(asks).toEqual([])
        expect(yield* Effect.promise(() => exists(path.join(plain, ".git")))).toBe(false)
        expect(yield* Effect.promise(() => exists(path.join(home, ".origami", "repos.json")))).toBe(false)
      }),
    { git: true },
  )

  it.instance(
    "init:true asks under the board permission, runs git init, then registers",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const plain = yield* scratch("fresh")
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.register.execute({ path: plain, name: "fresh", init: true }, ctx)

        expect(result.title).toBe("board_register: fresh")
        expect(asks.map((ask) => ask.permission)).toEqual(["board"])
        expect(yield* Effect.promise(() => exists(path.join(plain, ".git")))).toBe(true)
        const doc = yield* Effect.promise(() => readRegistry(home))
        expect(doc.repos).toHaveLength(1)
        expect(doc.repos[0].name).toBe("fresh")
        expect(doc.repos[0].root).toBe(plain)
        expect(doc.repos[0].workspace).toBe(false)
        expect(typeof doc.repos[0].addedAt).toBe("number")
      }),
    { git: true },
  )

  it.instance(
    "refuses a SECOND checkout of a repository already on the board",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const file = yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const before = yield* Effect.promise(() => read(file))
        const wt = path.join(directory, "wt")
        yield* Effect.sync(() => git(directory, "worktree", "add", "-b", "feature", wt))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        // A linked worktree IS its own toplevel, so the nest check passes it —
        // only --git-common-dir can tell it is the same repository.
        const result = yield* tool.register.execute({ path: wt }, ctx)

        expect(result.title).toBe("board_register: refused")
        expect(result.output).toContain("already on the board as 'demo'")
        expect(result.output).toContain("primary")
        expect(asks).toEqual([])
        expect(yield* Effect.promise(() => read(file))).toBe(before)
      }),
    { git: true },
  )

  it.instance(
    "registering an already-registered root is a friendly no-op that reports the entry",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const file = yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const before = yield* Effect.promise(() => read(file))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.register.execute({ path: directory, name: "renamed" }, ctx)

        expect(result.output).toContain("demo")
        expect(result.output).toContain("already")
        // No write, so no permission prompt and no re-dated addedAt.
        expect(asks).toEqual([])
        expect(yield* Effect.promise(() => read(file))).toBe(before)
      }),
    { git: true },
  )

  it.instance(
    "a register MERGES: other entries, their unknown fields, and unknown top-level keys all survive",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const foreign = {
          root: path.join(path.parse(directory).root, "some", "foreign", "repo"),
          name: "foreign",
          workspace: true,
          addedAt: 7,
          displayName: "Foreign",
          sprint: "alpha",
        }
        yield* Effect.promise(() => writeRegistry(home, { version: 1, lastOpened: "keep-me", repos: [foreign] }))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const result = yield* tool.register.execute({ path: directory, name: "demo" }, ctx)

        expect(result.title).toBe("board_register: demo")
        const doc = yield* Effect.promise(() => readRegistry(home))
        // The top-level key the engine has never heard of is still there.
        expect(doc.lastOpened).toBe("keep-me")
        expect(doc.version).toBe(1)
        expect(doc.repos).toHaveLength(2)
        // The foreign entry survives whole, unknown `sprint` field and all.
        expect(doc.repos.find((entry: { name: string }) => entry.name === "foreign")).toEqual(foreign)
        expect(doc.repos.find((entry: { name: string }) => entry.name === "demo").root).toBe(directory)
      }),
    { git: true },
  )
})

// =========================== board_worktrees =============================

describe("board_worktrees", () => {
  const row = (output: string, dir: string) =>
    output.split("\n").find((line) => line.split("  ")[0] === dir) ?? `NO ROW FOR ${dir}`

  it.instance(
    "lists every checkout with its branch, and marks the registered root and the primary",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const wt = path.join(directory, "wt")
        const det = path.join(directory, "det")
        yield* Effect.sync(() => git(directory, "worktree", "add", "-b", "feature", wt))
        yield* Effect.sync(() => git(directory, "worktree", "add", "--detach", det))
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const tool = yield* tools
        const { ctx, asks } = makeCtx()

        const result = yield* tool.worktrees.execute({ repo: "demo" }, ctx)

        expect(row(result.output, directory)).toContain("[root]")
        expect(row(result.output, directory)).toContain("[primary]")
        expect(row(result.output, wt)).toContain("feature")
        expect(row(result.output, wt)).not.toContain("[root]")
        expect(row(result.output, det)).toContain("detached")
        // A read never costs a permission prompt.
        expect(asks).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "marks the primary row when the primary is a different checkout from the registered root",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const wt = path.join(directory, "wt")
        yield* Effect.sync(() => git(directory, "worktree", "add", "-b", "feature", wt))
        yield* Effect.promise(() => registerRepo(home, "demo", directory, { primary: wt }))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const result = yield* tool.worktrees.execute({ repo: "demo" }, ctx)

        expect(row(result.output, directory)).toContain("[root]")
        expect(row(result.output, directory)).not.toContain("[primary]")
        expect(row(result.output, wt)).toContain("[primary]")
      }),
    { git: true },
  )

  it.instance(
    "a registered root that is not a git repo is a clear refusal, not a crash",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        const plain = yield* scratch("nogit")
        yield* Effect.promise(() =>
          writeRegistry(home, { version: 1, repos: [{ root: plain, name: "plain", workspace: false, addedAt: 0 }] }),
        )
        const tool = yield* tools
        const { ctx } = makeCtx()

        const result = yield* tool.worktrees.execute({ repo: "plain" }, ctx)

        expect(result.title).toBe("board_worktrees: refused")
        expect(result.output).toContain("not a git repo")
      }),
    { git: true },
  )

  it.instance(
    "an unregistered repo name is refused with the list of known repos",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const home = yield* useHome(directory)
        yield* Effect.promise(() => registerRepo(home, "demo", directory))
        const tool = yield* tools
        const { ctx } = makeCtx()

        const result = yield* tool.worktrees.execute({ repo: "nope" }, ctx)

        expect(result.output).toContain('no repo "nope"')
        expect(result.output).toContain("Registered: demo")
      }),
    { git: true },
  )
})
