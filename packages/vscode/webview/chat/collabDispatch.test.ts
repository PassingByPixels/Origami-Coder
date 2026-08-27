// collabDispatch — which host message a composer line becomes. CollabPane's own
// suite drives every one of these end to end; what is asserted here is the pair
// of rules that are cheap to get wrong and invisible when they are:
//
//   1. THE MENTIONS ARE FILTERED AND OMITTED. `collab_post` refuses a message
//      naming a slug the room does not have, and appends nothing — so one typo
//      would take a whole message with it. And an unaddressed post must keep the
//      OLD wire shape (no `mentions` key), not send an empty array.
//   2. `/context` IS NOT A MESSAGE. It opens a drawer the pane owns, so this
//      leaf answers with a request and never with a post.

import { describe, expect, it } from 'vitest';
import { collabSlashMessage } from './collabDispatch';

const ROSTER = ['collab-crane', 'collab-heron'];
const ctx = (images: string[] = []) => ({ roster: ROSTER, images });

describe('collabSlashMessage — an ordinary post', () => {
  it('carries the roster slugs it named, as structured data', () => {
    expect(collabSlashMessage({ kind: 'post', text: '@collab-heron take it' }, ctx())).toEqual({
      post: { type: 'collabPost', text: '@collab-heron take it', mentions: ['collab-heron'] },
    });
  });

  it('drops a slug the room does not have — the engine refuses the whole post for one', () => {
    expect(collabSlashMessage({ kind: 'post', text: '@collab-ghost hi' }, ctx())).toEqual({
      post: { type: 'collabPost', text: '@collab-ghost hi' },
    });
  });

  it('omits mentions and images entirely when there are none', () => {
    const out = collabSlashMessage({ kind: 'post', text: 'shall we ship?' }, ctx());
    expect(out).toEqual({ post: { type: 'collabPost', text: 'shall we ship?' } });
  });

  it('carries attachments as bare data URLs when there are some', () => {
    const out = collabSlashMessage({ kind: 'post', text: 'look' }, ctx(['data:image/png;base64,AA']));
    expect(out).toMatchObject({ post: { images: ['data:image/png;base64,AA'] } });
  });
});

describe('collabSlashMessage — the commands', () => {
  it.each([
    [{ kind: 'rename', title: 'Storm' }, { type: 'collabRename', title: 'Storm' }],
    [{ kind: 'archive' }, { type: 'collabArchive' }],
    [{ kind: 'invite', slug: 'collab-fox' }, { type: 'collabAddParticipant', agentSlug: 'collab-fox' }],
    [{ kind: 'remove', slug: 'collab-fox' }, { type: 'collabRemoveParticipant', agentSlug: 'collab-fox' }],
    [{ kind: 'lead', slug: 'collab-crane' }, { type: 'collabSetLead', agentSlug: 'collab-crane' }],
    [{ kind: 'objective', text: 'ship the map' }, { type: 'collabSetObjective', objective: 'ship the map' }],
    [{ kind: 'stop' }, { type: 'collabStop' }],
  ])('%o becomes its own host message', (action, expected) => {
    expect(collabSlashMessage(action as never, ctx())).toEqual({ post: expected });
  });

  // null / 0 / N are not a spectrum: 0 turns the loop breaker OFF.
  it.each([[null], [0], [12]])('carries cap %s verbatim', (cap) => {
    expect(collabSlashMessage({ kind: 'cap', cap } as never, ctx())).toEqual({ post: { type: 'collabSetCap', cap } });
  });

  // The pane resolves the slug against its own participants and words the
  // refusal, because the drawer and the roster are both its.
  it('answers /context as a request, never as a post', () => {
    expect(collabSlashMessage({ kind: 'context', slug: 'collab-crane' } as never, ctx()))
      .toEqual({ context: 'collab-crane' });
  });

  // parseCollabSlash's own refusal never reaches here — the composer keeps the
  // draft on one — and an unknown kind from an older shell must do nothing
  // rather than throw inside a keystroke handler.
  it('answers null for a kind it does not know', () => {
    expect(collabSlashMessage({ kind: 'error', message: 'nope' } as never, ctx())).toBeNull();
  });
});
