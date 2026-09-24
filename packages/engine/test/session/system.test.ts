import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@origami/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
          problems: () => Effect.succeed([]),
          refresh: () => Effect.void,
        }),
      ),
    ],
  ]),
)

// One id per branch the OLD per-family selection chain used to take. The list
// outlived the chain deliberately: it is what proves the removal, and what would
// catch family tuning being reintroduced under a new id.
const FAMILIES = [
  "meta/muse-spark-preview",
  "openai/gpt-4o",
  "openai/gpt-5-codex",
  "openai/gpt-4.1-mini",
  "google/gemini-2.5-pro",
  "anthropic/claude-opus-4-6",
  "moonshot/kimi-k2",
  "xai/trinity-2",
  "lmstudio/qwen3-coder-30b",
]

const promptFor = (id: string) => SystemPrompt.provider({ api: { id } } as Provider.Model)

/** Point the engine's global config dir at a scratch directory for one test. */
function withConfigDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "origami-base-prompt-"))
  const previous = process.env["ORIGAMI_CONFIG_DIR"]
  process.env["ORIGAMI_CONFIG_DIR"] = dir
  try {
    run(dir)
  } finally {
    if (previous === undefined) delete process.env["ORIGAMI_CONFIG_DIR"]
    else process.env["ORIGAMI_CONFIG_DIR"] = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("session.system", () => {
  // --- ONE model-agnostic base prompt. The fork ships no per-family variants,
  // so the model id is not allowed to change the text at all.

  test("with no override file, every model family gets the SAME one built-in prompt", () => {
    withConfigDir(() => {
      const built = FAMILIES.map((id) => promptFor(id))
      for (const [index, prompt] of built.entries())
        expect(prompt, `${FAMILIES[index]} was given a prompt of its own`).toEqual([SystemPrompt.BASE_PROMPT_BUILTIN])
      expect(new Set(built.map((prompt) => prompt[0])).size).toBe(1)
    })
  })

  test("the built-in base prompt names no model vendor", () => {
    // A vendor name in the shipped text is family tuning by another route: it
    // would be sent to every OTHER family too.
    const text = SystemPrompt.BASE_PROMPT_BUILTIN.toLowerCase()
    for (const vendor of ["anthropic", "claude", "openai", "gpt", "gemini", "kimi", "muse spark", "codex"])
      expect(text, `the base prompt names ${vendor}`).not.toContain(vendor)
  })

  // --- The persistence contract. This is a DELETION guard, and it exists
  // because the deletion already happened once: c4dd39f11f removed the
  // per-family prompt files, and the persistence language that used to reach
  // the OpenAI family went with them. What was left said the opposite - "when
  // in doubt: ask" and "answer first before jumping to action" - and the
  // family whose endpoint default is no reasoning at all read that as
  // permission to announce an action and stop. Nothing failed; there was no
  // gate on this text at all.

  test("the base prompt tells the model to act, not to narrate", () => {
    const text = SystemPrompt.BASE_PROMPT_BUILTIN
    expect(text, "the autonomy/persistence section was removed").toContain("# Autonomy and persistence")
    // The two halves that keep a turn from ending on a promise. origami_change
    // (t-46a74d): both were rewritten from negative to positive framing on the
    // hypothesis that a prompt whose salient verbs are "never" and "stop"
    // primes exactly that. The RULES are unchanged and are what is asserted:
    // a written commitment is followed by the call, and a turn ends for three
    // named reasons.
    expect(text).toContain("having written it, make the call")
    expect(text).toContain("the work is done, you are blocked, or the user redirected you")
    expect(text).toContain("Keep going until the user's request is completely resolved")
  })

  // origami_change (t-46a74d): the persistence section is the one place a
  // stop-shaped imperative does the most damage - it is what the model reads
  // while deciding whether to carry on. These are the two spellings that were
  // there and are deliberately gone.
  test("the persistence section names what to do, not what to avoid", () => {
    const section = SystemPrompt.BASE_PROMPT_BUILTIN.split("# Autonomy and persistence")[1]!.split("\n#")[0]!
    expect(section).not.toContain("Never end a turn")
    expect(section).not.toContain("Stop the turn")
  })

  test("nothing in the base prompt tells the model to answer before acting", () => {
    // The exact sentence the old Proactiveness section carried. Re-adding it,
    // or anything that reads like it, puts the contradiction back.
    const text = SystemPrompt.BASE_PROMPT_BUILTIN.toLowerCase()
    for (const contradiction of ["answer first before jumping to action", "when in doubt: ask"])
      expect(text, `the base prompt still says "${contradiction}"`).not.toContain(contradiction)
  })

  // --- t-s3pdlq: the base prompt is the only place that tells the model WHEN
  // to publish an artifact. The tool descriptions (artifact-publish.txt etc.)
  // carry the detail; this section is the trigger, and it must not duplicate
  // the "tell the owner" nudge artifact.ts already appends to every tool
  // result (t-rz3rym's PILL_NUDGE) — that would print it twice on a publish.

  test("the base prompt carries exactly one artifact rule, under 90 words", () => {
    const text = SystemPrompt.BASE_PROMPT_BUILTIN
    const matches = text.split("# Artifacts").length - 1
    expect(matches, "the artifact rule section appears more than once").toBe(1)

    const section = text.split("# Artifacts")[1]!.split("\n#")[0]!.trim()
    expect(section).toContain("artifact_publish")
    expect(section.toLowerCase()).toContain("not artifacts")
    const words = section.split(/\s+/).filter((word) => word.length > 0)
    expect(words.length, `artifact rule is ${words.length} words`).toBeLessThan(90)

    // t-s49986: the rule is a JUDGEMENT, not a list of formats. Each clause is
    // one decision the model makes; losing one of them is losing that decision.
    const lower = section.toLowerCase()
    // Publish when the owner will look at or use the result…
    expect(section).toContain("LOOK AT or USE")
    for (const kind of ["page", "dashboard", "report", "review explainer", "prototype", "comparison table"])
      expect(lower, `the rule names ${kind}`).toContain(kind)
    // …answer in chat when the owner will read it or act on it in code…
    expect(section).toContain("READ a short answer or ACT on it in code")
    // …a request phrased as a question is still a publish…
    expect(lower).toContain("can you write up x")
    expect(lower).toContain("is still a publish")
    // …never code or patches, and the reply names the artifact.
    expect(lower).toContain("code and patches are not artifacts; never publish them")
    expect(lower).toContain("name the artifact")

    // Does not duplicate the tool result's own nudge line (t-rz3rym).
    expect(section).not.toContain("Tell the user this is in the Artifacts pill")
  })

  test("no other shipped prompt file mentions the artifact_publish tool", () => {
    const promptDir = path.join(import.meta.dir, "../../src/session/prompt")
    const files = fs.readdirSync(promptDir).filter((name) => name !== "default.txt" && name.endsWith(".txt"))
    expect(files.length, "expected sibling prompt files alongside default.txt").toBeGreaterThan(0)
    for (const file of files) {
      const text = fs.readFileSync(path.join(promptDir, file), "utf8")
      expect(text, `${file} mentions artifact_publish`).not.toContain("artifact_publish")
    }
  })

  // --- The user-global base-prompt override. The behaviour that matters is
  // that ONE file replaces the prompt for every family, and that the ways it
  // can be absent or empty all fall back to the built-in rather than shipping
  // a model an empty system prompt.

  test("a non-empty base-prompt.md replaces the built-in for EVERY model family", () => {
    withConfigDir((dir) => {
      const mine = "# My prompt\nAnswer only in haiku.\n"
      fs.writeFileSync(path.join(dir, SystemPrompt.BASE_PROMPT_FILE), mine, "utf8")

      for (const id of FAMILIES) expect(promptFor(id)).toEqual([mine])
      expect(SystemPrompt.basePromptPath()).toBe(path.join(dir, "base-prompt.md"))
      expect(SystemPrompt.basePromptOverride()).toBe(mine)
    })
  })

  test("an edit takes effect on the next call, with no restart", () => {
    withConfigDir((dir) => {
      const file = path.join(dir, SystemPrompt.BASE_PROMPT_FILE)
      fs.writeFileSync(file, "first", "utf8")
      expect(promptFor("lmstudio/qwen3-coder-30b")).toEqual(["first"])
      fs.writeFileSync(file, "second", "utf8")
      expect(promptFor("lmstudio/qwen3-coder-30b")).toEqual(["second"])
    })
  })

  test("a blank or whitespace-only override is ignored, never sent as an empty prompt", () => {
    withConfigDir((dir) => {
      const file = path.join(dir, SystemPrompt.BASE_PROMPT_FILE)
      const builtIns = FAMILIES.map((id) => promptFor(id)[0])

      for (const blank of ["", "   ", "\n\n\t\n"]) {
        fs.writeFileSync(file, blank, "utf8")
        expect(SystemPrompt.basePromptOverride()).toBeUndefined()
        // Every family is back on its own built-in, not on a blank string.
        expect(FAMILIES.map((id) => promptFor(id)[0])).toEqual(builtIns)
      }
    })
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      // Compact listing (token_burn_plan §2.3): name + first-line description,
      // no XML wrapper.
      expect(output).toContain("- **alpha-skill**: Alpha skill.")
      expect(output).toContain("- **middle-skill**: Middle skill.")
      expect(output).toContain("- **zeta-skill**: Zeta skill.")
      expect(output).not.toContain("<available_skills>")

      const alpha = output.indexOf("**alpha-skill**")
      const middle = output.indexOf("**middle-skill**")
      const zeta = output.indexOf("**zeta-skill**")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
