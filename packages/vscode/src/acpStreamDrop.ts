// acpStreamDrop.ts — the `_meta.origami_stream_drop` rider: a dropped provider
// stream, said by the SYSTEM rather than put in the agent's mouth (t-q90gj9).
//
// The engine used to emit `Stream dropped (…) — retrying, attempt N of M` as a
// TEXT part. It arrived as ordinary agent prose, wearing the agent's name, and
// several attempts ran together in one bubble. Taking that apart again means
// matching the wording — and the wording is half provider prose (one real
// detail reads `fetch failed (ECONNRESET)`, brackets and all), so the match is
// a guess that breaks on the next gateway. There is NO pattern matching here or
// in the webview: the engine names the facts, this file reads them.
//
// The key and the field names are a MIRROR of
// packages/engine/src/session/stream-drop.ts (NOTICE_KEY / interface Notice).
// That package is not resolvable from this one, so the mirror cannot be guarded
// by a test that reads both files; the engine's own acp/event.test.ts asserts
// the wire shape these literals have to agree with.
//
// The rider decorates an EMPTY `agent_message_chunk`, so a client that knows
// nothing about it renders nothing at all rather than a nameless bubble.

/** The key on the ACP update's `_meta`. Same string as the engine's NOTICE_KEY. */
export const STREAM_DROP_KEY = 'origami_stream_drop';

export interface StreamDropNotice {
  /** `retrying` = another attempt follows. `stopped` = the ladder is spent. */
  kind: 'retrying' | 'stopped';
  /** 1-based, the attempt that just failed. */
  attempt: number;
  /** How many attempts the engine spends on a dropped stream in total. */
  max: number;
  /** The provider's own sentence, verbatim. */
  detail: string;
  /** True only for `stopped` — the card that offers Retry. */
  terminal: boolean;
}

/**
 * The notice this update carries, or undefined for every other chunk.
 *
 * Fail-CLOSED: a half-written rider draws no card at all. A card is the only
 * thing the user is told about a dead turn, so one with `undefined` in it is
 * worse than none — it would read as a bug in the agent rather than in the
 * gateway.
 */
export function streamDropNotice(update: unknown): StreamDropNotice | undefined {
  const m = (update as { _meta?: unknown } | undefined)?._meta;
  if (!m || typeof m !== 'object') return undefined;
  const raw = (m as Record<string, unknown>)[STREAM_DROP_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const { kind, attempt, max, detail } = raw as Record<string, unknown>;
  if (kind !== 'retrying' && kind !== 'stopped') return undefined;
  if (!Number.isInteger(attempt) || !Number.isInteger(max)) return undefined;
  if (typeof detail !== 'string') return undefined;
  return { kind, attempt: attempt as number, max: max as number, detail, terminal: kind === 'stopped' };
}
