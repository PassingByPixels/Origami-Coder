import type { PermissionV1 } from "@origami/core/v1/permission"
import { FlockCard } from "./card"
import type { FlockPeer } from "./peer"
import { FlockPolicy } from "./policy"
import type { Friend, Store } from "./store"

/**
 * THE ANSWERING SIDE: a question from outside never enters the owner's chat. It
 * is served by the `front-desk` archetype (`agent/agent.ts`), in a child session,
 * under two cages composed in this order — `Permission.evaluate` is findLast, so
 * the narrower ruleset has to be the later one:
 *
 *  - the ARCHETYPE's ruleset — read, grep, glob, list, the two wiki lookups and
 *    nothing else: no shell, edit, write, browser, webmcp, mcp, task or
 *    send_message, and `external_directory: deny` so it cannot leave the
 *    owner's worktree at all.
 *  - the SCOPE ruleset, what this owner shared: `read` denied everywhere, then
 *    re-allowed per shareable glob (`policy.ts`).
 *
 * What runs the model is INJECTED: this module owns the decision — refuse, ask
 * the owner, or answer — and hands the turn to a {@link Runner}, which is what
 * lets the cage be asserted against a fake model with no provider.
 */

export const AGENT = "front-desk"

/** Runs one Front Desk turn. Returns the answer text and what it cost the OWNER. */
export interface Runner {
  (input: {
    question: string
    /** The asking friend's handle, for the prompt's attribution line. */
    from: string
    model: string
    agent: string
    /** Archetype cage + scope, already composed. */
    permission: readonly PermissionV1.Rule[]
    /** What the OWNER told the desk before it drafted. It leads the turn
     *  (`turnText`) because it is the owner speaking and the question is not: an
     *  instruction buried under a stranger's text competes with it. */
    guidance?: string
  }): Promise<{ text: string; tokens: number }>
}

/** The one turn the desk is given, guidance first. Built here rather than in the
 *  caller so the auto-answer path and the owner-steered path cannot drift into
 *  two different prompts, and so the ordering is assertable without a provider. */
export function turnText(input: { question: string; guidance?: string }): string {
  const guidance = input.guidance?.trim()
  if (!guidance) return input.question
  return `The owner's guidance for this answer (follow it; it outranks the question):\n${guidance}\n\nThe question:\n${input.question}`
}

export interface Options {
  readonly store: Store
  /** `config.flock.frontDesk`, or nothing when the owner never wrote the block. */
  readonly config?: FlockPolicy.FrontDeskConfig
  readonly specialties?: readonly string[]
  readonly runner: Runner
  /** Tells the owner their Front Desk is refusing everything because no model is
   *  set. Called AT MOST ONCE per process: a notice per inbound question is how a
   *  person learns to ignore notices. */
  readonly notifyModelUnset?: (input: { friend: Friend }) => void
  /** The archetype's own ruleset, from the Agent registry. Absent in a unit test that supplies its own. */
  readonly agentPermission?: PermissionV1.Ruleset
  /** The owner's worktree. {@link cageFor} says what it is for. */
  readonly worktree?: string
  readonly now?: () => Date
}

/** The refusal the asker sees when the owner declines with no reason of their own. */
export const DECLINED = "the owner declined to answer this question"

/** THE CAGE ONE CONTACT'S QUESTION IS ANSWERED UNDER. Exported because the desk
 *  turn starts from TWO places — the auto-answer path in {@link make} and
 *  `flock/mailbox.ts` when the owner clicks Answer — and a second copy of
 *  "archetype ruleset, then scope, in that order" ends with one cage being loose. */
export function cageFor(input: {
  friend: Friend
  policy: FlockPolicy.Resolved
  agentPermission?: PermissionV1.Ruleset
  /** The owner's worktree, so an absolute shared entry can also be written in the
   *  relative form `tool/read.ts` actually asks with. Optional: without it the
   *  absolute rules alone stand, granting nothing off a same-drive path. */
  worktree?: string
}): PermissionV1.Rule[] {
  return [
    ...(input.agentPermission ?? []),
    ...FlockPolicy.scopeRuleset(input.policy.scope, input.worktree === undefined ? {} : { worktree: input.worktree }),
  ]
}

