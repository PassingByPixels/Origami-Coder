export * as ACPElastic from "./elastic"

import { RequestError } from "@agentclientprotocol/sdk"
import { AgentBroker } from "@/origami/agent-broker"
import { AgentMailbox } from "@/origami/agent-mailbox"
import { ElasticIdle } from "@/elastic/idle"
import { ElasticState } from "@/elastic/state"
import { ElasticSpare } from "@/elastic/spare"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { ElasticParkWarm } from "@/elastic/park-warm"

/**
 * The three elastic ext methods (t-w2qlop), parsed and answered. The extension
 * (lane t-w2qv3o) codes against exactly these names and shapes; the contract is
 * written down in docs/ELASTIC_EXT_METHODS.md.
 *
 *  `_elastic_class` {class: "active"|"background"|"idle"}
 *     -> {class, priority, ecoqos, childrenSet?, deferred?, error?}
 *  `_elastic_trim` {} -> {trimmed, reason?, workingSetBefore?, workingSetAfter?, childrenTrimmed?}
 *  `_elastic_idle_report` {} -> {parkable, reasons[], lastRequestAt?, warmDueAt?}
 *  `_elastic_park` {hostPid?, allow?} -> {parked: true, sessionIds[], warms?[]} | {parked: false, reasons[]}   (t-w2txb2)
 *     t-z6ytkw: `warms` = [{sessionId, dueAt}], the armed cache warms handed over (elastic/park-warm.ts)
 *  `_elastic_warm` {sessionId} -> {warmed: true, cacheRead?} | {warmed: false, reason}   (t-z6ytkw: a woken engine
 *     sends the warm its parked predecessor handed over)
 *  `_elastic_unpark` {} -> {unparked: true, delivered}   (t-wdybz9: undo a park the extension did not finish)
 *  `_elastic_spare` {} -> {spare, adopted} (t-w2u2ki: does this engine wait as a warm spare)
 *  `_elastic_adopt` {} -> {adopted} (t-y4x518: a new chat takes this spare; answered when the adoption ended)
 *
 * The first three answer synchronously from process state: none reads the store,
 * none starts an instance, and none can fail on an OS error (that comes back in
 * the result). A malformed `class` is refused with -32602 rather than coerced.
 * `_elastic_park` is the atomic last check before a stop: it reads the idle
 * report at call time and, only when the engine is parkable, writes the parked
 * stand-ins (agent-broker.ts) and withdraws the live peer entry. The extension
 * closes the engine's stdin only after `parked: true`.
 *
 * t-wdybz9: park is two-phase. `_elastic_park` sets the PARKING flag with no
 * await after its idle check; from then on a prompt_async for a parked session
 * is kept in its mailbox (server handlers/session.ts), so no turn starts in an
 * engine that is about to stop. `_elastic_unpark` reverses it when the
 * extension keeps the engine up. Park and unpark run one at a time, in the
 * order they arrive.
 */

export const METHODS = [
  "elastic_class",
  "elastic_trim",
  "elastic_idle_report",
  "elastic_park",
  "elastic_unpark",
  "elastic_spare",
  "elastic_adopt",
  "elastic_warm",
] as const

/** Park and unpark in arrival order: an unpark that arrives while a park still
 *  writes its stand-ins must undo the finished park, not race it. */
let serial: Promise<unknown> = Promise.resolve()
let pending = 0
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  // Nothing in flight: start now, in this tick, so the park flag is set before
  // the caller's next line (a POST handled after this call sees it).
  const next = pending === 0 ? work() : serial.then(work, work)
  pending++
  serial = next.finally(() => pending--).catch(() => {})
  return next
}

/**
 * Make this engine the live reader of its chats again: register the peer
 * entry `park` withdrew (and wait until it is on disk), delete the stand-ins of
 * its sessions, leave parking, then admit each session's kept mail in order
 * through the engine's own prompt_async route (the same step as a restore,
 * with its late second pass). Idempotent: on an engine that is not parked it
 * only drains mail that is waiting. Never rejects.
 */
