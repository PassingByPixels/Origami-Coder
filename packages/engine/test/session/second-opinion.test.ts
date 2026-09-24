// The SECOND OPINION digest — the brief a DIFFERENT model is handed when the
// user asks it to review the turn the chat's own model just finished.
//
// The bugs worth catching here are all silent ones. A digest that quietly ships
// a turn still in flight reviews half-written work. A cap written per-file lets
// ten files past a bound measured for one. A trim order that drops prior
// context first saves the fewest characters and costs the reviewer the most.
// And the preamble is a shipped prompt string: a stray edit to it changes what
// every second opinion is asked to do, with nothing else in the system able to
// notice.
//
// Every fixture is a hand-built `WithParts` in the stored shape — the same
// records `session.messages` returns — so nothing here is computed by the code
// under test.

import { describe, expect, it } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import {
  ASSISTANT_CAP,
  DIFF_CAP,
  PREAMBLE_TEMPLATE,
  PRIOR_CAP,
  USER_CAP,
  buildDigest,
  preamble,
} from "@/session/second-opinion"

const session = "ses_main"
let seq = 0
const ids = (messageID: string) => {
  seq++
  return { id: `prt_${seq}`, sessionID: session, messageID }
}

function user(id: string, text: string, extra: Record<string, unknown> = {}): SessionV1.WithParts {
  return {
    info: { id, sessionID: session, role: "user", time: { created: 1_000 }, agent: "build" },
    parts: [{ ...ids(id), type: "text", text, ...extra }],
  } as unknown as SessionV1.WithParts
}

function compactionRequest(id: string): SessionV1.WithParts {
  return {
    info: { id, sessionID: session, role: "user", time: { created: 1_000 }, agent: "build" },
    parts: [{ ...ids(id), type: "compaction", auto: true }],
  } as unknown as SessionV1.WithParts
}

/** Settled unless overridden — `time.completed` is what the engine stamps on
 *  every exit path (session/prompt.ts), so its absence means still in flight. */
function assistant(
  id: string,
  parts: unknown[],
  info: Record<string, unknown> = {},
): SessionV1.WithParts {
  return {
    info: {
      id,
      sessionID: session,
      role: "assistant",
      parentID: "msg_u1",
      modelID: "m",
      providerID: "p",
      mode: "build",
      agent: "build",
      path: { cwd: "/w", root: "/w" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1_000, completed: 2_000 },
      ...info,
    },
    parts: parts.map((p) => ({ ...ids(id), ...(p as object) })),
  } as unknown as SessionV1.WithParts
}

const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: t, ...extra })

const editTool = (path: string, diff: string, output = "Edit applied successfully.") => ({
  type: "tool",
  callID: `call_${path}`,
  tool: "edit",
  state: {
    status: "completed",
    input: { filePath: path, oldString: "a", newString: "b" },
    output,
    title: path,
    metadata: { diff, filediff: { file: path, patch: diff, additions: 1, deletions: 1 } },
    time: { start: 1, end: 2 },
  },
})

const readTool = (path: string, output: string) => ({
  type: "tool",
  callID: `call_read_${path}`,
  tool: "read",
  state: {
    status: "completed",
    input: { filePath: path },
    output,
    title: path,
    metadata: {},
    time: { start: 1, end: 2 },
  },
})

/** The everyday session: one earlier turn, then the turn under review. */
function history(): SessionV1.WithParts[] {
  return [
    user("msg_u0", "First, set the project up."),
    assistant("msg_a0", [text("Set up done.")], { parentID: "msg_u0" }),
    user("msg_u1", "Now fix the off-by-one in the paginator."),
    assistant(
      "msg_a1",
      [
        text("I found the bug in `page()` and corrected the bound."),
        readTool("/w/src/page.ts", "export function page() { ... }"),
        editTool("/w/src/page.ts", "@@ -1 +1 @@\n-  i <= n\n+  i < n"),
      ],
      { parentID: "msg_u1" },
    ),
  ]
}

const digest = (h: SessionV1.WithParts[], budget?: number) =>
  buildDigest({ history: h, currentModelLabel: "qwen3-coder-30b", ...(budget ? { budget } : {}) })

