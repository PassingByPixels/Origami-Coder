import { ProviderEffortDemotion } from "@/provider/effort-demotion"
import { SessionCacheState } from "@/session/cache-state"
import { SessionCacheWarm } from "@/session/cache-warm"
import { SessionDegrade } from "@/session/degrade"
import { SessionEffortTier } from "@/session/effort-tier"
import { SessionImageCap } from "@/session/image-cap"
import { resetPeerMessages } from "@/session/peer-message"
import { SessionPromptCapture } from "@/session/prompt-capture"
import { SessionRequestMemoryRows } from "@/session/request-memory-rows"
import { SessionToolAging } from "@/session/tool-aging"
import { SessionWindowFit } from "@/session/window-fit"

/**
 * The module-level memory an engine process loses when it stops (t-w2qb1x).
 *
 * `resetForTest` empties every per-session store in one call, so an in-process
 * test can stand for a process restart: close the first runtime, call this,
 * build a second runtime over the same database. A store that feeds the request
 * bytes must survive that, so it is persisted in SQLite and loaded on a miss
 * (session/request-memory.ts). test/engine-process-memory.test.ts (G1) lists
 * every module-level store in src and fails on one that is not classified.
 *
 * Layer-scoped state (for example the `tool_search` loaded set inside the
 * ToolSearch service) is not reset here: building a new runtime replaces it.
 */
export function resetForTest(): void {
  SessionToolAging.reset()
  SessionDegrade.reset()
  SessionImageCap.reset()
  SessionWindowFit.reset()
  SessionRequestMemoryRows.reset()
  SessionPromptCapture.reset()
  SessionEffortTier.reset()
  SessionCacheWarm.reset()
  SessionCacheState.reset()
  ProviderEffortDemotion.forget()
  resetPeerMessages()
}

/**
 * Free what this process holds for one session whose chat closed (t-w2u5vf).
 *
 * Every per-session entry in the stores above goes, except two:
 * - the rows queued and not yet written (`SessionRequestMemoryRows`): the only
 *   copy of a decision not on disk yet. `SessionRequestMemory.ensure` reads
 *   them back with the stored rows when the chat is reopened here, and the
 *   next request writes them;
 * - the peer-message dedupe (`peer-message.ts`): a repeat delivered after a
 *   reopen must still be dropped, and it is bounded (64 x 64 ids).
 * The persisted stores reload on the first miss, so a reopened chat sends the
 * bytes it would have sent without the close (test/session/close-memory.test.ts).
 * The caller decides that the session is closed: never call this for a
 * session that is open or running in this process.
 */
export function evictSession(sessionID: string): void {
  SessionToolAging.evict(sessionID)
  SessionDegrade.evict(sessionID)
  SessionImageCap.evict(sessionID)
  SessionWindowFit.evict(sessionID)
  SessionPromptCapture.evict(sessionID)
  SessionEffortTier.evict(sessionID)
  SessionCacheWarm.evict(sessionID)
  SessionCacheState.evict(sessionID)
}

export * as EngineProcessMemory from "./engine-process-memory"
