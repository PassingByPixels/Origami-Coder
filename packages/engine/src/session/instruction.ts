import { LayerNode } from "@origami/core/effect/layer-node"
import { httpClient } from "@origami/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@origami/core/v1/session"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@origami/core/flag/flag"
import { FSUtil } from "@origami/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@origami/core/global"
import { MemoryLayout } from "@/tool/memory-layout"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

/**
 * The prefix every entry `system()` returns is formatted with. By the time
 * `input.system` reaches the request layer its labels are gone - one flat
 * array of strings - so this is the load-bearing signal a caller uses to tell
 * an instruction-file block apart from any other system-prompt text (env,
 * mcp, skills, the collab layers). Nothing else in the prompt pipeline
 * produces this exact prefix.
 */
export const PREFIX = "Instructions from: "

/** Whether one `input.system` entry came from `system()` above. */
export function isInstructionText(text: string): boolean {
  return text.startsWith(PREFIX)
}

/**
 * Content as SERVED into the prompt. Only the memory index is transformed: it
 * gains the recall instruction + its directory's absolute path, so the model
 * knows a hook is a pointer and knows where to read the topic file from. The
 * footer is appended HERE, never written to MEMORY.md - the file on disk stays
 * a clean catalog that dream and a human can edit without stepping around
 * engine boilerplate.
 */
export function serve(filepath: string, content: string): string {
  if (!MemoryLayout.isIndexPath(filepath)) return content
  return `${content.replace(/\s+$/, "")}\n${MemoryLayout.indexFooter(path.dirname(path.resolve(filepath)))}`
}

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  /** The instruction FILES only - the memory store is served by `memory()`. */
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  /**
   * The memory store, served exactly as `system()` used to serve it (same
   * `PREFIX` line, same recall footer). Split out because the `remember` tool
   * REWRITES these files mid-conversation, and anything the caller puts in the
   * cached system prefix is invalidated wholesale when it changes - so the
   * caller delivers this at the TAIL of the message list instead.
   */
  readonly memory: () => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@origami/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.ORIGAMI_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    // Agent-owned memory stores written by the `remember` tool. Loaded like
    // instruction files but kept SEPARATE from AGENTS.md/CLAUDE.md so the
    // agent's writes can never clobber human-authored rules. The path
    // convention lives in tool/memory-layout.ts so reader and writer cannot
    // drift: ~/.origami (cross-project) and <worktree>/.origami (this
    // project).
    //
    // Per scope, EXACTLY ONE file is loaded:
    //   <origami>/memory/MEMORY.md  the index - the current layout, cheap:
    //                               one hook line per topic, topic bodies
    //                               read on demand by the model.
    //   <origami>/memory.md         the LEGACY flat store - loaded only when
    //                               there is no index, so an un-migrated
    //                               machine keeps every fact it had.
    // Never both: loading a flat file next to an index would re-import the
    // bulk the index exists to avoid, and double-report facts already split
    // into topics.
    const memoryPaths = Effect.fn("Instruction.memoryPaths")(function* () {
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()
      for (const origami of [Global.Path.origami, path.join(ctx.worktree, ".origami")]) {
        const index = MemoryLayout.indexPath(MemoryLayout.memoryDir(origami))
        if (yield* fs.existsSafe(index)) {
          paths.add(path.resolve(index))
          continue
        }
        const flat = MemoryLayout.flatMemoryPath(origami)
        if (yield* fs.existsSafe(flat)) paths.add(path.resolve(flat))
      }
      return paths
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.ORIGAMI_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      // The memory store is part of the INVENTORY - `acp/instructions.ts`
      // classifies its rows off this set - even though `system()` no longer
      // serves it. See `memoryPaths` above.
      for (const item of yield* memoryPaths()) paths.add(item)

      return paths
    })

    const served = Effect.fnUntraced(function* (paths: string[]) {
      const files = yield* Effect.forEach(paths, read, { concurrency: 8 })
      return paths.flatMap((item, i) => (files[i] ? [`${PREFIX}${item}\n${serve(item, files[i])}`] : []))
    })

    const memory = Effect.fn("Instruction.memory")(function* () {
      return yield* served(Array.from(yield* memoryPaths()))
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      // The memory store is delivered separately by `memory()`, so it is
      // subtracted here rather than never added: `systemPaths()` is the
      // instruction INVENTORY and has to keep reporting it.
      for (const item of yield* memoryPaths()) paths.delete(item)
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* served(Array.from(paths))
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [...files, ...urls.flatMap((item, i) => (remote[i] ? [`${PREFIX}${item}\n${remote[i]}`] : []))]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found)) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      return results
    })

    return Service.of({ clear, systemPaths, system, memory, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