/** How one contact's policy resolves, desk defaults folded in. */
export function policyFor(input: {
  config?: FlockPolicy.FrontDeskConfig
  friend: Friend
}): FlockPolicy.Resolved {
  return FlockPolicy.resolve({
    ...(input.config ? { config: input.config } : {}),
    ...(input.friend.policy ? { overrides: input.friend.policy } : {}),
  })
}

export function make(options: Options): FlockPeer.Serve & { permissionFor(friend: Friend): PermissionV1.Rule[] } {
  let toldAboutModel = false
  const now = () => options.now?.() ?? new Date()

  const resolved = (friend: Friend) => policyFor({ ...(options.config ? { config: options.config } : {}), friend })

  const permissionFor = (friend: Friend): PermissionV1.Rule[] =>
    cageFor({
      friend,
      policy: resolved(friend),
      ...(options.agentPermission ? { agentPermission: options.agentPermission } : {}),
      ...(options.worktree ? { worktree: options.worktree } : {}),
    })

  /**
   * EVERY inbound question is recorded, answered or not. A log that held only the
   * successes would hide the entries worth reading: the friend who is burning
   * through a budget, and the questions refused because no model is set. The ring
   * is bounded in the store, and the question text is the owner's own to see.
   */
  const record = (friend: Friend, question: string, result: { ok: boolean; tokens: number }) =>
    options.store.logAnswer({
      at: now().toISOString(),
      from: friend.handle,
      question,
      tokens: result.tokens,
      ok: result.ok,
    })

  return {
    permissionFor,

    async card({ friend }) {
      const identity = options.store.identity()
      return FlockCard.build({
        identity,
        specialties: options.specialties ?? [],
        policy: resolved(friend),
        signPrivateKey: identity.sign.privateKey,
        now: now(),
      })
    },

    async ask({ friend, question, id }) {
      const policy = resolved(friend)
      const today = FlockPolicy.day(now())
      const decision = FlockPolicy.decide({
        policy,
        spentToday: options.store.spent(friend.handle, today),
        now: now(),
      })

      if (decision.kind === "refuse") {
        if (decision.reason === FlockPolicy.MODEL_UNSET) {
          // ON A SURFACE, NOT IN A LOG. The desk no longer refuses to START
          // without a model (`service.ts` says why), so this refusal is the ONLY
          // thing that tells the owner their desk is turning people away. The row
          // is unread, which is what puts a number on the mailbox badge.
          // `settleIn` rather than `openIn`: the question is decided, not waiting,
          // so it offers the owner no Answer button for something already refused.
          options.store.settleIn({
            id,
            contact: friend.handle,
            question,
            ok: false,
            text: decision.reason,
            tokens: 0,
            unread: true,
          })
          // The NOTICE is still at most once a process — the mailbox row is per
          // question, and a toast per question is how a person ignores toasts.
          if (!toldAboutModel) {
            toldAboutModel = true
            options.notifyModelUnset?.({ friend })
          }
        }
        const refusal = { ok: false as const, text: decision.reason, tokens: 0 }
        record(friend, question, refusal)
        return refusal
      }

      // A QUESTION IS A DECISION, NOT A PERMISSION. Allow-or-refuse is not what
      // this decision needs: the owner wants to steer the answer, see it before it
      // leaves, and decline with a reason the asker can read. So it becomes a row
      // in the mailbox and NOTHING goes back on the wire until `flock/mailbox.ts`
      // sends it. The asker is not blocked: their `flock_ask` already returned.
      if (decision.kind === "approve") {
        options.store.openIn({ id, contact: friend.handle, question })
        return { deferred: true as const }
      }

      const answered = await options.runner({
        question,
        from: friend.handle,
        model: decision.model,
        agent: AGENT,
        permission: permissionFor(friend),
      })
      // Charged AFTER the turn, against what it actually cost. A budget debited up
      // front would refuse the next question on an estimate, and this is the
      // owner's money spent on someone else's behalf — the number must be real.
      if (answered.tokens > 0) options.store.charge(friend.handle, answered.tokens, today)
      const result = { ok: true as const, text: answered.text, tokens: answered.tokens }
      record(friend, question, result)
      return result
    },
  }
}

export * as FlockFrontDesk from "./frontdesk"
