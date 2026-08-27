import { Effect, Schema } from "effect"
import path from "path"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { Agent } from "@/agent/agent"
import { AgentBotMemory } from "@/agent/bot-memory"
import { InstanceState } from "@/effect/instance-state"
import {
  appendTopicFact,
  indexPath,
  INDEX_HEADER,
  memoryDir,
  oneLineHook,
  topicPath,
  topicSlug,
  upsertIndexEntry,
} from "./memory-layout"
import * as Tool from "./tool"

export const MEMORY_HEADER = [
  "# Origami Memory",
  "<!-- Facts, preferences, and decisions the agent appended via the `remember` tool.",
  "     Kept as a SEPARATE file from AGENTS.md / CLAUDE.md so these appends can never",
  "     clobber your own rules. Newest last; capped at the most recent 100 entries.",
  "     Human-editable — remove or reword any line. -->",
].join("\n")

export const CAP = 100

/** The `.origami` directory holding this project's agent-owned state. */
export function projectOrigamiDir(worktree: string): string {
  return path.join(worktree, ".origami")
}

/** LEGACY flat project store. Still READ (instruction.ts falls back to it on an
 *  un-migrated machine) but never written again - see memory-layout.ts. */
export function projectMemoryPath(worktree: string): string {
  return path.join(projectOrigamiDir(worktree), "memory.md")
}
/** LEGACY flat global store (~/.origami/memory.md). Read-only, as above. */
export function globalMemoryPath(globalDir: string): string {
  return path.join(globalDir, "memory.md")
}

/** Foldered project store: `<worktree>/.origami/memory/`. */
export function projectMemoryDir(worktree: string): string {
  return memoryDir(projectOrigamiDir(worktree))
}
/** Foldered global store: `~/.origami/memory/`. */
export function globalMemoryDir(globalDir: string): string {
  return memoryDir(globalDir)
}

/** Append a fact to a memory file's content, normalising to header + capped
 *  bullets. Pure so the real logic (bullet extraction, dedup of blank facts,
 *  cap-to-most-recent, formatting) is testable without the filesystem. */
/** Normalise store text to header + capped-to-most-recent bullets. Pure, so the
 *  format is defined once and reused by appendFact (remember tool) and the dream
 *  tool's adopt path — a hand-authored candidate is coerced to the exact same
 *  shape so future `remember` appends never fight the reorganisation. */
export function normalizeStore(existing: string, cap = CAP): string {
  const bullets: string[] = existing.match(/^- .*/gm) ?? []
  const capped = bullets.length > cap ? bullets.slice(-cap) : bullets
  return `${MEMORY_HEADER}\n\n${capped.join("\n")}\n`
}

export function appendFact(existing: string, fact: string, date: string, cap = CAP): string {
  const clean = fact.replace(/\s+/g, " ").trim()
  return normalizeStore(`${existing}\n- [${date}] ${clean}`, cap)
}

const DESCRIPTION = [
  "Persist a durable fact, preference, decision, or gotcha to memory so it survives across sessions and compaction.",
  "Use it when the user asks you to remember something, or when you learn a project-specific fact worth keeping",
  "(a build/test command, an architectural decision, a recurring pitfall, a naming/style preference).",
  "Memory is a FOLDER of topic files plus an index: the fact is appended to .origami/memory/<topic>.md",
  "(or ~/.origami/memory/<topic>.md with global=true) and the topic is listed in MEMORY.md, the index loaded",
  "into your context every session. Only the index is always loaded, so you read a topic file when you need it.",
  "Pick a TIGHT topic and REUSE an existing one from the index rather than coining a near-duplicate - a fact about",
  "the same subject belongs in the same file. Keep each fact to one concise line.",
  "This is NOT for transient task state - only things genuinely worth recalling in a later session.",
  // The model must not be told a location that is not where its own fact goes.
  // A bot's store is chosen by WHICH AGENT is running, so `global` genuinely
  // has no effect there and saying otherwise would invite it to keep trying.
  "If you are a configured agent with your own definition file, this writes to YOUR OWN memory instead,",
  "and the global flag does not apply - your memory is yours and no other session reads it.",
].join(" ")

