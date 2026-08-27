// What a parsed composer line MEANS on the wire — the mapping lifted out of
// CollabPane.svelte (W3 wave 3), which was at its cap when the supervision
// wires arrived. A PURE leaf: it decides, it never posts.
//
// THE ONE BRANCH THAT IS NOT A MESSAGE is `/context`, which opens a drawer the
// pane already owns. It is answered as a REQUEST rather than performed here, so
// this file needs no roster lookup, no drawer state, and no way to fail — the
// pane resolves the slug against its own participants and words the refusal.
//
// `collabId` is deliberately absent from every message below. The pane stamps
// it on the way out, exactly as collabActions.ts does, so there is one place a
// missing identity can be caught rather than eleven.
import type { CollabSlashAction } from './collabSlash';
import { parseMentions } from './collabMentions';

export type CollabDispatch =
  /** Send this to the host (the pane adds `collabId`). */
  | { post: Record<string, unknown> }
  /** Open this participant's context drawer, or say it is not in the room. */
  | { context: string };

/**
 * The host message one composer line becomes.
 *
 * THE MENTIONS ARE STRUCTURED DATA (C17 rule 2): prose `@name` wakes nobody,
 * this array does. An unknown slug is DROPPED by the parse rather than sent —
 * `collab_post` refuses the whole message for one, taking the text with it —
 * and the field is omitted entirely when nothing was named, so an unaddressed
 * post keeps today's exact wire shape. The attachments follow the same
 * omit-when-empty rule, as bare `data:` URLs.
 */
export function collabSlashMessage(
  action: CollabSlashAction,
  ctx: { roster: readonly string[]; images: readonly string[] },
): CollabDispatch | null {
  switch (action.kind) {
    case 'post': {
      const mentions = parseMentions(action.text, ctx.roster);
      return { post: {
        type: 'collabPost',
        text: action.text,
        ...(mentions.length ? { mentions } : {}),
        ...(ctx.images.length ? { images: ctx.images } : {}),
      } };
    }
    case 'rename': return { post: { type: 'collabRename', title: action.title } };
    case 'archive': return { post: { type: 'collabArchive' } };
    case 'invite': return { post: { type: 'collabAddParticipant', agentSlug: action.slug } };
    case 'remove': return { post: { type: 'collabRemoveParticipant', agentSlug: action.slug } };
    case 'cap': return { post: { type: 'collabSetCap', cap: action.cap } };
    case 'lead': return { post: { type: 'collabSetLead', agentSlug: action.slug } };
    case 'objective': return { post: { type: 'collabSetObjective', objective: action.text } };
    case 'stop': return { post: { type: 'collabStop' } };
    case 'context': return { context: action.slug };
    // `error` is parseCollabSlash's own refusal and never reaches here — the
    // composer keeps the draft on one. Returning null rather than throwing
    // keeps that true if a new kind ever arrives from an older shell.
    default: return null;
  }
}
