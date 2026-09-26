export * as FlockBoot from "./boot"

import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { ElasticState } from "@/elastic/state"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { FlockConfigWrite } from "./config-write"
import type { FlockExit } from "./exit"
import { FlockFrontDesk } from "./frontdesk"
import { FlockOwnerHttp } from "./owner-http"
import { FlockOwnerLease } from "./owner-lease"
import { FlockRelayTransport } from "./relay-transport"
import { FlockRouting } from "./routing"
import { FlockService } from "./service"
import { FlockStore } from "./store"
import { FlockWatch } from "./watch"

/**
 * THE PRODUCTION WIRING, kept out of `service.ts` on purpose: that file owns the
 * sockets and the decisions and takes its `runner` injected, which is what lets
 * the relay end-to-end test drive two whole engines with no provider. This file
 * is the half that actually spends the owner's money; nothing here decides
 * anything, and that is the point of the split.
 *
 * IT STARTS NOTHING BY DEFAULT. `flock.json` is not created here: `Store.open`
 * mints a keypair on first use, and doing that at every engine boot would put an
 * identity in the config directory of every user who upgraded into a feature
 * they never asked for. No file, no service (`FlockStore.exists`).
 */

function inInstance<A, E, R>(directory: string, body: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const context = yield* store.load({ directory })
    return yield* body.pipe(Effect.provideService(InstanceRef, context))
  })
}

/** What the turn cost the OWNER. `info.tokens` is ASSIGNED at each step finish
 *  rather than accumulated (`acp/run-stats.ts` says so at length), so on a
 *  multi-step turn this is the LAST step and under-reports. It is deliberately
 *  the same number the budget is debited by: an owner's cap must never be
 *  measured against a figure larger than the one they are shown. */
function spend(tokens: {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): number {
  return tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/** Runs one Front Desk turn in a child session under the cage `frontdesk.ts`
 *  composed. A turn that comes back as an assistant ERROR is thrown, not
 *  returned: `Peer` turns a throw into a refusal the friend can read, and an
 *  empty string dressed up as an answer is worse than "the front desk failed". */
export function runner(cwd: string): FlockFrontDesk.Runner {
  return async (input) => {
    const binding = FlockRouting.parseBinding(input.model)
    if (!binding) throw new Error(`the front desk model "${input.model}" is not a provider/model reference`)
    return AppRuntime.runPromise(
      inInstance(
        cwd,
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const child = yield* sessions.create({
            title: `flock: ${input.from}`,
            agent: input.agent,
            permission: [...input.permission],
          })
          const result = yield* prompt.prompt({
            sessionID: child.id,
            agent: input.agent,
            model: { providerID: binding.providerID, modelID: binding.modelID },
            // The owner's guidance leads the turn; `turnText` owns that order.
            parts: [
              {
                type: "text",
                text: FlockFrontDesk.turnText({
                  question: input.question,
                  ...(input.guidance ? { guidance: input.guidance } : {}),
                }),
              },
            ],
          })
          if (result.info.role === "assistant" && result.info.error) {
            return yield* Effect.fail(new Error(String(result.info.error.name ?? "the turn failed")))
          }
          return {
            text: result.parts.findLast((part) => part.type === "text")?.text ?? "",
            tokens: result.info.role === "assistant" ? spend(result.info.tokens) : 0,
          }
        }),
      ),
    )
  }
}

/** What {@link waitForFile} needs. Injected whole so a test drives the beat. */
export interface WaitDeps {
  /** Whether `flock.json` is there NOW. */
  readonly exists: () => boolean
  /** Start the real service. Called at most once, the beat the file appears. */
  readonly begin: () => FlockService.Handle
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (timer: unknown) => void
}

/**
 * WAIT FOR THE FILE, rather than deciding once at boot that there is no flock.
 * An engine running before the owner ever accepted an invite would otherwise go
 * on telling its model "no flock.json on this box" until it was restarted.
 *
 * The smallest possible tick — one `existsSync` on the heartbeat cadence — and
 * the moment the file appears it hands over to `FlockService.start`, which then
 * owns the lease, the gates and its own beat. The returned handle is a FACADE
 * over whichever of the two is live, because `cli/cmd/acp.ts` holds it from boot
 * and must not learn that the thing behind it changed.
 */
