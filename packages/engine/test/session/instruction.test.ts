import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@origami/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@origami/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@origami/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@origami/core/provider"
import { ModelV2 } from "@origami/core/model"
import { AppNodeBuilder } from "@origami/core/effect/app-node-builder"
import { LayerNode } from "@origami/core/effect/layer-node"
import { LayerNodePlatform } from "@origami/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )

  it.live("caps an oversized AGENTS.md end-to-end through system()", () =>
    withFiles({ "AGENTS.md": `${"a".repeat(99)}\n`.repeat(205) }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()

        expect(rules).toHaveLength(1)
        const [rule] = rules
        expect(rule).toStartWith(`Instructions from: ${path.join(dir, "AGENTS.md")}\n`)
        expect(rule).toContain("truncated at 16 KB; 4200 bytes omitted — read the file for the rest]")
        // The served body (after the PREFIX line) is at or under the cap.
        const body = rule.slice(rule.indexOf("\n") + 1)
        const beforeNotice = body.slice(0, body.indexOf("["))
        expect(Buffer.byteLength(beforeNotice, "utf8")).toBeLessThanOrEqual(16 * 1024)
      }),
    ),
  )
})

describe("Instruction.truncate", () => {
  // token_burn_plan §2.3: instruction.ts used to read AGENTS.md/CLAUDE.md
  // unbounded. Fixture math is computed independently below (100-byte lines:
  // 99 "a"s + "\n"), not by re-deriving the algorithm under test.
  const LINE = `${"a".repeat(99)}\n` // 100 bytes/chars, ASCII only
  const REPEATS = 205 // 205 * 100 = 20,500 bytes > INSTRUCTION_CAP_BYTES (16,384)
  const big = LINE.repeat(REPEATS)

  test("content at or under the cap is served unchanged", () => {
    const under = LINE.repeat(153) // 15,300 bytes < 16,384
    expect(Instruction.truncate("/repo/AGENTS.md", under)).toBe(under)
    // Exactly at the cap: still unchanged (cap is inclusive).
    const exact = "a".repeat(16 * 1024)
    expect(Instruction.truncate("/repo/AGENTS.md", exact)).toBe(exact)
  })

  test("a 20 KB file is capped at 16 KB, cut on a line break, with a one-line notice", () => {
    const out = Instruction.truncate("/repo/AGENTS.md", big)

    // 163 full lines (indices 0..162) = 16,300 bytes is the last newline
    // inside the first 16,384 bytes: line k's "\n" sits at offset 100k+99,
    // and 100*162+99 = 16,299 is the largest such offset under 16,384.
    const expectedKept = LINE.repeat(163)
    const notice = "[AGENTS.md truncated at 16 KB; 4200 bytes omitted — read the file for the rest]"

    expect(Buffer.byteLength(expectedKept, "utf8")).toBe(16300)
    expect(out).toBe(expectedKept + notice)
    expect(Buffer.byteLength(big, "utf8") - 16300).toBe(4200)
    // The cut lands on a line break: everything before the notice is whole lines.
    expect(expectedKept.endsWith("\n")).toBe(true)
    expect(Buffer.byteLength(expectedKept, "utf8")).toBeLessThanOrEqual(Instruction.INSTRUCTION_CAP_BYTES)
  })

  test("multi-byte UTF-8 characters survive the cut intact", () => {
    // Each line is one multi-byte char repeated + newline; well over the cap.
    const unicodeLine = `${"café-日本語-".repeat(20)}\n`
    const content = unicodeLine.repeat(200) // >> 16 KB
    const out = Instruction.truncate("/repo/AGENTS.md", content)

    expect(out).toContain("truncated at 16 KB")
    // No U+FFFD replacement character: a byte-unsafe cut would introduce one.
    expect(out).not.toContain("�")
    const beforeNotice = out.slice(0, out.indexOf("["))
    expect(beforeNotice.endsWith("\n")).toBe(true)
    expect(content.startsWith(beforeNotice)).toBe(true)
  })

  test("a single line with no break inside the cap window still cuts UTF-8-safely", () => {
    // One giant line, no "\n" until far past the cap - exercises the
    // lastNewline === -1 fallback.
    const content = `${"日".repeat(9000)}\n` // each char is 3 bytes -> 27,000 bytes before the newline
    const out = Instruction.truncate("/repo/AGENTS.md", content)

    expect(out).toContain("truncated at 16 KB")
    expect(out).not.toContain("�")
    const beforeNotice = out.slice(0, out.indexOf("["))
    expect(Buffer.byteLength(beforeNotice, "utf8")).toBeLessThanOrEqual(Instruction.INSTRUCTION_CAP_BYTES)
    // No line break existed inside the window, so truncate() injects one "\n"
    // separator before the notice; strip it before checking the kept text is
    // an exact, character-aligned prefix of the original.
    const kept = beforeNotice.endsWith("\n") ? beforeNotice.slice(0, -1) : beforeNotice
    expect(content.startsWith(kept)).toBe(true)
    expect(Buffer.byteLength(kept, "utf8") % 3).toBe(0) // whole multi-byte characters only
  })
})

