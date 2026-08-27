import { describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@origami/core/effect/layer-node"
import { Effect } from "effect"
import { WikiRelatedTool, WikiSearchTool } from "../../src/tool/wiki"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"
import { Ripgrep } from "@origami/core/ripgrep"
import { FSUtil } from "@origami/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Git } from "@/git"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const toolLayer = LayerNode.compile(
  LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
)

const it = testEffect(toolLayer)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const write = (dir: string, rel: string, body: string) =>
  Effect.promise(() => Bun.write(path.join(dir, ...rel.split("/")), body))

/**
 * The fixture is the specification in miniature:
 *  - pages filed under tags whose text never uses the tag word (tag retrieval),
 *  - a page whose only hook is a HEADING (fuzzy retrieval past the title),
 *  - one link to a page that does not exist (the `(unwritten)` marker),
 *  - one page linked TO but not FROM (inbound, which grep cannot do cheaply),
 *  - two pages sharing one tag and one sharing two (neighbour ranking),
 *  - a body-only word, `quokka`, that must never be findable.
 */
const fixture = (dir: string) =>
  Effect.gen(function* () {
    yield* write(
      dir,
      "wiki/pages/deploy-ritual.md",
      [
        "---",
        "tags: [deploy, origami]",
        "description: Shipping the engine — typecheck, package, then prove the artifact carries the change.",
        "---",
        "",
        "# Deploy Ritual",
        "",
        "Read [[bundle-verification]] first, then rotate with [[rotate-secrets]].",
        "",
        "## Packaging steps",
        "",
        "The quokka paragraph exists only in this body and must never be retrievable by search.",
        "",
      ].join("\n"),
    )
    yield* write(
      dir,
      "wiki/pages/bundle-verification.md",
      [
        "---",
        "tags: [deploy, verification]",
        "description: How to prove the packaged artifact contains the work you just did.",
        "---",
        "",
        "# Bundle Verification",
        "",
        "Unzip it and grep the installed bundle for a string only the new build has.",
        "",
      ].join("\n"),
    )
    yield* write(
      dir,
      "wiki/pages/release-notes.md",
      [
        "---",
        "tags: [deploy, origami]",
        "description: What each release said, and who it was written for.",
        "---",
        "",
        "# Release Notes",
        "",
      ].join("\n"),
    )
    yield* write(
      dir,
      "wiki/pages/coder-internals.md",
      [
        "---",
        "tags: [origami, coder]",
        "title: Extension and engine split",
        "description: Two builds, two deploys, and why the version numbers move apart.",
        "---",
        "",
        "## Cartographer map",
        "",
        "The map is written for agents to read before they go file by file.",
        "",
      ].join("\n"),
    )
    yield* write(
      dir,
      ".origami/memory/feedback_tests_verify.md",
      [
        "---",
        "tags: [testing, feedback]",
        "description: Assert observable behaviour against the requirement, never the implementation.",
        "---",
        "",
        "# Tests verify",
        "",
      ].join("\n"),
    )
  })

