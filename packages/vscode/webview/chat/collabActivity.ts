// Which agents get a live pill, and what it may say, as a pure leaf.
//
// A collab turn can run for minutes with nothing on screen. The pill is
// the answer, and every honesty rule it needs is here, not in the markup:
//
//  - Only a RUNNING agent gets a pill; `queued`/`idle` never do.
//  - `liveActivity` is OPTIONAL: a running agent with no activity is
//    `kind: ''`, rendered as "thinking…", never a blank pill or an error.
//  - A malformed activity is dropped whole, never half-rendered, and text
//    is re-bounded at the engine's own 200-char limit.
//  - `liveThought` is a second, independent optional field with its own
//    larger bound; each absence degrades on its own terms.
//
// There is deliberately no "clear the pill" rule: status and messages
// arrive in the same poll snapshot, so a finished turn already reports
// `idle` alongside the message it produced.
//
// The shapes below MIRROR src/acpExtTypes.ts rather than importing it,
// since a webview .ts cannot reach into src/.

/** Mirrors `CollabLiveActivity`. */
export type ActivityKind = 'thought' | 'tool';

/** The part of a `CollabAgentStatus` this leaf reads, unvalidated off the wire. */
export interface AgentStatusLike {
  slug?: unknown;
  state?: unknown;
  liveActivity?: unknown;
  liveThought?: unknown;
}

/** One pill. `kind: ''` means "running, nothing reported" — said in words, not a blank row. */
export interface LivePill {
  slug: string;
  kind: ActivityKind | '';
  text: string;
  /** The turn's accumulating reasoning. '' when the engine sent none —
   *  a different fact from an empty thought, rendered as today's pill. */
  thought: string;
}

/** The engine's own bound on a live line. */
export const ACTIVITY_MAX = 200;
/** The engine's own bound on a whole live thought (LIVE_THOUGHT_MAX_CHARS). */
export const THOUGHT_MAX = 4000;

const isActivityKind = (v: unknown): v is ActivityKind => v === 'thought' || v === 'tool';

export function livePills(agents: readonly AgentStatusLike[] | undefined): LivePill[] {
  if (!Array.isArray(agents)) return [];
  const out: LivePill[] = [];
  for (const a of agents) {
    const slug = typeof a?.slug === 'string' ? a.slug : '';
    if (!slug || a?.state !== 'running') continue;
    const act = a.liveActivity as { kind?: unknown; text?: unknown } | undefined | null;
    const kind = isActivityKind(act?.kind) ? act.kind : '';
    const raw = kind && typeof act?.text === 'string' ? act.text : '';
    const text = raw.slice(0, ACTIVITY_MAX);
    // Same rule, one field over: a non-string thought is no thought, and
    // the engine's own bound is re-applied here too.
    const thought = typeof a?.liveThought === 'string' ? a.liveThought.slice(0, THOUGHT_MAX) : '';
    // An activity whose text did not survive validation is no activity:
    // reporting `tool` with nothing to show would say more than it means.
    out.push({ slug, kind: text ? kind : '', text, thought });
  }
  return out;
}
