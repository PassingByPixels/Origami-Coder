import { Context, Effect } from "effect"
import fs from "fs"
import path from "path"
import { Global } from "@origami/core/global"
import type { CollabStore } from "./store"

import COLLAB_AGENT_BASE from "./collab-agent-base.txt"

/**
 * The SYSTEM layers a collab turn adds, and the channel that carries them to
 * the request layer. A collab agent has a persona of its own, so
 * `LLMRequestPrep.prepare` gives it NO base prompt; this is the statement of
 * what the room is, and it sits ABOVE the persona. The room STATE rides the
 * same channel BELOW the persona, and is live state only - never prose.
 */

/** The file a user writes to replace the built-in collab agent base prompt. */
export const AGENT_BASE_FILE = "collab-agent-base.md"

/** The base prompt this fork ships. What `collab-agent-base.md` replaces. */
export const AGENT_BASE_BUILTIN: string = COLLAB_AGENT_BASE

/** Where the override lives: the SAME global config directory as `base-prompt.md`,
 *  resolved through `Global.make()` on each call - a module-load constant would
 *  freeze the path before a test or a wrapper could redirect it. */
export function agentBasePath(): string {
  return path.join(Global.make().config, AGENT_BASE_FILE)
}

/** The user's base prompt for collab agents, or undefined when there is none. A
 *  missing, unreadable or whitespace-only file is NOT an override: an empty file
 *  would leave every collab agent with no statement of what it is. */
export function agentBaseOverride(): string | undefined {
  try {
    const text = fs.readFileSync(agentBasePath(), "utf8")
    return text.trim().length === 0 ? undefined : text
  } catch {
    return undefined
  }
}

/** The user's file when it has one, else the built-in. */
export function agentBase(): string {
  return agentBaseOverride() ?? AGENT_BASE_BUILTIN
}

/**
 * The tools a collab turn adds, by id. Named here rather than in
 * `flock-tools.ts` because the REQUEST layer needs the list too: they are the
 * collab PROTOCOL, not a capability a user grants.
 */
export const TOOL_IDS = [
  "ask",
  "handoff",
  "done",
  "task_add",
  "task_claim",
  "task_done",
  "task_accept",
  "task_reopen",
  // Council rooms only in EFFECT, but present in every room's list: the tool
  // itself refuses outside a synthesis turn. A per-room list would make the
  // protocol depend on a setting, and a model that found a tool missing has no
  // way to be told why.
  "council_ask",
] as const

/** What one collab turn adds to the system prompt, in layer order. */
export type Layers = {
  /** Above the persona. */
  readonly base: string
  /** Below the persona: this turn's live room state, never prose. */
  readonly state: string
}

/** One agent in the room, with the session its turns run in. */
export type RosterEntry = {
  readonly agentSlug: string
  readonly displayName: string
  /** The agent's child session, or null while it has never taken a turn. */
  readonly sessionId: string | null
}

/**
 * The hop budget one human message bought. Deliberately MUTABLE and shared BY
 * REFERENCE: a nested `ask` runs on the same budget as the turn that asked for
 * it, so a chain cannot buy itself more room by going one level deeper.
 */
export type Hops = { remaining: number | null }

/** The turn-terminating signal `handoff` and `done` raise. A tool cannot break
 *  its own agent's loop, so it records the intent here and the loop reads it. */
export type Stop = {
  requested: boolean
  /** `done` may post a closing summary; a `handoff` already said its piece. */
  kind?: "done" | "handoff"
  summary: string
}

/** What one nested `ask` produced. */
export type AskOutcome = {
  /** The target's final text. Empty means it chose silence. */
  readonly text: string
  readonly trace: readonly CollabStore.TraceEntry[]
  readonly error?: string
  readonly stepCapped?: boolean
}

export type AskRequest = {
  readonly target: string
  readonly sessionId: string
  readonly from: string
  readonly task: string
  readonly context?: string
  readonly expect?: string
  /** The board row the asking tool opened for this work, named in the brief. */
  readonly taskId?: string
  readonly askChain: readonly string[]
  /** The SAME handle the caller holds - one budget for the whole chain. */
  readonly hops: Hops
}

/**
 * What the flock tools may do, handed in by the runner rather than resolved
 * from the Effect context: passing closures keeps the tools free of any import
 * of the runner, which imports the prompt loop that injects them.
 */
export type TurnOps = {
  /** Append one message to the room and fan it out through the wake rules. */
  readonly append: (input: CollabStore.AppendInput) => Effect.Effect<CollabStore.Message, unknown>
  /** The task board. Board moves are records, and never wake anyone by themselves. */
  readonly store: CollabStore.Interface
  /** The target's persistent child session, created on first use. */
  readonly session: (agentSlug: string) => Effect.Effect<string, unknown>
  /** Run ONE nested turn on the target and answer with what it produced. */
  readonly ask: (input: AskRequest) => Effect.Effect<AskOutcome, unknown>
  /** Give the target the baton: queue its turn and wake the collab's drain. */
  readonly handoff: (agentSlug: string) => Effect.Effect<void>
}

/** Everything one collab turn knows about itself and the room around it. */
export type TurnContext = Layers & {
  readonly collabId: string
  readonly title: string
  readonly agentSlug: string
  readonly sessionId: string
  readonly lead: string | null
  readonly objective: string | null
  readonly roster: readonly RosterEntry[]
  /** The sessions waiting on this one, oldest first. Empty at the top. */
  readonly askChain: readonly string[]
  readonly hops: Hops
  readonly stop: Stop
  /**
   * Which half of a COUNCIL round this turn is, when it is one at all. Absent
   * in a discuss room. The `council_ask` tool is the only reader: only the
   * SYNTHESIS may put a follow-up back to the council, because a question asked
   * from inside a blind opinion would nest a round in the one being answered.
   */
  readonly council?: { readonly phase: "opinion" | "synthesis" }
  readonly ops: TurnOps
}

/**
 * Set by the collab runner for the turn it is driving, read by
 * `LLMRequestPrep.prepare` (for the layers) and by the flock tools.
 *
 * A Context reference rather than a registry keyed by session id: the value is
 * scoped to the turn's own fiber, so two collabs running at once cannot read
 * each other's roster. Absent everywhere else.
 */
export const Turn = Context.Reference<TurnContext | undefined>("~origami/CollabTurn", {
  defaultValue: () => undefined,
})

export * as CollabSystem from "./collab-system"