describe("the preamble is a shipped prompt, held verbatim", () => {
  it("is the exact review instruction, with only the model name substituted", () => {
    // Typed out in full rather than compared against the constant it comes
    // from: a test that reads `PREAMBLE_TEMPLATE` and asserts it equals
    // `PREAMBLE_TEMPLATE` cannot fail. This is the sentence the feature ships.
    expect(preamble("gpt-5")).toBe(
      "You are giving a second opinion for the user on work another AI model (gpt-5) just completed in this chat. " +
        "Review that work critically: what is correct, what is wrong, what is missing, and what you would have done " +
        "differently. Do not assume the work is right because it reads confidently. You cannot edit files or run " +
        "tools — deliver your assessment as an answer to the user. End with a clear verdict line: AGREE (the work " +
        "stands), CONCERNS (name them), or DISAGREE (say what should happen instead), plus the single next step you " +
        "would take if this chat were handed to you.",
    )
  })

  it("names the review-only rule and the verdict line — the two things it exists to enforce", () => {
    expect(PREAMBLE_TEMPLATE).toContain("You cannot edit files or run tools")
    expect(PREAMBLE_TEMPLATE).toContain("AGREE")
    expect(PREAMBLE_TEMPLATE).toContain("CONCERNS")
    expect(PREAMBLE_TEMPLATE).toContain("DISAGREE")
  })

  it("still reads as a sentence when the chat could not name the model", () => {
    expect(preamble("  ")).toContain("another AI model (another model) just completed")
    expect(preamble("  ")).not.toContain("{currentModelLabel}")
  })

  it("opens the digest — the instruction cannot arrive after the evidence", () => {
    const built = digest(history())!
    expect(built.prompt.startsWith(preamble("qwen3-coder-30b"))).toBe(true)
  })
})

describe("which turn is reviewed", () => {
  it("takes the LAST completed turn, not the first", () => {
    const built = digest(history())!
    expect(built.prompt).toContain("Now fix the off-by-one in the paginator.")
    expect(built.prompt).toContain("I found the bug in `page()` and corrected the bound.")
    // The earlier turn is prior context, never the subject.
    expect(built.prompt).not.toContain("## What the user asked for\nFirst, set the project up.")
  })

  it("refuses a session with no turn at all", () => {
    expect(buildDigest({ history: [], currentModelLabel: "m" })).toBeUndefined()
  })

  it("refuses a turn still in flight rather than reviewing half-written work", () => {
    const h = [user("msg_u1", "do the thing"), assistant("msg_a1", [text("working…")], { time: { created: 1 } })]
    expect(digest(h)).toBeUndefined()
  })

  it("falls back to the previous completed turn when a NEW turn is running", () => {
    const h = [
      ...history(),
      user("msg_u2", "and now the second thing"),
      assistant("msg_a2", [text("still going")], { parentID: "msg_u2", time: { created: 3_000 } }),
    ]
    const built = digest(h)!
    expect(built.prompt).toContain("## What the user asked for\nNow fix the off-by-one in the paginator.")
    expect(built.prompt).not.toContain("and now the second thing")
  })

  it("treats a FAILED turn as completed — a turn that died is exactly what gets questioned", () => {
    const h = [
      user("msg_u1", "run the migration"),
      assistant("msg_a1", [text("partial")], { time: { created: 1 }, error: { name: "APIError", data: {} } }),
    ]
    expect(digest(h)?.prompt).toContain("run the migration")
  })

  it("never offers a COMPACTION run as the turn under review", () => {
    const h = [
      ...history(),
      compactionRequest("msg_c1"),
      assistant("msg_ac1", [text("summary of the chat so far")], { parentID: "msg_c1", summary: true }),
    ]
    const built = digest(h)!
    expect(built.prompt).toContain("## What the user asked for\nNow fix the off-by-one in the paginator.")
  })
})

