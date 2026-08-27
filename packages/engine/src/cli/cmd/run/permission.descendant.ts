// Headless `origami run` consumes one event stream and answers permission asks
// itself. A subagent's ask carries the CHILD session's id - Permission.request()
// stamps the asking session - and subagent sessions are created through the domain
// store only, so an exact-match check (`permission.sessionID !== sessionID` ->
// continue) dropped every subagent ask: nothing ever replied, the subagent's tool
// call sat "running" forever and the parent's task call froze with it. A headless
// run has no interactive answerer, so the process hung until something killed it -
// including under --auto, whose reply branch the exact-match `continue` never
// reached.
//
// Resolve "is this ask from a session BELOW the one we are running?" instead.
// Bounded (subagents nest shallowly, and the cap stops a runaway) and cycle-safe,
// mirroring acp/ancestor.ts, but with a plain parent lookup so the run CLI does not
// drag in the ACP session store. An ask from a genuinely unrelated session is still
// ignored - this widens the check to descendants, not to everything.

export const MAX_ANCESTOR_HOPS = 5

export type ParentLookup = (sessionID: string) => Promise<string | undefined>

/**
 * Verdicts are memoised. Parentage never changes once a session exists, and this
 * runs inside the event loop where an uncached walk would cost an API round-trip on
 * every permission ask of a chatty run.
 */
export function createDescendantCheck(input: {
  rootSessionID: string
  parentOf: ParentLookup
  maxHops?: number
}): (sessionID: string) => Promise<boolean> {
  const cache = new Map<string, boolean>()
  const maxHops = input.maxHops ?? MAX_ANCESTOR_HOPS

  return async (sessionID: string) => {
    if (sessionID === input.rootSessionID) return true

    const cached = cache.get(sessionID)
    if (cached !== undefined) return cached

    const seen = new Set<string>([sessionID])
    let current = sessionID
    let result = false
    for (let hop = 0; hop < maxHops; hop++) {
      const parentID = await input.parentOf(current)
      if (!parentID || seen.has(parentID)) break
      if (parentID === input.rootSessionID) {
        result = true
        break
      }
      seen.add(parentID)
      current = parentID
    }

    cache.set(sessionID, result)
    return result
  }
}

export type PermissionAsk = {
  readonly id: string
  readonly sessionID: string
  readonly permission: string
  readonly patterns: readonly string[]
}

export type PermissionOutcome = "allowed" | "rejected" | "ignored"

export function permissionWarning(ask: PermissionAsk) {
  return `permission requested: ${ask.permission} (${ask.patterns.join(", ")}); auto-rejecting`
}

/**
 * Decide AND act on one permission ask seen by a headless run, returning what it
 * did. The outcome is the point: a check that merely matched the session would leave
 * the subagent blocked exactly as before, so callers and tests assert on the reply
 * actually going out.
 */
export async function resolvePermissionAsk(input: {
  ask: PermissionAsk
  isDescendant: (sessionID: string) => Promise<boolean>
  auto: boolean
  reply: (input: { requestID: string; reply: "once" | "reject" }) => Promise<unknown>
  warn: (message: string) => void
}): Promise<PermissionOutcome> {
  if (!(await input.isDescendant(input.ask.sessionID))) return "ignored"

  if (input.auto) {
    await input.reply({ requestID: input.ask.id, reply: "once" })
    return "allowed"
  }

  input.warn(permissionWarning(input.ask))
  await input.reply({ requestID: input.ask.id, reply: "reject" })
  return "rejected"
}