async function unpark(): Promise<{ unparked: true; delivered: number }> {
  const ids = new Set([...(AgentBroker.parking() ?? []), ...AgentBroker.published()])
  AgentBroker.reregister()
  await AgentBroker.settled()
  await Promise.all([...ids].map((id) => AgentBroker.removeParked(id)))
  AgentBroker.leaveParking()
  let delivered = 0
  for (const id of ids) {
    const admit = AgentMailbox.admitterFor(id)
    if (!admit) continue
    delivered += (await AgentMailbox.restore(id, admit)).admitted
  }
  console.error(`[peer] unparked pid=${process.pid} sessions=${[...ids].join(",") || "(none)"} delivered=${delivered}`)
  return { unparked: true, delivered }
}

/** The answer for `name` (leading `_` already stripped), or undefined when the
 *  method is not an elastic one. */
export function dispatch(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> | undefined {
  switch (name) {
    case "elastic_class": {
      const requested = params?.["class"]
      if (!ElasticState.isClass(requested)) {
        throw RequestError.invalidParams(`elastic_class requires class "active", "background" or "idle"`)
      }
      return Promise.resolve({ ...ElasticIdle.setClass(requested) })
    }
    case "elastic_trim":
      return Promise.resolve({ ...ElasticIdle.trim() })
    case "elastic_idle_report":
      return Promise.resolve({ ...ElasticIdle.report() })
    case "elastic_park": {
      const hostPid = params?.["hostPid"]
      if (hostPid !== undefined && (typeof hostPid !== "number" || !Number.isInteger(hostPid) || hostPid <= 0)) {
        throw RequestError.invalidParams("elastic_park hostPid must be a positive whole number")
      }
      // `allow`: reasons the caller accepts losing. Only "warm-pending" can be
      // named: a finished Folds agent closes at completion even with a cache
      // warm armed (owner decision 2026-09-24); nothing else is ever waived.
      const allow = new Set(Array.isArray(params?.["allow"]) ? params["allow"].filter((r) => r === "warm-pending") : [])
      return inOrder(async () => {
        // An engine already parked answers the same ids (AgentBroker.park).
        // Otherwise read NOW, not trusted from an earlier `_elastic_idle_report`:
        // a turn, a permission or a question can have started since.
        if (!AgentBroker.parking()) {
          const reasons = ElasticIdle.report().reasons.filter((reason) => !allow.has(reason))
          if (reasons.length > 0) return { parked: false, reasons }
        }
        // No await between the check above and the flag `park` sets first.
        const parking = AgentBroker.park({ hostPid: typeof hostPid === "number" ? hostPid : process.ppid })
        try {
          const sessionIds = await parking
          // t-z6ytkw: after the stand-ins, so a refused park persisted nothing.
          const warms = await ElasticParkWarm.persist()
          return { parked: true, sessionIds, ...(warms.length > 0 ? { warms } : {}) }
        } catch (error) {
          // A stand-in could not be written: the engine stays live. Undo what
          // was written (and deliver what arrived meanwhile), then say so.
          await unpark()
          throw error
        }
      })
    }
    case "elastic_unpark":
      return inOrder(unpark)
    // t-w2u2ki: {spare, adopted} - the shell checks a warm spare really waits (an older engine would not).
    case "elastic_spare":
      return Promise.resolve({ ...ElasticSpare.state() })
    // t-y4x518: WarmSpare.take() sends this before any call of the new chat, so the
    // adoption (lift to active, drop the pre-adoption caches) starts first and the
    // chat's calls, which wait for it (acp/agent.ts), boot its instance once.
    // An engine that was never a spare answers {adopted: false} and does nothing.
    case "elastic_adopt":
      return ElasticSpare.adopt().then((report) => ({ adopted: report !== undefined }))
    case "elastic_warm": {
      const sessionId = params?.["sessionId"]
      if (typeof sessionId !== "string" || sessionId === "") throw RequestError.invalidParams("elastic_warm requires sessionId")
      const taken = ElasticParkWarm.take(sessionId)
      if ("refused" in taken) return Promise.resolve({ warmed: false, reason: taken.refused })
      const directory = taken.recipe.directory
      const send = ElasticParkWarm.send(taken.recipe)
      const inInstance = directory
        ? Effect.gen(function* () {
            const ctx = yield* InstanceStore.Service.use((store) => store.load({ directory }))
            return yield* send.pipe(Effect.provideService(InstanceRef, ctx))
          })
        : send
      return AppRuntime.runPromise(inInstance).catch((error: unknown) => ({
        warmed: false,
        reason: error instanceof Error ? error.message : String(error),
      }))
    }
    default:
      return undefined
  }
}