describe("what the digest carries", () => {
  it("lists every tool the turn ran, with its input and a result gist", () => {
    const built = digest(history())!
    expect(built.prompt).toContain("## Tools it ran (2)")
    expect(built.prompt).toContain("- read(")
    expect(built.prompt).toContain("/w/src/page.ts")
    expect(built.prompt).toContain("-> Edit applied successfully.")
  })

  it("carries the file paths AND their diffs", () => {
    const built = digest(history())!
    expect(built.prompt).toContain("## Files it changed (1)")
    expect(built.prompt).toContain("```diff")
    expect(built.prompt).toContain("+  i < n")
  })

  it("carries BOTH edits when a turn touched the same file twice", () => {
    // Regression: an earlier draft deduped on `path + diff.length`, which drops
    // the second of two same-length edits to one file — a perfectly ordinary
    // shape for a pair of one-line fixes, and invisible in the review afterwards.
    const h = [
      user("msg_u1", "fix both bounds"),
      assistant("msg_a1", [
        text("both done"),
        editTool("/w/src/page.ts", "@@ -1 +1 @@\n-  i <= n\n+  i < nn"),
        editTool("/w/src/page.ts", "@@ -9 +9 @@\n-  j <= m\n+  j < mm"),
      ]),
    ]
    const built = digest(h)!
    expect(built.prompt).toContain("## Files it changed (2)")
    expect(built.prompt).toContain("+  i < nn")
    expect(built.prompt).toContain("+  j < mm")
  })

  it("keeps a path with no diff behind it (a PatchPart carries files, not patches)", () => {
    const h = [
      user("msg_u1", "touch these"),
      assistant("msg_a1", [text("done"), { type: "patch", hash: "abc", files: ["/w/a.ts", "/w/b.ts"] }]),
    ]
    const built = digest(h)!
    expect(built.prompt).toContain("- /w/a.ts")
    expect(built.prompt).toContain("- /w/b.ts")
    // No empty fence for a change with nothing to show.
    expect(built.prompt).not.toContain("```diff\n\n```")
  })

  it("reports a failed tool as an error, not as output", () => {
    const h = [
      user("msg_u1", "build it"),
      assistant("msg_a1", [
        text("that failed"),
        {
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: { status: "error", input: { command: "npm run build" }, error: "exit 1: tsc failed", time: { start: 1, end: 2 } },
        },
      ]),
    ]
    expect(digest(h)!.prompt).toContain("-> ERROR: exit 1: tsc failed")
  })

  it("leaves out synthetic and ignored text — neither was said by anyone", () => {
    const h = [
      user("msg_u1", "the real question"),
      assistant("msg_a1", [
        text("the real answer"),
        text("<system-reminder>do not tell the user</system-reminder>", { synthetic: true }),
        text("hidden scratch", { ignored: true }),
      ]),
    ]
    const built = digest(h)!
    expect(built.prompt).toContain("the real answer")
    expect(built.prompt).not.toContain("system-reminder")
    expect(built.prompt).not.toContain("hidden scratch")
  })

  it("says so plainly when a turn produced only tool calls", () => {
    const h = [user("msg_u1", "just do it"), assistant("msg_a1", [readTool("/w/x.ts", "contents")])]
    expect(digest(h)!.prompt).toContain("(it produced no prose, only tool calls)")
  })

  it("carries the earlier turns as prior context when there is no compaction", () => {
    expect(digest(history())!.prompt).toContain("## Earlier in this chat")
    expect(digest(history())!.prompt).toContain("First, set the project up.")
  })

  it("prefers the compaction SUMMARY over replaying the raw earlier turns", () => {
    const h = [
      user("msg_u0", "a very early message nobody needs verbatim"),
      assistant("msg_a0", [text("ok")], { parentID: "msg_u0" }),
      compactionRequest("msg_c1"),
      assistant("msg_ac1", [text("SUMMARY: the paginator work so far")], { parentID: "msg_c1", summary: true }),
      user("msg_u1", "now fix the bound"),
      assistant("msg_a1", [text("fixed")], { parentID: "msg_u1" }),
    ]
    const built = digest(h)!
    expect(built.prompt).toContain("SUMMARY: the paginator work so far")
    expect(built.prompt).not.toContain("a very early message nobody needs verbatim")
  })
})

describe("the caps are real bounds, not decoration", () => {
  it("cuts an oversized user request at USER_CAP", () => {
    const h = [user("msg_u1", "x".repeat(USER_CAP + 5_000)), assistant("msg_a1", [text("ok")])]
    const built = digest(h)!
    const section = built.prompt.split("## What the user asked for\n")[1]!.split("\n\n##")[0]!
    expect(section).toContain("[…truncated]")
    expect(section.length).toBeLessThan(USER_CAP + 100)
  })

  it("cuts an oversized answer at ASSISTANT_CAP", () => {
    const h = [user("msg_u1", "go"), assistant("msg_a1", [text("y".repeat(ASSISTANT_CAP + 5_000))])]
    const section = digest(h)!.prompt.split("## What the other model answered\n")[1]!
    expect(section).toContain("[…truncated]")
    expect(section.length).toBeLessThan(ASSISTANT_CAP + 100)
  })

  it("bounds the diffs IN TOTAL, not per file — three big files cannot each spend the budget", () => {
    const big = (n: string) => `@@ ${n} @@\n` + `+line\n`.repeat(2_000)
    const h = [
      user("msg_u1", "rewrite three files"),
      assistant("msg_a1", [
        text("done"),
        editTool("/w/a.ts", big("a")),
        editTool("/w/b.ts", big("b")),
        editTool("/w/c.ts", big("c")),
      ]),
    ]
    const built = digest(h)!
    const diffChars = [...built.prompt.matchAll(/```diff\n([\s\S]*?)\n```/g)].reduce((n, m) => n + m[1]!.length, 0)
    expect(diffChars).toBeLessThanOrEqual(DIFF_CAP)
    // And every path is still named — losing the bytes must not lose the file.
    for (const p of ["/w/a.ts", "/w/b.ts", "/w/c.ts"]) expect(built.prompt).toContain(p)
  })

  it("keeps the TAIL of an over-long prior context, not its head", () => {
    const h = [
      user("msg_u0", "ancient-marker " + "z".repeat(PRIOR_CAP)),
      assistant("msg_a0", [text("recent-marker")], { parentID: "msg_u0" }),
      user("msg_u1", "the turn"),
      assistant("msg_a1", [text("the answer")], { parentID: "msg_u1" }),
    ]
    const built = digest(h)!
    expect(built.prompt).toContain("recent-marker")
    expect(built.prompt).not.toContain("ancient-marker")
  })
})