export const Parameters = Schema.Struct({
  fact: Schema.String.annotate({
    description: "A single concise fact, preference, decision, or gotcha to remember across sessions.",
  }),
  topic: Schema.optional(Schema.String).annotate({
    description:
      "Topic file to append to, e.g. 'build-commands' or 'reference_gitea'. Reuse a topic already listed in the" +
      " memory index instead of creating a near-duplicate; only coin a new one for a genuinely new subject." +
      " Defaults to 'general'.",
  }),
  global: Schema.optional(Schema.Boolean).annotate({
    description:
      "Store in the cross-project global memory (~/.origami/memory/) instead of this project's memory. Default false.",
  }),
})

export const RememberTool = Tool.define(
  "remember",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const agents = yield* Agent.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { fact: string; topic?: string; global?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const fact = params.fact?.trim()
          if (!fact) throw new Error("fact is required")
          const instance = yield* InstanceState.context
          const date = new Date().toISOString().slice(0, 10)

          // A BOT WRITES TO ITS OWN STORE, and nowhere else.
          //
          // The turn's agent decides this, not a parameter: a bot session and a
          // collab participation of the same definition both run under that
          // definition, so both land in the same directory - the bot's. `global`
          // is IGNORED here rather than honoured, and that is the fence: a bot
          // that could set it would be writing into the user's cross-project
          // memory, which every MAIN session reads. A bot's recollection is its
          // own, and a main session never sees it.
          const botDir = yield* AgentBotMemory.dirFor({
            name: ctx.agent,
            info: yield* agents.get(ctx.agent),
            definitionFile: (name) => agents.definitionFile(name),
          })
          if (botDir) {
            // FSUtil is provided EXPLICITLY: the service resolved when the tool
            // was built is not in the context this execute runs under, and
            // without it the write dies and the room sees the call as an error.
            const written = yield* AgentBotMemory.write({ memdir: botDir, topic: params.topic, fact, date }).pipe(
              Effect.provideService(FSUtil.Service, fs),
              Effect.orDie,
            )
            return {
              title: "remember",
              metadata: { path: written.path, index: written.index, topic: written.topic, scope: "bot" },
              output: `Remembered (your own memory, topic "${written.topic}" -> ${written.path}): ${fact}`,
            }
          }
          // A non-git workspace resolves worktree to "/" (drive root — C:\ on
          // Windows), so a "project" store there writes to C:\.origami\memory\:
          // shared across EVERY user account and every non-git folder, not the
          // per-user home. Treat such a workspace as project-less and use the
          // per-user global store, mirroring the exact predicate plans use
          // (session.ts plan(): instance.project.vcs ? worktree : Global).
          const scopeGlobal = params.global === true || !instance.project.vcs
          const memdir = scopeGlobal ? globalMemoryDir(Global.Path.origami) : projectMemoryDir(instance.worktree)

          const topic = topicSlug(params.topic)
          const target = topicPath(memdir, topic)
          const index = indexPath(memdir)

          // Topic file first, index second: an index line pointing at a file
          // that failed to write is a dangling hook, and the reverse (a file
          // with no index line) is merely unlisted — the fact still survives
          // and the next remember for that topic re-adds the entry.
          const existing = yield* fs.readFileStringSafe(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          // writeWithDirs creates .origami/memory/ if missing (mirrors
          // WriteTool). No permission ask: this is a purpose-built append to
          // the agent's own memory store, not an arbitrary file write.
          yield* fs.writeWithDirs(target, appendTopicFact(existing ?? "", topic, fact, date)).pipe(Effect.orDie)

          const indexText = yield* fs.readFileStringSafe(index).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const nextIndex = upsertIndexEntry(indexText?.trim() ? indexText : INDEX_HEADER, topic, oneLineHook(fact))
          // Remembering into an EXISTING topic leaves the index byte-identical
          // (upsertIndexEntry returns it untouched — the hooks are curated), so
          // the common case wrote the same bytes back and bumped mtime for
          // nothing.
          if (nextIndex !== indexText) yield* fs.writeWithDirs(index, nextIndex).pipe(Effect.orDie)

          const where = scopeGlobal ? "global memory" : "project memory"
          return {
            title: "remember",
            metadata: { path: target, index, topic, scope: scopeGlobal ? "global" : "project" },
            output: `Remembered (${where}, topic "${topic}" -> ${target}): ${fact}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