export function waitForFile(deps: WaitDeps): FlockService.Handle {
  let inner: FlockService.Handle | undefined
  let timer: unknown = null
  let stopped = false

  const check = (): void => {
    if (inner || stopped || !deps.exists()) return
    // `begin` publishes its own state over the idle one, so nothing here has to
    // unpublish: `FlockService.start` writes the module slots as it decides.
    inner = deps.begin()
  }

  // origami_change (t-w2qlop): on the heartbeat cadence while the engine is
  // active, every ElasticState.REST_MIN_MS while it rests. This poll runs in
  // EVERY engine of a machine with no `flock.json` - the default - so at the
  // heartbeat it was one of the two 5 s wake-ups of every idle engine.
  const pollMs = (): number => ElasticState.period(FlockOwnerLease.HEARTBEAT_MS)

  const tick = (): void => {
    check()
    // The poll STOPS once the service exists — it owns the beat from there, and
    // a second timer asking "is the file there" for ever would be work done to
    // reach an answer that can no longer change.
    if (inner || stopped) return
    timer = deps.setTimer(tick, pollMs())
  }

  const idle = FlockService.idleHandle("no-flock-file")
  timer = deps.setTimer(tick, pollMs())
  const unfollow = ElasticState.onChange(() => {
    if (inner || stopped) return
    deps.clearTimer(timer)
    timer = deps.setTimer(tick, pollMs())
  })

  return {
    get active() {
      return inner?.active ?? false
    },
    get reason() {
      return inner ? inner.reason : idle.reason
    },
    get kind() {
      return inner?.kind ?? idle.kind
    },
    get transport() {
      return inner?.transport
    },
    get peer() {
      return inner?.peer
    },
    get routes() {
      return inner?.routes ?? idle.routes
    },
    // A refresh asked for BEFORE the file appeared is the same question the
    // beat asks, so it is answered now rather than deferred to the next one.
    refresh: () => {
      check()
      inner?.refresh()
    },
    stop: () => {
      stopped = true
      unfollow()
      deps.clearTimer(timer)
      timer = null
      inner?.stop()
      inner = undefined
    },
  }
}

/** Start the flock for this engine. Returns the stop hook, the way
 *  `AgentBroker.start` does. `httpBase` is this engine's own loopback server,
 *  threaded through for one reason: the engine that WINS the lease writes it into
 *  the lease record, so a second window's engine — which must not open its own
 *  sockets — can forward `flock_ask` here rather than tell its model the feature
 *  does not exist. With no `flock.json` it WAITS rather than refusing for the life
 *  of the process: see {@link waitForFile}. */
export function start(input: { cwd: string; httpBase?: string }): FlockService.Handle {
  const inner = !FlockStore.exists()
    ? waitForFile({
        exists: () => FlockStore.exists(),
        begin: () => begin(input),
        setTimer: FlockRelayTransport.defaultDeps.setTimer,
        clearTimer: FlockRelayTransport.defaultDeps.clearTimer,
      })
    : begin(input)
  return watched(inner)
}

/** The same handle, with a `flock.json` watcher running beside it. In EVERY
 *  engine, whatever it decided about the lease: the engine that HOLDS the flock
 *  writes the mailbox, and the window whose pane the owner is looking at is
 *  routinely a different one. It is also why this is here and not in `service.ts`
 *  — an idle service still has a pane to keep current. The watcher is stopped
 *  with the handle, so a suite leaves no timer behind. */
function watched(inner: FlockService.Handle): FlockService.Handle {
  const watcher = FlockWatch.start({ file: FlockStore.file(), onChange: () => FlockWatch.announce() })
  return {
    get active() {
      return inner.active
    },
    get reason() {
      return inner.reason
    },
    get kind() {
      return inner.kind
    },
    get transport() {
      return inner.transport
    },
    get peer() {
      return inner.peer
    },
    get routes() {
      return inner.routes
    },
    refresh: () => inner.refresh(),
    stop: () => {
      watcher.stop()
      inner.stop()
    },
  }
}

/** Everything `start` does once there IS a `flock.json`. */
function begin(input: { cwd: string; httpBase?: string }): FlockService.Handle {
  const store = FlockStore.Store.open()
  const desk = FlockConfigWrite.read()
  const autoAnswer = store.desk().autoAnswer
  const relayUrl = FlockConfigWrite.relayUrl()
  return FlockService.start({
    store,
    config: { ...desk, ...(autoAnswer === undefined ? {} : { autoAnswer }) },
    ...(relayUrl ? { relayUrl } : {}),
    // ONLY a loopback address is ever written into the lease. `origami acp
    // --hostname 0.0.0.0` is a supported thing to run, and a lease that
    // advertised a LAN address would be advertising it to whatever can read the
    // file. The reader refuses a non-loopback base too; this is the writer half.
    ...(FlockOwnerHttp.reachable(input.httpBase) ? { httpBase: input.httpBase } : {}),
    specialties: store.desk().specialties ?? [],
    // The same cwd the runner spawns its child session in, which is what
    // `tool/read.ts` measures its relative paths against.
    worktree: input.cwd,
    runner: runner(input.cwd),
    // THE PRODUCTION EXIT HOOKS. `cli/cmd/acp.ts` only reaches its `flock.stop()`
    // when stdin ends cleanly; a window close, a shutdown or a crash never got
    // there, and the lease outlived the process every time.
    exit: process as unknown as FlockExit.Target,
  })
}
