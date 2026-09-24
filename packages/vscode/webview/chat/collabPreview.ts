// The composer preview: the driver and wording, as a pure leaf.
//
// Rule 1: typing stays free. `collab_preview` is token-free (the wake rules
// read only a message's kind and address list, never its prose), but free
// of tokens is not free of round trips, so this debounces and skips the
// call when the address list is unchanged.
//
// Rule 2: it cannot gate send. The driver owns only a timer and a memo of
// the last question — no acknowledgement, no in-flight flag, no way to
// refuse — so there is no state a send path could consult even if it tried.
import { allMentions } from './collabMentions';

/** Long enough that a burst of keystrokes is one question, short enough that a
 *  human who has stopped typing does not notice waiting. */
export const PREVIEW_DEBOUNCE_MS = 220;

export interface CollabPreviewHost {
  /** Ask the engine who this address list would wake. Fire-and-forget by contract. */
  request: (mentions: string[]) => void;
}

export interface CollabPreviewDriver {
  /** The composer's current text. Cheap to call on every keystroke. */
  draft: (text: string) => void;
  /** The draft has gone (send cleared the box), so the next identical one asks again. */
  reset: () => void;
  /** Teardown. A pane going away must not leave a timer that posts into it. */
  stop: () => void;
}

export function makeCollabPreview(host: CollabPreviewHost): CollabPreviewDriver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The address list last asked about, joined. `null` = nothing asked yet,
   *  so an unaddressed first draft still asks once. */
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

/** Mirrors the engine's `PreviewResult` (collab/acp.ts); absent fields mean absent, never zero. */
export interface CollabPreviewResult {
  wake: string[];
  notice?: 'no-lead';
  unknown?: string[];
}

/**
 * The line under the composer.
 *
 * `nameOf` resolves a slug to the surface's display name; an unknown
 * address keeps its raw text so the user can see the typo. `null` (no
 * answer yet) is the empty string, not a placeholder, so there is no
 * flicker with no information.
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
