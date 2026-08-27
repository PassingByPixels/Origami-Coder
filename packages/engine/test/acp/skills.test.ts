import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { OrigamiClient } from "@origami/sdk/v2"
import * as ACPService from "@/acp/service"
import { Skills } from "@/acp/skills"
import { CONTENT_PREVIEW_LIMIT } from "@/acp/skills"
import { Agent } from "@/acp/agent"
import type { Skill } from "@/skill"

function info(name: string, description?: string): Skill.Info {
  return { name, description, location: `/skills/${name}/SKILL.md`, content: `# ${name}` }
}

describe("skills projection", () => {
  it("projects every one of the six SkillsPane fields, with correct types, for each skill", () => {
    const result = Skills.project([info("beta", "Handles beta things"), info("alpha", "Handles alpha things")])

    expect(result.skills).toHaveLength(2)
    for (const entry of result.skills) {
      // The six the current SkillsPane indexes into must ALL still be present.
      // Enrichment is additive, so this is a superset check, not an equality one.
      for (const key of ["description", "immutable", "name", "ownerAgents", "tags", "tier"]) {
        expect(Object.keys(entry)).toContain(key)
      }
      expect(typeof entry.name).toBe("string")
      expect(typeof entry.description).toBe("string")
      expect(typeof entry.tier).toBe("string")
      expect(Array.isArray(entry.ownerAgents)).toBe(true)
      expect(Array.isArray(entry.tags)).toBe(true)
      expect(typeof entry.immutable).toBe("boolean")
    }
  })

  it("sorts by name regardless of registry order", () => {
    const result = Skills.project([info("zeta"), info("alpha"), info("mid")])
    expect(result.skills.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"])
  })

  it("gives a skill with no description a valid empty string, not undefined", () => {
    const result = Skills.project([info("bare")])
    expect(result.skills[0]).toMatchObject({ name: "bare", description: "" })
    expect(result.skills[0]!.description).not.toBeUndefined()
  })

  it("returns an empty list rather than throwing on an empty registry", () => {
    expect(Skills.project([])).toEqual({ skills: [] })
  })

  it("maps every skill to the SkillsPane's neutral/base tier, never a value it renders specially", () => {
    // SkillsPane.svelte tierLabel/tierClass only special-case "optin" and
    // "agentspecific"; anything else (including "base") falls through to the
    // neutral "base" branch. The engine has no tiering concept, so every
    // projected skill must land on that neutral branch.
    const result = Skills.project([info("solo")])
    const tierLabel = (t: string) => (t === "optin" ? "opt-in" : t === "agentspecific" ? "agent-specific" : "base")
    expect(tierLabel(result.skills[0]!.tier)).toBe("base")
  })

  it("gives every skill an empty ownerAgents and tags array rather than fabricating owners", () => {
    const result = Skills.project([info("solo", "desc")])
    expect(result.skills[0]!.ownerAgents).toEqual([])
    expect(result.skills[0]!.tags).toEqual([])
    expect(result.skills[0]!.immutable).toBe(false)
  })

  it("carries the skill's own category through instead of folding it into the hardcoded tags", () => {
    const entry = Skills.project([
      { name: "wrap", description: "Close out", category: "workflow", location: "/s/SKILL.md", content: "b" },
    ]).skills[0]!

    expect(entry.category).toBe("workflow")
    // tags is still the placeholder constant — a real authored fact must not be
    // laundered into the list of things the engine made up.
    expect(entry.tags).toEqual([])
  })

  it("passes an unrecognised category straight through rather than normalising it", () => {
    // The field is free-form engine-side, so the wire must not narrow it either.
    const entry = Skills.project([{ name: "odd", category: "brewing-tea", location: "/s/SKILL.md", content: "b" }])
      .skills[0]!
    expect(entry.category).toBe("brewing-tea")
  })

  it("omits category entirely for a skill that declares none, rather than sending a default", () => {
    const entry = Skills.project([info("bare", "No category")]).skills[0]!
    expect(Object.keys(entry)).not.toContain("category")
    expect(entry.category).toBeUndefined()
  })

  it("treats an empty category as none, so no card renders a chip that says nothing", () => {
    // `category: ""` in YAML really does reach the registry as an empty string
    // (a bare `category:` arrives as null and is dropped earlier). Passing it on
    // would draw a blank chip — a category that exists and carries no meaning.
    const entry = Skills.project([{ name: "blankcat", category: "", location: "/s/SKILL.md", content: "b" }]).skills[0]!
    expect(Object.keys(entry)).not.toContain("category")
  })

  it("reports the discovery path verbatim so a card can show where a skill came from", () => {
    const nested: Skill.Info = {
      name: "deep",
      description: "d",
      location: "C:\\Users\\x\\.claude\\skills\\deep\\SKILL.md",
      content: "body",
    }
    // Not normalised, not basename'd: a Windows path must survive as the exact
    // string the shell would have to open.
    expect(Skills.project([nested]).skills[0]!.location).toBe("C:\\Users\\x\\.claude\\skills\\deep\\SKILL.md")
  })

  it("caps contentPreview and never splits a surrogate pair", () => {
    // Astral emoji: one code point, two UTF-16 units. A naive slice halves one.
    const body = "😀".repeat(CONTENT_PREVIEW_LIMIT * 2)
    const excerpt = Skills.project([{ name: "emoji", location: "/s/SKILL.md", content: body }]).skills[0]!
      .contentPreview!

    expect(Array.from(excerpt).length).toBeLessThanOrEqual(CONTENT_PREVIEW_LIMIT)
    expect(/[\uD800-\uDFFF]/.test(excerpt.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false)
    // Truncation must be visible, not a silent short read.
    expect(excerpt.endsWith("…")).toBe(true)
  })

  it("returns a short body whole rather than padding or truncating it", () => {
    const excerpt = Skills.project([{ name: "short", location: "/s/SKILL.md", content: "  # Title\nline two  " }])
      .skills[0]!.contentPreview
    expect(excerpt).toBe("# Title\nline two")
  })

  it("carries malformed-skill problems through so the pane can show what failed to load", () => {
    const result = Skills.project(
      [info("ok", "Fine")],
      [
        { location: "/skills/zeta/SKILL.md", message: "frontmatter has no `name` field" },
        { location: "/skills/alpha/SKILL.md", message: "frontmatter is missing or is not a mapping" },
      ],
    )

    // Sorted like the skills list, so the banner does not reshuffle between refreshes.
    expect(result.problems!.map((p) => p.location)).toEqual(["/skills/alpha/SKILL.md", "/skills/zeta/SKILL.md"])
    expect(result.problems![1]!.message).toBe("frontmatter has no `name` field")
    // A file that failed to load must not also count as a skill.
    expect(result.skills.map((s) => s.name)).toEqual(["ok"])
  })

  it("omits the problems key entirely on a clean scan rather than sending an empty array", () => {
    const clean = Skills.project([info("ok", "Fine")])
    expect(Object.keys(clean)).not.toContain("problems")
    expect(clean.problems).toBeUndefined()
  })

  it("still reports problems when every skill failed to load, not just an empty list", () => {
    // The worst case is also the one a user most needs explained: nothing loaded.
    const result = Skills.project([], [{ location: "/skills/bad/SKILL.md", message: "frontmatter has no `name` field" }])
    expect(result.skills).toEqual([])
    expect(result.problems).toHaveLength(1)
  })

  it("omits contentPreview entirely for a blank body instead of sending an empty string", () => {
    const blank = Skills.project([{ name: "blank", location: "/s/SKILL.md", content: "   \n\t " }]).skills[0]!
    expect(blank.contentPreview).toBeUndefined()
    expect(Object.keys(blank)).not.toContain("contentPreview")
    // The genuinely-known field is still there.
    expect(blank.location).toBe("/s/SKILL.md")
  })
})

describe("list_skills service method", () => {
  const stubSdk = {} as unknown as OrigamiClient

  function serviceWithSkills(calls: string[], skills: Skill.Info[], opts?: (Skills.ListOptions | undefined)[]) {
    const skillsInterface: Skills.Interface = {
      list: (directory: string, options?: Skills.ListOptions) => {
        calls.push(directory)
        opts?.push(options)
        return Effect.succeed(Skills.project(skills))
      },
    }
    return ACPService.make({ sdk: stubSdk, skills: skillsInterface })
  }

  it("asks the registry to re-scan only when the caller requested a refresh", async () => {
    const seen: (Skills.ListOptions | undefined)[] = []
    await Effect.runPromise(serviceWithSkills([], [], seen).listSkills({ cwd: "/w", refresh: true }))
    await Effect.runPromise(serviceWithSkills([], [], seen).listSkills({ cwd: "/w" }))

    // A plain list must stay cheap — a re-scan re-pulls every configured skills URL.
    expect(seen.map((o) => o?.refresh)).toEqual([true, false])
  })

  it("passes the requested cwd through and returns the projected list", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(
      serviceWithSkills(calls, [info("one", "First")]).listSkills({ cwd: "/workspace" }),
    )

    expect(calls).toEqual(["/workspace"])
    expect(result.skills).toEqual([
      {
        name: "one",
        description: "First",
        tier: "base",
        ownerAgents: [],
        tags: [],
        immutable: false,
        location: "/skills/one/SKILL.md",
        contentPreview: "# one",
      },
    ])
  })

  it("puts the category on the wire, so a pane can group without re-reading SKILL.md", async () => {
    const categorised: Skill.Info = {
      name: "tdd",
      description: "Red-green-refactor",
      category: "testing",
      location: "/skills/tdd/SKILL.md",
      content: "# tdd",
    }
    const result = await Effect.runPromise(serviceWithSkills([], [categorised]).listSkills({ cwd: "/w" }))

    // Reaching the pane is the whole point — a field the projection knows but
    // the ext method drops is the same as no field at all.
    expect(result.skills[0]).toMatchObject({ name: "tdd", category: "testing" })
  })

  it("falls back to the process cwd when none is supplied", async () => {
    const calls: string[] = []
    await Effect.runPromise(serviceWithSkills(calls, []).listSkills({}))

    expect(calls).toEqual([process.cwd()])
  })

  it("returns an empty skills array rather than an error when the registry is empty", async () => {
    const result = await Effect.runPromise(serviceWithSkills([], []).listSkills({ cwd: "/workspace" }))
    expect(result).toEqual({ skills: [] })
  })
})

describe("ext method dispatch", () => {
  const service = {
    listSkills: (input: { cwd?: string }) =>
      Effect.succeed(Skills.project([info("dispatch-test", input.cwd ?? "no-cwd")])),
  } as unknown as ACPService.Interface

  it("accepts the `_` wire prefix clients send for extension methods", async () => {
    const agent = new Agent(service)
    const prefixed = await agent.extMethod("_list_skills", {})
    const bare = await agent.extMethod("list_skills", {})

    expect(prefixed).toEqual(bare)
    expect((prefixed as { skills: unknown[] }).skills).toHaveLength(1)
  })

  it("routes list_skills to the service and returns the wire shape SkillsPane expects", async () => {
    const agent = new Agent(service)
    const result = (await agent.extMethod("list_skills", { cwd: "/workspace" })) as { skills: { name: string }[] }

    expect(Array.isArray(result.skills)).toBe(true)
    expect(result.skills[0]!.name).toBe("dispatch-test")
  })

  it("forwards a refresh only for a real boolean true, never a truthy lookalike", async () => {
    const seen: (boolean | undefined)[] = []
    const tracking = {
      listSkills: (input: { refresh?: boolean }) => {
        seen.push(input.refresh)
        return Effect.succeed(Skills.project([]))
      },
    } as unknown as ACPService.Interface
    const agent = new Agent(tracking)

    await agent.extMethod("list_skills", { refresh: true })
    await agent.extMethod("list_skills", { refresh: "true" })
    await agent.extMethod("list_skills", { refresh: 1 })
    await agent.extMethod("list_skills", {})

    // Only the first buys a full re-scan; the rest are off-the-wire junk.
    expect(seen).toEqual([true, undefined, undefined, undefined])
  })

  it("omits cwd from the request when none is given rather than inventing one", async () => {
    const seen: (string | undefined)[] = []
    const tracking = {
      listSkills: (input: { cwd?: string }) => {
        seen.push(input.cwd)
        return Effect.succeed(Skills.project([]))
      },
    } as unknown as ACPService.Interface
    const agent = new Agent(tracking)

    await agent.extMethod("list_skills", {})

    expect(seen).toEqual([undefined])
  })
})
