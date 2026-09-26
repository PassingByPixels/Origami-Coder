export * as ElasticSpare from "./spare"

/**
 * t-w2u2ki (Elastic E6): a WARM SPARE engine.
 *
 * The VS Code shell starts one engine per window ahead of time, with
 * `ORIGAMI_SPARE=1`, so the window's next new chat does not wait for a process
 * start. Until a chat adopts it the spare must be inert and invisible:
 *  - no peer heartbeat, so `list_agents` / `send_message` never see an empty engine;
 *  - no Flock service, so it cannot win the relay lease and then go away;
 *  - no instance booted at start (plugins, LSP, config snapshot), and no MCP
 *    servers - those start at the first session, as in any engine.
 *
 * `cli/cmd/acp.ts` HOLDS the peer start here instead of running it. The
 * extension's `_elastic_adopt` (t-y4x518, sent by WarmSpare.take() before any
 * call of the chat) or else the first session call (`acp/agent.ts`: new, load,
 * resume, fork) ADOPTS the spare: the held work runs once, before that call
 * proceeds, and every other call that arrives meanwhile waits for it. The held work also drops
 * every instance and the global config cache, so the adopted chat reads the
 * disk as it is NOW, like an engine started now (scope C test S1). An engine
 * started without the variable holds nothing and `adopt()` is a no-op.
 */

import { ElasticBootTrace } from "./boot-trace"

export const SPARE_VAR = "ORIGAMI_SPARE"

/**
 * origami_change (t-xnvp72): what one adoption took. Made when the first session
 * call adopts the spare; the held work fills in its parts as they end (the
 * disposal also past its limit); the adopting call logs it once, as
 * `adoption timings`, when it has answered (acp/agent.ts).
 */
export interface AdoptionReport {
  /** `performance.now()` when the adoption started. */
  readonly startedAt: number
  /** The main-thread probe over the adoption; stopped by the call that logs the report. */
  readonly lag: ElasticBootTrace.LagProbe
  /** The pre-adoption instance disposal, to its real end. */
  disposeMs?: number
  /** The disposal ran past its own limit (the chat went on without it). */
  disposeLimitHit?: boolean
  /** The peer broker + Flock start. */
  peersMs?: number
  /** The whole held work ran past ADOPT_LIMIT_MS. */
  limitHit?: boolean
  /** Set by the one call that logs the report. */
  logged?: boolean
}

export interface Held {
  /** The peer name the broker will register at adoption, so `initialize` can report it now. */
  readonly peerName?: string
  /** Drop the pre-adoption caches, then start the peer broker and the Flock service.
   *  t-xnvp72: writes its parts' timings into `report`. */
  readonly onAdopt: (report: AdoptionReport) => Promise<void>
  /** Test seam: the time limit on `onAdopt` (default ADOPT_LIMIT_MS). */
  readonly limitMs?: number
  /**
   * origami_change (t-y4x518): put a spare that waits lowered (idle class: IDLE
   * priority + EcoQoS) back at full speed. `adopt()` runs it synchronously,
   * before the held work and before the call that adopts does any work.
   */
  readonly lift?: () => void
}

/**
 * origami_change (t-wdybz9): the longest a session call waits for adoption.
 * Adoption disposes every pre-adoption instance, and a finalizer that never
 * ends (a plugin, an LSP server) kept the new chat from opening at all. After
 * the limit the chat opens; the held work goes on in the background.
 */
export const ADOPT_LIMIT_MS = 5_000

/** `work`, or nothing after `ms`: whichever comes first. A timeout is logged
 *  under `label`; a rejection of `work` is left to the caller. Resolves true
 *  when the limit ended the wait (t-xnvp72: the adoption report says so). */
export function bounded(work: Promise<void>, ms: number, label: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[spare] ${label} did not end within ${ms} ms; going on without it`)
      resolve(true)
    }, ms)
  })
  return Promise.race([work.then(() => false), limit]).finally(() => clearTimeout(timer))
}

let held: Held | undefined
let adoption: Promise<AdoptionReport | undefined> | undefined
/** origami_change (t-y4x518): the held work has ended (or its limit has). */
let adoptionEnded = false

/** This process was started as a spare (read at `acp` start, before anything is held). */
export function isSpare(env: Record<string, string | undefined> = process.env): boolean {
  return env[SPARE_VAR] === "1"
}

/** `cli/cmd/acp.ts`: keep the peer start until a chat adopts this engine. */
export function hold(input: Held): void {
  held = input
  adoption = undefined
  adoptionEnded = false
}

/** A spare that no chat has adopted yet. */
export function waiting(): boolean {
  return held !== undefined && adoption === undefined
}

/** The name the broker will register under, while the spare waits; undefined otherwise. */
export function pendingName(): string | undefined {
  return waiting() ? held?.peerName : undefined
}

/**
 * The first session call adopts the spare. Runs the held work ONCE; every
 * caller (two session calls at once) waits for the same run. The variable is
 * removed first, so no child the adopted engine starts (MCP, shell) inherits it.
 * A failure in the held work is logged, not thrown: the chat still opens.
 * Held work that does not end within ADOPT_LIMIT_MS no longer holds the chat.
 * Resolves the adoption's report (t-xnvp72), the same one for every caller;
 * undefined in an engine that was never a spare.
 */
export function adopt(): Promise<AdoptionReport | undefined> {
  if (adoption) return adoption
  const work = held
  if (!work) return Promise.resolve(undefined)
  delete process.env[SPARE_VAR]
  try {
    work.lift?.()
  } catch (error) {
    console.error(`[spare] lift to the active class failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const report: AdoptionReport = { startedAt: performance.now(), lag: ElasticBootTrace.lagProbe() }
  adoption = bounded(
    Promise.resolve().then(() => work.onAdopt(report)),
    work.limitMs ?? ADOPT_LIMIT_MS,
    "adoption",
  )
    .then((limitHit) => {
      report.limitHit = limitHit
    })
    .catch((error) => {
      console.error(`[spare] adoption step failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    .then(() => {
      adoptionEnded = true
      return report
    })
  return adoption
}

/**
 * origami_change (t-y4x518): the adoption that runs now, or undefined when none
 * does (a waiting spare, an adopted one, an ordinary engine). A call that would
 * load an instance waits for it: the adoption drops every instance and the
 * global config cache, so an instance booted meanwhile was booted for nothing
 * (the 0.4.179 UAT: a pane call booted one 10 ms before `session/new` adopted,
 * and the adoption then waited for that boot and disposed it). The extension
 * starts the adoption before any call of the chat (`_elastic_adopt`), so the
 * chat's calls boot its instance once, after it.
 */
export function inFlight(): Promise<unknown> | undefined {
  return adoption && !adoptionEnded ? adoption : undefined
}

/** The ext method `_elastic_spare`: lets the shell check that this engine honours spare mode. */
export function state(): { spare: boolean; adopted: boolean } {
  return { spare: waiting(), adopted: held !== undefined && adoption !== undefined }
}

/** Tests only. */
export function resetForTest(): void {
  held = undefined
  adoption = undefined
  adoptionEnded = false
}