describe("Instruction memory store", () => {
  // Global memory resolves from Global.Path.origami (the real home dir), which
  // this harness cannot redirect — so these exercise the PROJECT scope, where
  // the worktree comes from the instance. The selection logic is one shared
  // loop over both scopes, so what holds here holds for the global store.
  //
  // git:true is REQUIRED: the project store hangs off `worktree`, and a non-git
  // tmpdir resolves worktree to the drive root, which would point these
  // assertions at C:\.origami instead of the fixture.
  const memory = (files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).map(([name, content]) => [path.join(".origami", name), content]))

  const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeFiles(dir, files)
          return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
        }),
      { git: true },
    )

  it.live("loads the memory INDEX, not the topic files, and appends the recall footer", () =>
    withFiles(
      memory({
        "memory/MEMORY.md": "# Memory Index\n\n## References\n- [gitea](gitea.md) - the git host\n",
        "memory/gitea.md": "# gitea\n\n- [2026-08-05] port 3000, creds in the vault\n",
      }),
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const memdir = path.join(dir, ".origami", "memory")
          const paths = yield* svc.systemPaths()

          expect(paths.has(path.join(memdir, "MEMORY.md"))).toBe(true)
          // The whole point of the split: topic bodies are NOT in the prompt.
          expect(paths.has(path.join(memdir, "gitea.md"))).toBe(false)

          // The index is served by `memory()`, NOT by `system()` - it is the one
          // prompt input `remember` rewrites, so it must stay out of the cached
          // system prefix. `systemPaths()` above still reports it, because that
          // set is the instruction INVENTORY that acp/instructions.ts reads.
          expect((yield* svc.system()).some((rule) => rule.includes("Memory Index"))).toBe(false)

          const rules = yield* svc.memory()
          const served = rules.find((rule) => rule.includes("Memory Index"))
          expect(served).toBeDefined()
          expect(served).toContain("- [gitea](gitea.md) - the git host")
          expect(served).not.toContain("port 3000, creds in the vault")
          // ...and the model is told the hook is a pointer, plus where to read from.
          expect(served).toContain("The detail behind each hook is in that topic's own file, which the read tool loads on demand.")
          expect(served).toContain(memdir)
        }),
    ),
  )

  it.live("falls back to the LEGACY flat memory.md when there is no index — no silent memory loss", () =>
    withFiles(memory({ "memory.md": "# Origami Memory\n\n- [2026-08-05] an un-migrated fact\n" }), (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()

        expect(paths.has(path.join(dir, ".origami", "memory.md"))).toBe(true)
        expect((yield* svc.system()).some((rule) => rule.includes("an un-migrated fact"))).toBe(false)

        const rules = yield* svc.memory()
        const served = rules.find((rule) => rule.includes("an un-migrated fact"))
        expect(served).toBeDefined()
        // The footer belongs to the index only; a flat file has no topic files.
        expect(served).not.toContain("which the read tool loads on demand")
      }),
    ),
  )

  it.live("loads the index and NEVER the flat file when both exist", () =>
    withFiles(
      memory({
        "memory.md": "# Origami Memory\n\n- [2026-08-05] a stale pre-migration fact\n",
        "memory/MEMORY.md": "# Memory Index\n\n## Topics\n- [general](general.md) - the migrated facts\n",
      }),
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const paths = yield* svc.systemPaths()

          expect(paths.has(path.join(dir, ".origami", "memory", "MEMORY.md"))).toBe(true)
          expect(paths.has(path.join(dir, ".origami", "memory.md"))).toBe(false)

          const rules = yield* svc.memory()
          expect(rules.some((rule) => rule.includes("a stale pre-migration fact"))).toBe(false)
          expect(rules.some((rule) => rule.includes("the migrated facts"))).toBe(true)
        }),
    ),
  )

  it.live("adds nothing when the project has no memory store at all", () =>
    withFiles({ "AGENTS.md": "# Root" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(dir, ".origami", "memory", "MEMORY.md"))).toBe(false)
        expect(paths.has(path.join(dir, ".origami", "memory.md"))).toBe(false)
      }),
    ),
  )

  test("serve() only decorates the memory index, never other instruction files", () => {
    const index = path.join("/home/me/.origami/memory", "MEMORY.md")
    expect(Instruction.serve(index, "# Memory Index\n")).toContain("which the read tool loads on demand")
    expect(Instruction.serve("/repo/AGENTS.md", "# Rules\n")).toBe("# Rules\n")
  })
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})