describe("tool.wiki_search", () => {
  it.instance("finds pages by TAG even when the page text never uses the word", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ tags: ["verification"] }, ctx)

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain("wiki/pages/bundle-verification")
      expect(result.output).toContain("tag:verification")
      // The word "verification" appears in NO other page's metadata, and the
      // pages that are about verifying are reached through the tag, not prose.
      expect(result.output).not.toContain("wiki/pages/release-notes")
    }),
  )

  it.instance("matches a query against a heading the title never mentions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ query: "cartographer" }, ctx)

      expect(result.output).toContain("wiki/pages/coder-internals")
      expect(result.output).toContain("heading")
    }),
  )

  it.instance("NEVER searches page bodies", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      // Positive control: a word that lives in the FRONT MATTER description is
      // found, so a zero-hit result below cannot be blamed on a broken search.
      const control = yield* search.execute({ query: "typecheck" }, ctx)
      expect(control.metadata.matches).toBe(1)
      expect(control.output).toContain("wiki/pages/deploy-ritual")

      // "quokka" is in deploy-ritual's BODY and nowhere else. Matching it would
      // mean bodies are in the index, and the token-economy promise is void.
      const body = yield* search.execute({ query: "quokka" }, ctx)
      expect(body.metadata.matches).toBe(0)
      expect(body.output).not.toContain("(matched:")
    }),
  )

  it.instance("recovers from a miss with nearest tags and their top pages", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ tags: ["deplyo"] }, ctx)

      expect(result.metadata.matches).toBe(0)
      expect(result.output).toContain("nearest tags:")
      expect(result.output).toContain("deploy(3)")
      expect(result.output).toContain('top pages under "deploy"')
      expect(result.output).toContain('tags: ["deploy"]')
    }),
  )

  it.instance("offers co-occurring tags as the next move when there are hits", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ tags: ["deploy"] }, ctx)

      expect(result.metadata.matches).toBe(3)
      expect(result.output).toContain("related tags:")
      expect(result.output).toContain("origami(2)")
      expect(result.output).toContain("verification(1)")
      expect(result.output).not.toContain("deploy(")
    }),
  )

  it.instance("caps its own output and says that it did", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.forEach(Array.from({ length: 20 }, (_, i) => i), (i) =>
        write(
          test.directory,
          `wiki/pages/bulk-page-number-${String(i).padStart(2, "0")}.md`,
          [
            "---",
            "tags: [bulk]",
            `description: Page ${i} of a deliberately verbose set, written long enough that twenty of these rows cannot fit inside the tool's own three thousand character ceiling.`,
            "---",
            "",
          ].join("\n"),
        ),
      )
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ tags: ["bulk"], limit: 20 }, ctx)

      expect(result.metadata.matches).toBe(20)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output.length).toBeLessThanOrEqual(3000)
      expect(result.output).toContain("output capped at 3000 characters")
      // The next move survives the cut - a truncated reply that loses its
      // footer is a dead end, which is the failure this tool exists to avoid.
      expect(result.output).toContain("next:")
    }),
  )

  it.instance("says honestly when the workspace has no knowledge roots", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.rm(path.join(test.directory, "wiki"), { recursive: true, force: true }))
      yield* Effect.promise(() =>
        fs.rm(path.join(test.directory, ".origami", "memory"), { recursive: true, force: true }),
      )
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ query: "anything" }, ctx)

      expect(result.output).toContain("No wiki roots found")
      expect(result.output).toContain(path.join(test.directory, "wiki"))
      expect(result.output).toContain(path.join(test.directory, ".origami", "memory"))
      expect(result.metadata.matches).toBe(0)
    }),
  )

  it.instance("asks for a query or tags instead of searching everything", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({}, ctx)

      expect(result.output).toContain("needs a `query`")
      expect(result.metadata.matches).toBe(0)
    }),
  )

  it.instance("sees a page that was edited after the first search", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      expect((yield* search.execute({ tags: ["retrofit"] }, ctx)).metadata.matches).toBe(0)

      yield* write(
        test.directory,
        "wiki/pages/release-notes.md",
        [
          "---",
          "tags: [deploy, origami, retrofit]",
          "description: What each release said, and who it was written for, revised.",
          "---",
          "",
          "# Release Notes",
          "",
        ].join("\n"),
      )

      const after = yield* search.execute({ tags: ["retrofit"] }, ctx)
      expect(after.metadata.matches).toBe(1)
      expect(after.output).toContain("wiki/pages/release-notes")
    }),
  )

  it.instance("ignores function words so a question does not match every page", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      // Every word here is a function word. Counting them would match almost
      // any description, which is exactly how a "why did we..." question used
      // to rank an unrelated page first.
      const noise = yield* search.execute({ query: "how did we do this" }, ctx)
      expect(noise.metadata.matches).toBe(0)

      // The same question with one content word in it finds the page.
      const real = yield* search.execute({ query: "how did we do the packaging" }, ctx)
      expect(real.output).toContain("wiki/pages/deploy-ritual")
    }),
  )

  it.instance("prefers the page that answers more of the query over one loud tag", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(
        test.directory,
        "wiki/pages/loud-tag.md",
        ["---", "tags: [signing]", "title: Signing", "description: Nothing else lives here.", "---", ""].join("\n"),
      )
      yield* write(
        test.directory,
        "wiki/pages/broad-answer.md",
        ["---", "title: Key rotation on the release machine", "description: The full procedure.", "---", ""].join("\n"),
      )
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ query: "signing rotation machine" }, ctx)

      // loud-tag carries `signing` as a literal tag and matches one word.
      // broad-answer carries no tags and matches two - and two beats one.
      expect(result.output.indexOf("wiki/pages/broad-answer")).toBeLessThan(
        result.output.indexOf("wiki/pages/loud-tag"),
      )
    }),
  )

  it.instance("indexes a page with no front matter at all", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* write(
        test.directory,
        "wiki/pages/plain.md",
        ["# Rotating the signing key", "", "Do it from the release machine, never from a laptop.", ""].join("\n"),
      )
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ query: "signing key" }, ctx)

      expect(result.metadata.matches).toBe(1)
      // Title falls back to the `#` heading, description to the first
      // paragraph, tags to none - and the row still says all three.
      expect(result.output).toContain("wiki/pages/plain")
      expect(result.output).toContain("[no tags]")
      expect(result.output).toContain("Do it from the release machine")
    }),
  )

  it.instance("separates an empty knowledge base from an absent one", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.mkdir(path.join(test.directory, "wiki"), { recursive: true }))
      const search = yield* (yield* WikiSearchTool).init()

      const result = yield* search.execute({ query: "anything" }, ctx)

      expect(result.output).toContain("No markdown pages under")
      expect(result.output).not.toContain("No wiki roots found")
    }),
  )

  it.instance("clamps limit into 1..20", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const search = yield* (yield* WikiSearchTool).init()

      const zero = yield* search.execute({ tags: ["deploy"], limit: 0 }, ctx)
      expect(zero.metadata.matches).toBe(3)
      expect(zero.output.split("(matched:").length - 1).toBe(1)

      const huge = yield* search.execute({ tags: ["deploy"], limit: 999 }, ctx)
      expect(huge.output.split("(matched:").length - 1).toBe(3)
    }),
  )
})

