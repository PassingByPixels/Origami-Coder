// Flock M4.1 — WHICH agents get a live pill, and what it may say, as a PURE
// leaf.
//
// A collab turn can run for minutes with nothing on screen. The pill is the
// answer, and every honesty rule it needs is here rather than in the markup,
// so each one is testable with no DOM:
//
//  - ONLY a running agent gets a pill. `queued` is not working yet and `idle`
//    is not working any more; a pill on either says work is happening that is
//    not.
//  - `liveActivity` is OPTIONAL by contract (absent on every engine that
//    predates it, and absent whenever a running agent has yet to report). A
//    running agent with no activity is `kind: ''`, which the surface renders
//    as a plain "thinking…" — never as a blank pill, never as an error.
//  - a MALFORMED activity is the same as an absent one. An unknown kind or a
//    non-string text is dropped whole rather than half-rendered.
//  - the text is re-bounded at the engine's own 200-char limit. The engine
//    bounds it too; this costs one line and means a mis-bounded build cannot
//    push a 40kB thought through a one-line row.
//  - `liveThought` (the WHOLE reasoning of the turn, for the expanding block)
//    is a SECOND optional field with its own, much larger bound. It is
//    independent of `liveActivity`: an engine may send either, both or
//    neither, and each absence degrades on its own terms — no thought means
//    today's one-line pill, no activity means "thinking…", neither means both.
//
// There is deliberately no "clear the pill" rule. The status and the messages
// arrive in the SAME poll snapshot, so a finished turn is already reported as
// `idle` alongside the message it produced — a local guess about when a turn
// ended could only ever disagree with the engine.
//
// The shapes below MIRROR src/acpExtTypes.ts rather than importing it —
// tsconfig.webview.json pins rootDir to `webview/`, so a webview .ts cannot
// reach into src/. Same convention collabKinds.ts follows; keep the two in step.

/** Mirrors `CollabLiveActivity`. */
export type ActivityKind = 'thought' | 'tool';

/** The part of a `CollabAgentStatus` this leaf reads, typed as it arrives off
 *  the wire: unvalidated. Everything else on the status is the roster's. */
export interface AgentStatusLike {
  slug?: unknown;
  state?: unknown;
  liveActivity?: unknown;
  liveThought?: unknown;
}

/** One pill. `kind: ''` means "running, nothing reported" — the surface says
 *  so in words rather than drawing an empty row. */
export interface LivePill {
  slug: string;
  kind: ActivityKind | '';
  text: string;
  /** The turn's accumulating reasoning, for the expanding block. '' when the
   *  engine sent none — which is a different fact from an empty thought and is
   *  rendered as today's pill, not as a block with nothing in it. */
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
    // Same rule, one field over: a non-string thought is no thought, and the
    // engine's own bound is re-applied so a mis-bounded build cannot push an
    // unbounded transcript into the block.
    const thought = typeof a?.liveThought === 'string' ? a.liveThought.slice(0, THOUGHT_MAX) : '';
    // An activity whose text did not survive validation is no activity at all:
    // reporting `tool` with nothing to show would be a row that says less than
    // "thinking…" while looking like it says more.
    out.push({ slug, kind: text ? kind : '', text, thought });
  }
  return out;
}
