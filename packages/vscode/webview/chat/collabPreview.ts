// The C14 composer preview (report 2.5 / F8) — the DRIVER and the wording, as
// a PURE leaf. Mirrors makeCollabPollLoop and makeCollabActions: a factory the
// composer holds, with no Svelte in it, so the two rules that keep this honest
// are provable without a render.
//
// RULE 1 — TYPING IS FREE, AND STAYS FREE. `collab_preview` is token-free by
// construction: the wake rules read a message's kind and its address list,
// never its prose (ACPCollab.preview), which is exactly why it can be evaluated
// live. But free of TOKENS is not free of ROUND TRIPS, so this debounces, and
// then skips the call entirely when the address list has not changed. Typing a
// paragraph with no `@` in it is one call, made once, for the lead.
//
// RULE 2 — IT CANNOT GATE SEND. The driver owns a timer and a memo of the last
// question, and NOTHING else: no acknowledgement, no in-flight flag, no way to
// refuse. There is therefore no state a send path could consult even if it
// wanted to, which is a stronger guarantee than a comment saying "do not await
// this". Its test asserts the exposed surface for that reason.
//
// The ANSWER is not held here either. It arrives on the same fanned-out wire as
// every other collab reply and belongs to whoever is filtering that wire on
// `collabId`; this leaf only asks the question and words the reply.
import { allMentions } from './collabMentions';

/** Long enough that a burst of keystrokes is one question, short enough that a
 *  human who has stopped typing does not notice waiting. */
export const PREVIEW_DEBOUNCE_MS = 220;

export interface CollabPreviewHost {
  /** Ask the engine who this address list would wake. Fire-and-forget by
   *  contract — a driver that awaited would be a driver a send could wait on. */
  request: (mentions: string[]) => void;
}

export interface CollabPreviewDriver {
  /** The composer's current text. Cheap to call on every keystroke. */
  draft: (text: string) => void;
  /** The draft has gone (a send cleared the box), so the next identical one is
   *  a real question again — its answer described a message already sent. */
  reset: () => void;
  /** Teardown. A pane going away must not leave a timer that posts into it. */
  stop: () => void;
}

export function makeCollabPreview(host: CollabPreviewHost): CollabPreviewDriver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The address list last ASKED about, joined. `null` = nothing asked yet,
   *  which is why an unaddressed first draft still asks once: "nobody named"
   *  is a real question about the lead, and `''` is its real answer. */
  let asked: string | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    draft: (text) => {
      const mentions = allMentions(text);
      const key = mentions.join(',');
      if (key === asked) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        asked = key;
        host.request(mentions);
      }, PREVIEW_DEBOUNCE_MS);
    },
    reset: () => {
      clear();
      asked = null;
    },
    stop: () => {
      clear();
      asked = null;
    },
  };
}

/** Mirrors the engine's `PreviewResult` (collab/acp.ts). Every field but `wake`
 *  is absent in the ordinary case, and absent means absent — never zero. */
export interface CollabPreviewResult {
  wake: string[];
  notice?: 'no-lead';
  unknown?: string[];
}

/**
 * The line under the composer.
 *
 * `nameOf` resolves a slug to whatever the surface calls that agent, so this
 * leaf never has to know about the roster or the short-name rule. An UNKNOWN
 * address keeps its raw text: it is not on the roster, so there is no display
 * name to resolve, and printing the slug is what lets the user see the typo.
 *
 * `null` — no answer yet — is the empty string, not a placeholder: a line that
 * flickered "…" under an empty box would be motion with no information.
 */
export function previewText(
  result: CollabPreviewResult | null,
  nameOf: (slug: string) => string,
): string {
  if (!result) return '';
  const parts: string[] = [];
  if (result.wake.length > 0) parts.push(`Will wake: ${result.wake.map(nameOf).join(', ')}`);
  if (result.unknown && result.unknown.length > 0) {
    parts.push(`${result.unknown.map((s) => `@${s}`).join(', ')} — not in this collab`);
  }
  // Only when nothing else is true: an addressed draft still wakes its targets
  // in a room with no lead, and saying "nobody would answer" there is wrong.
  if (parts.length === 0 && result.notice === 'no-lead') {
    parts.push('Nobody would answer — this collab has no lead yet.');
  }
  return parts.join(' · ');
}
