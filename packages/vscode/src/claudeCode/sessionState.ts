// sessionState.ts — the posts that describe the SESSION rather than a turn: `system/init`, the
// `initialize` control_response, `rate_limit_event`. Re-exported from translator.ts and
// cellState.ts so every existing import path still resolves.

import type { ClaudeEvent } from './protocol';
import type { TranslatorState, WebviewPost } from './cellState';
import {
  commandDescriptionsOf, connectedPosts, factsOf, onSubscription, paletteCommands,
  rateLimitPillOf, type RateLimitPill,
} from './sessionFacts';
import { planLimitMessage, planLimitOf } from './childFailure';

export { newTranslatorState, settleOpenTools, CRASHED_TOOL_NOTE, INTERRUPTED_TOOL_NOTE, UNRESOLVED_TOOL_NOTE } from './cellState';
export type { TranslatorState, WebviewPost, CellStateOptions } from './cellState';

/**
 * The composer's funding readout for this cell: money or headroom, never both, sent on every change
 *  so the badge cannot lag the truth. The countdown half travels as numbers, not a sentence, since
 *  `rate_limit_event` fires once per turn and a pre-formatted span would go stale on an idle chat.
 */
export function meterPost(st: TranslatorState): WebviewPost {
  return {
    type: 'passthroughMeter', sessionId: st.sessionId,
    subscription: st.subscription,
    pillPct: st.pill?.pct ?? -1,
    pillResetsAt: st.pill?.resetsAt ?? 0,
    pillWindow: st.pill?.window ?? '',
    pillTitle: st.pill?.title ?? '',
    // Every window the reading carries, for the tooltip. Additive alongside
    // `pillPct`/`pillWindow` above rather than replacing them: those two stay
    // the tightest lane, which is what the pill's own number must keep
    // showing at a glance.
    windows: st.pill?.windows ?? [],
  };
}

/**
 * Adopt an account-wide headroom reading into this cell. Returns [] when it must not be used: a
 *  live `rate_limit_event` is this session's own measurement and always wins, and a reading that
 *  says nothing must not blank a badge that already says something.
 */
export function adoptAccountPill(st: TranslatorState, pill: RateLimitPill | null): WebviewPost[] {
  if (st.pillSource === 'event') return [];
  if (!pill) return [];
  st.pill = pill;
  st.pillSource = 'account';
  return [meterPost(st)];
}

/** The `/` rows for this cell. Sent whenever either half (names from init,
 *  prose from the initialize control_response) lands, because the two frames
 *  arrive in either order and the second must not be lost. */
export function commandsPost(st: TranslatorState): WebviewPost[] {
  if (!st.slashSkills || st.commandNames.length === 0) return [];
  return [{ type: 'passthroughCommands', sessionId: st.sessionId, commands: paletteCommands(st.commandNames, st.commandHelp) }];
}

/** `system` — init is the only subtype with anything to say. Every other
 *  subtype (status, thinking_tokens, and whatever the next CLI adds) is
 *  tolerated in silence: an unknown event must never break a session. */
export function systemPosts(ev: ClaudeEvent, st: TranslatorState): WebviewPost[] {
  const facts = factsOf(ev);
  if (!facts) return [];
  if (facts.model) st.model = facts.model;
  st.subscription = onSubscription(facts.apiKeySource);
  st.commandNames = facts.commands;
  return [...connectedPosts(st, facts), meterPost(st), ...commandsPost(st)];
}

/** `control_response` — the answer to our own `initialize`. The only thing read
 *  out of it is the command PROSE: the same names `init.slash_commands` carries,
 *  with the descriptions the `/` palette needs. */
export function controlResponsePosts(ev: ClaudeEvent, st: TranslatorState): WebviewPost[] {
  const help = commandDescriptionsOf(ev);
  if (help.size === 0) return [];
  st.commandHelp = help;
  return commandsPost(st);
}

/**
 * A rate-limit frame. The pill is refreshed every time; the transcript line fires only when the
 *  warning level changes, since the CLI repeats the same status on every later turn.
 */
export function rateLimitPosts(ev: ClaudeEvent, st: TranslatorState): WebviewPost[] {
  const pill = rateLimitPillOf(ev);
  if (!pill) {
    // The plan window reset: the CLI is back to plain `allowed`. Clearing the event pill stops a
    // badge that would otherwise keep reading a stale percentage for the rest of the session; the
    // account read may refill it on the next lazy trigger.
    if (ev.type !== 'rate_limit_event' || st.pillSource !== 'event') return [];
    st.pill = undefined;
    st.pillSource = undefined;
    st.lastRateLimitStatus = undefined;
    return [meterPost(st)];
  }
  st.pill = pill;
  st.pillSource = 'event';
  const posts: WebviewPost[] = [meterPost(st)];
  if (pill.status !== st.lastRateLimitStatus) {
    st.lastRateLimitStatus = pill.status;
    // `rejected` is not a warning, it is a refusal: the turn did not run. It gets an ERROR card
    // naming the reset time, never the same quiet system line an `allowed_warning` earns.
    const refusal = planLimitOf(ev);
    posts.push(refusal
      ? { type: 'error', message: planLimitMessage(refusal), sessionId: st.sessionId }
      : { type: 'system', text: pill.title, sessionId: st.sessionId });
  }
  return posts;
}