describe("the trim order when the prompt will not fit", () => {
  // One history, four budgets. Each assertion is about WHICH section went, not
  // about the exact length — the ladder is the rule under test.
  const wide = (): SessionV1.WithParts[] => [
    user("msg_u0", "earlier turn text PRIORMARK"),
    assistant("msg_a0", [text("earlier answer")], { parentID: "msg_u0" }),
    user("msg_u1", "the request"),
    assistant("msg_a1", [text("the answer"), editTool("/w/a.ts", "@@ @@\n+DIFFMARK\n" + "+f\n".repeat(400))], {
      parentID: "msg_u1",
    }),
  ]

  // Budgets are DERIVED from the previous level's own length rather than
  // guessed: a hard-coded number that happens to sit two levels down passes
  // while proving nothing about the order, and it re-breaks whenever a section
  // heading is reworded. `len - 1` forces exactly one more step, every time.
  const full = () => digest(wide())!
  const noDiffs = () => digest(wide(), full().prompt.length - 1)!
  const noGists = () => digest(wide(), noDiffs().prompt.length - 1)!
  const noPrior = () => digest(wide(), noGists().prompt.length - 1)!

  it("ships everything when it fits", () => {
    const built = full()
    expect(built.trimmed).toEqual([])
    expect(built.prompt).toContain("DIFFMARK")
    expect(built.prompt).toContain("PRIORMARK")
  })

  it("drops the DIFFS first, keeping the paths, the tool gists and the prior context", () => {
    const built = noDiffs()
    expect(built.trimmed).toEqual(["diffs"])
    expect(built.prompt).not.toContain("DIFFMARK")
    expect(built.prompt).toContain("- /w/a.ts")
    expect(built.prompt).toContain("-> Edit applied successfully.")
    expect(built.prompt).toContain("PRIORMARK")
  })

  it("drops the tool RESULT GISTS second, keeping the tool names and the prior context", () => {
    const built = noGists()
    expect(built.trimmed).toEqual(["diffs", "toolResults"])
    expect(built.prompt).toContain("- edit(")
    expect(built.prompt).not.toContain("-> Edit applied successfully.")
    expect(built.prompt).toContain("PRIORMARK")
  })

  it("drops the PRIOR CONTEXT last — the cheapest saving, so the last resort", () => {
    const built = noPrior()
    expect(built.trimmed).toEqual(["diffs", "toolResults", "priorContext"])
    expect(built.prompt).not.toContain("PRIORMARK")
    // The request and the answer survive every level: they are the review.
    expect(built.prompt).toContain("the request")
    expect(built.prompt).toContain("the answer")
  })

  it("ships the request and the answer even when nothing left will fit", () => {
    const built = digest(wide(), 10)!
    expect(built.trimmed).toEqual(["diffs", "toolResults", "priorContext"])
    expect(built.prompt).toContain("the request")
    expect(built.prompt).toContain("the answer")
  })

  // The four cases above each pin ONE rung, and each derives its budget from the
  // rung above — so a ladder rebuilt in a different order can fail only the
  // first of them and leave the rest looking healthy (observed: swapping rungs
  // 2 and 3 turned exactly one test red). This walks every budget from "fits"
  // down to "nothing fits" and asserts the WHOLE sequence, which no single
  // reordering can survive.
  it("never drops a section out of order, at any budget", () => {
    const LADDER = [[], ["diffs"], ["diffs", "toolResults"], ["diffs", "toolResults", "priorContext"]]
    const seen: string[][] = []
    const full = digest(wide())!.prompt.length
    for (let budget = full + 50; budget > 0; budget -= 25) {
      const trimmed = [...digest(wide(), budget)!.trimmed]
      // Every answer is one of the four documented rungs, never an ad-hoc mix
      // such as ["priorContext"] alone.
      expect(LADDER.some((rung) => rung.join() === trimmed.join()), `unknown trim set: ${trimmed.join()}`).toBe(true)
      if (seen.length === 0 || seen[seen.length - 1]!.join() !== trimmed.join()) seen.push(trimmed)
    }
    // Monotone, in the documented order, with no rung skipped or revisited.
    expect(seen).toEqual(LADDER)
  })
})