// t-qcx1cb — the repo/branch picker gives a chat a cwd in an arbitrary repo. Two
// instruction paths then have to hold at once, and they answer different questions:
// `config.instructions` is an ABSOLUTE list resolved against nothing, so the hub's
// AGENTS.md travels with the agent; `resolve`'s walk-up is bounded by
// InstanceState.directory, so the repo's own files stay local. The risk being tested
// is DOUBLE delivery — a file already in systemPaths must not be attached a second
// time by the walk (the `sys.has(found)` gate).
describe("config.instructions with a cwd outside the instructions' own tree", () => {
  it.live("delivers the out-of-tree AGENTS.md exactly once, and still walks the repo's own", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const hubDir = yield* tmpWithFiles({ "AGENTS.md": "# Hub rules that travel with the agent" })
        const hub = path.join(hubDir, "AGENTS.md")
        yield* writeFiles(dir, {
          "AGENTS.md": "# This repo's own rules",
          "src/nested/AGENTS.md": "# Nested rules",
          "src/nested/file.ts": "const x = 1",
        })

        return yield* Effect.gen(function* () {
          const svc = yield* Instruction.Service

          const paths = yield* svc.systemPaths()
          expect(paths.has(path.resolve(hub))).toBe(true)
          expect(paths.has(path.join(dir, "AGENTS.md"))).toBe(true)

          const served = yield* svc.system()
          expect(served.filter((item) => item.includes(hub))).toHaveLength(1)
          expect(served.some((item) => item.includes("Hub rules that travel with the agent"))).toBe(true)
          expect(served.some((item) => item.includes("This repo's own rules"))).toBe(true)

          // The walk-up from a file deep in the repo attaches the SUBDIRECTORY file and
          // neither of the two already served - no duplicate, in either direction.
          const nearby = yield* svc.resolve(
            [],
            path.join(dir, "src", "nested", "file.ts"),
            MessageID.make("msg_message-hub-1"),
          )
          expect(nearby.map((item) => item.filepath)).toEqual([path.join(dir, "src", "nested", "AGENTS.md")])
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(Instruction.node, [
              [
                Config.node,
                Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed({ instructions: [hub] }) })),
              ],
              [Global.node, Global.layerWith({ home: dir, config: dir })],
              [RuntimeFlags.node, RuntimeFlags.layer({})],
            ]),
          ),
        )
      }),
    ),
  )
})
