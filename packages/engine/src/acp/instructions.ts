import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { CollabSystem } from "@/collab/collab-system"
import { Config } from "@/config/config"
import { Instruction } from "@/session/instruction"
import { SystemPrompt } from "@/session/system"
import { FSUtil } from "@origami/core/fs-util"
import { Global } from "@origami/core/global"
import { Effect } from "effect"
import path from "path"
import type * as ACPError from "./error"

/**
 * Read-only inventory of everything that feeds the system prompt, for the
 * `list_instructions` ext method. Sizes only for the FILES — the shell opens
 * those itself, so their contents never cross the wire.
 *
 * The exceptions are the OVERRIDE rows, and none of them is a file: the shipped
 * prompt text is compiled into this binary, so a shell that wants to show it —
 * or seed the override file with it — has nowhere else to read it from.
 */

/**
 * The two built-in prompts a user can replace with a file of their own. Each
 * gets a row carrying its EFFECTIVE text and the path that overrides it.
 *
 * The collab room manual used to be a third. It is gone: one base prompt now
 * states the room's rules, and what is left below the persona is live turn
 * state with no file behind it and nothing for a user to edit.
 */
export type OverrideSource = "base-prompt" | "collab-agent-base"

export type InstructionSource = "global" | "project" | "config" | "memory" | "url" | OverrideSource

export type InstructionEntry = {
  readonly path: string
  readonly source: InstructionSource
  readonly chars: number
  readonly bytes: number
  readonly tokensApprox: number
  /**
   * Only on an OVERRIDE entry: true when the user's own file supplies the
   * prompt, false when the shipped built-in does. Absent everywhere else — an
   * ordinary instruction file either feeds the prompt or is not listed, so it
   * has nothing to be overridden by.
   */
  readonly overridden?: boolean
}

/**
 * The EFFECTIVE text of one overridable prompt, plus the path a user edits to
 * change it.
 *
 * Carries TEXT, unlike the rest of this inventory, and deliberately: a shell
 * has to SEED the override file with what the model is really being told today,
 * and the built-in is compiled into the binary — there is no file for the shell
 * to read it out of instead.
 */
export type BasePrompt = {
  readonly path: string
  readonly overridden: boolean
  readonly text: string
}

export type InstructionSet = {
  readonly entries: readonly InstructionEntry[]
  readonly totalChars: number
  readonly totalBytes: number
  readonly totalTokensApprox: number
  /**
   * Names the estimator so a caller never mistakes it for a measurement.
   * These counts are NOT tokenised — they are a chars/4 heuristic.
   */
  readonly tokensApproxMethod: "chars/4"
  /** Absent only from a caller that built a set without resolving one. */
  readonly basePrompt?: BasePrompt
  /** The base prompt every COLLAB agent gets, above its own persona. */
  readonly collabAgentBase?: BasePrompt
}

/** The seam the ACP service depends on, so tests need no engine boot. */
export type Interface = {
  readonly list: (directory: string) => Effect.Effect<InstructionSet, ACPError.Error>
}

/** The heuristic, stated plainly: 4 characters per token, rounded up. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/**
 * Label a resolved instruction path. `Instruction.systemPaths()` returns a flat
 * Set with no provenance, so classification is done by matching against the
 * exact paths its resolver can produce.
 *
 * KNOWN LIMIT: a `config.instructions` glob that happens to resolve to an
 * AGENTS.md/CLAUDE.md/CONTEXT.md inside the worktree is reported as `project`.
 * The file is still listed with correct sizes; only its label is ambiguous.
 */
export function classify(input: {
  readonly filepath: string
  readonly globalPaths: readonly string[]
  readonly memoryPaths: readonly string[]
  readonly worktree: string
}): InstructionSource {
  const target = path.resolve(input.filepath)
  const same = (other: string) => path.resolve(other) === target
  if (input.memoryPaths.some(same)) return "memory"
  if (input.globalPaths.some(same)) return "global"
  const base = path.basename(target)
  const withinWorktree = target.startsWith(path.resolve(input.worktree) + path.sep)
  if (withinWorktree && (base === "AGENTS.md" || base === "CLAUDE.md" || base === "CONTEXT.md")) return "project"
  return "config"
}

/**
 * One override row and the object that lets a shell seed the override file.
 *
 * `override` is the user's file content when it exists and is non-empty, and
 * undefined otherwise; the sizes are always the EFFECTIVE prompt's, so the row
 * measures what the model is really sent either way.
 *
 * The path is the override path in BOTH cases. When nothing overrides it that
 * file does not exist yet, and `overridden: false` says so — but naming the
 * place a user would edit is the entire reason this row is on screen.
 */
