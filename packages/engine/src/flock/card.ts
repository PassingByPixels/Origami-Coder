import { FlockEnvelope } from "./envelope"
import type { FlockIdentity } from "./identity"
import { FlockPolicy } from "./policy"

/**
 * WHAT AN ORIGAMI TELLS ITS CONTACTS ABOUT ITSELF. The card is how `flock_who`
 * answers "who should I ask about WordPress" with no directory anywhere: each
 * contact publishes one, SIGNED, so a relay in the middle cannot quietly widen
 * someone's advertised scope. It carries nothing the owner did not choose.
 *
 * `availability` is prose on purpose: it is read by a model deciding whether to
 * spend a contact's budget, and one sentence beats three fields to recombine.
 */

export interface Body {
  readonly handle: string
  /** What they call themselves TODAY. The handle keeps the name it was minted
   *  with; this is the one the reader sees. */
  readonly name: string
  /** The sigil variant they show as. Signed like everything else here, so a
   *  relay cannot swap the mark a row is read under. */
  readonly icon: string
  readonly specialties: readonly string[]
  /** What the owner marked shareable, flattened for display. Never a filesystem path outside the worktree. */
  readonly shareable: readonly string[]
  readonly availability: string
  /** The model the Front Desk answers on, or absent when the owner has not set one. */
  readonly model?: string
  readonly issuedAt: string
}

export type Card = FlockEnvelope.Signed<Body>

/** The one-line summary of what asking this Origami would actually get you. */
export function availability(policy: FlockPolicy.Resolved): string {
  if (!policy.model) return `unavailable — ${FlockPolicy.MODEL_UNSET}`
  const budget =
    policy.dailyBudgetTokens === undefined ? "no daily cap" : `up to ${policy.dailyBudgetTokens} tokens/day`
  return `${policy.autoAnswer ? "auto" : "answers on approval"}, ${budget}`
}

export function build(input: {
  identity: FlockIdentity.Public
  specialties: readonly string[]
  policy: FlockPolicy.Resolved
  signPrivateKey: string
  now?: Date
}): Card {
  const scope = input.policy.scope
  const body: Body = {
    handle: input.identity.handle,
    name: input.identity.name,
    icon: input.identity.icon,
    specialties: input.specialties,
    shareable: FlockPolicy.globs(scope),
    availability: availability(input.policy),
    ...(input.policy.model ? { model: input.policy.model } : {}),
    issuedAt: (input.now ?? new Date()).toISOString(),
  }
  return FlockEnvelope.signPayload(body, input.signPrivateKey)
}

/** Whether this card is the one its claimed author signed. The key comes from the
 *  CONTACTS LIST, never from the card — a card that carried its own key would
 *  verify against itself and prove nothing. That is why the parameter is the
 *  stored `signPublicKey` and there is no overload taking a card alone. */
export function verify(card: Card, signPublicKey: string): boolean {
  return FlockEnvelope.verifyPayload(card, signPublicKey)
}

export * as FlockCard from "./card"