describe("tool.wiki_related", () => {
  it.instance("reports the pages that link TO a page, not just from it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const related = yield* (yield* WikiRelatedTool).init()

      const result = yield* related.execute({ page: "wiki/pages/bundle-verification" }, ctx)

      expect(result.metadata.inbound).toBe(1)
      expect(result.metadata.links).toBe(0)
      expect(result.output).toContain("inbound links (1)")
      expect(result.output).toContain("wiki/pages/deploy-ritual")
      expect(result.output).toContain("outbound links (0)")
    }),
  )

  it.instance("marks an outbound link with no page behind it as unwritten", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const related = yield* (yield* WikiRelatedTool).init()

      // Resolved by BASENAME, not by the full page id - and it says so.
      const result = yield* related.execute({ page: "deploy-ritual" }, ctx)

      expect(result.output).toContain("by basename match")
      expect(result.output).toContain("rotate-secrets (unwritten)")
      expect(result.output).toContain("wiki/pages/bundle-verification")
    }),
  )

  it.instance("ranks shared-tag neighbours by how many tags they share", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const related = yield* (yield* WikiRelatedTool).init()

      const result = yield* related.execute({ page: "wiki/pages/deploy-ritual" }, ctx)

      const shared = result.output.slice(result.output.indexOf("shared tags ("))
      expect(shared).toContain("shared tags (3)")
      // release-notes shares both `deploy` and `origami`; the other two share one
      // each, so it has to come first.
      expect(shared.indexOf("wiki/pages/release-notes")).toBeLessThan(shared.indexOf("wiki/pages/coder-internals"))
      expect(shared).toContain("(2 shared: deploy, origami)")
    }),
  )

  it.instance("adds one indented hop at depth 2", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      yield* write(
        test.directory,
        "wiki/pages/bundle-verification.md",
        [
          "---",
          "tags: [deploy, verification]",
          "description: How to prove the packaged artifact contains the work you just did.",
          "---",
          "",
          "# Bundle Verification",
          "",
          "Compare against [[release-notes]] before you sign off.",
          "",
        ].join("\n"),
      )
      const related = yield* (yield* WikiRelatedTool).init()

      const one = yield* related.execute({ page: "wiki/pages/deploy-ritual" }, ctx)
      expect(one.output).not.toContain("-> wiki/pages/release-notes")

      const two = yield* related.execute({ page: "wiki/pages/deploy-ritual", depth: 2 }, ctx)
      // deploy-ritual -> bundle-verification -> release-notes, and only the
      // second hop is reached by asking for depth 2.
      expect(two.output).toContain("      -> wiki/pages/release-notes")
    }),
  )

  it.instance("returns nearest page ids instead of an error when nothing resolves", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* fixture(test.directory)
      const related = yield* (yield* WikiRelatedTool).init()

      const result = yield* related.execute({ page: "zzzzzzzzzz" }, ctx)

      expect(result.output).toContain("No page resolved")
      expect(result.output).toContain("nearest page ids:")
      expect(result.metadata.inbound).toBe(0)
    }),
  )

  it.instance("says honestly when the workspace has no knowledge roots", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => fs.rm(path.join(test.directory, "wiki"), { recursive: true, force: true }))
      yield* Effect.promise(() =>
        fs.rm(path.join(test.directory, ".origami", "memory"), { recursive: true, force: true }),
      )
      const related = yield* (yield* WikiRelatedTool).init()

      const result = yield* related.execute({ page: "anything" }, ctx)

      expect(result.output).toContain("No wiki roots found")
      expect(result.output).toContain(path.join(test.directory, ".origami", "memory"))
    }),
  )
})