export function overrideRow(input: {
  readonly source: OverrideSource
  readonly builtIn: string
  readonly overridePath: string
  readonly override: string | undefined
}): { readonly info: BasePrompt; readonly entry: InstructionEntry } {
  const overridden = input.override !== undefined
  const text = input.override ?? input.builtIn
  return {
    info: { path: input.overridePath, overridden, text },
    entry: {
      path: input.overridePath,
      source: input.source,
      chars: text.length,
      bytes: Buffer.byteLength(text, "utf8"),
      tokensApprox: estimateTokens(text.length),
      overridden,
    },
  }
}

export function totals(entries: readonly InstructionEntry[], basePrompt?: BasePrompt): InstructionSet {
  return {
    entries,
    totalChars: entries.reduce((sum, entry) => sum + entry.chars, 0),
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    totalTokensApprox: entries.reduce((sum, entry) => sum + entry.tokensApprox, 0),
    tokensApproxMethod: "chars/4",
    ...(basePrompt === undefined ? {} : { basePrompt }),
  }
}

/**
 * Runs against the process-wide AppRuntime, which already provides every
 * service used here. Building a private layer stack instead would stand up a
 * SECOND Database/Config/Plugin instance and deadlock against the live one.
 */
export const list = Effect.fn("ACPInstructions.list")(function* (directory: string) {
  const store = yield* InstanceStore.Service
  const instruction = yield* Instruction.Service
  const cfg = yield* Config.Service
  const fs = yield* FSUtil.Service
  // `Global.make()` is exactly what Global's own layer wraps (`Service.of(make())`),
  // so these match the resolver's values without needing the service — which
  // AppRuntime does not expose at the top level.
  const global = Global.make()

  const globalPaths = [path.join(global.config, "AGENTS.md"), path.join(global.home, ".claude", "CLAUDE.md")]
  const ctx = yield* store.load({ directory })

  return yield* Effect.gen(function* () {
    const paths = yield* instruction.systemPaths().pipe(Effect.catch(() => Effect.succeed(new Set<string>())))
    const config = yield* cfg.get().pipe(Effect.catch(() => Effect.succeed({} as { instructions?: string[] })))
    const memoryPaths = [
      path.join(Global.Path.origami, "memory.md"),
      path.join(ctx.worktree, ".origami", "memory.md"),
    ]

    const files = yield* Effect.forEach(
      Array.from(paths),
      Effect.fnUntraced(function* (filepath: string) {
        // Read purely to size it; the content is discarded here.
        const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const text = content ?? ""
        return {
          path: filepath,
          source: classify({ filepath, globalPaths, memoryPaths, worktree: ctx.worktree }),
          chars: text.length,
          bytes: Buffer.byteLength(text, "utf8"),
          tokensApprox: estimateTokens(text.length),
        } satisfies InstructionEntry
      }),
      { concurrency: 8 },
    )

    // Remote instructions are declared in config, never in systemPaths().
    // Listed with zero sizes: measuring them would mean fetching them, and
    // this method must stay a cheap read-only inventory.
    const urls = (config.instructions ?? [])
      .filter((item) => item.startsWith("https://") || item.startsWith("http://"))
      .map((item): InstructionEntry => ({ path: item, source: "url", chars: 0, bytes: 0, tokensApprox: 0 }))

    // FIRST, always. Every other row is a file the user added on top; these are
    // the prompts they never chose and, until now, could not see — so they lead
    // the inventory rather than sorting in among the files by size.
    //
    // The collab row reaches only COLLAB turns, not every prompt. It is listed
    // here anyway because it is the same kind of thing — shipped prompt text,
    // editable at a named path — and a user who cannot see it cannot change it.
    const base = overrideRow({
      source: "base-prompt",
      builtIn: SystemPrompt.BASE_PROMPT_BUILTIN,
      overridePath: SystemPrompt.basePromptPath(),
      override: SystemPrompt.basePromptOverride(),
    })
    const collabAgentBase = overrideRow({
      source: "collab-agent-base",
      builtIn: CollabSystem.AGENT_BASE_BUILTIN,
      overridePath: CollabSystem.agentBasePath(),
      override: CollabSystem.agentBaseOverride(),
    })
    return {
      ...totals([base.entry, collabAgentBase.entry, ...files, ...urls], base.info),
      collabAgentBase: collabAgentBase.info,
    }
  }).pipe(Effect.provideService(InstanceRef, ctx))
})

export * as Instructions from "./instructions"
