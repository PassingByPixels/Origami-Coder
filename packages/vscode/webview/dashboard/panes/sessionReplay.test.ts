// The catch-up rules on their own: what a re-announcement may change about a
// session already on screen, and when a replayed log is this view's to draw.
//
// The sharp case for both is a LIVE view. The host posts the same catch-up to a
// blank view and a busy one, so "already holds it" is the only thing separating
// scrollback from a second copy of it.

import { describe, it, expect } from 'vitest';
import { adoptAnnouncement, acceptsReplayedLog, glyphOf, type IdentityTarget } from './sessionReplay';

const live = (): IdentityTarget => ({ number: 3, agentName: 'Tsuru', title: 'old title', agentArt: 'art', needsSetup: false });

describe('adoptAnnouncement — a replay carries identity, and only identity', () => {
  it('takes the title the host learned while this view was not listening', () => {
    const s = live();
    adoptAnnouncement(s, { sessionNumber: 3, agentName: 'Tsuru', title: 'who is Tsuru' });
    expect(s.title).toBe('who is Tsuru');
  });

  it('clears a title the host no longer has — the host owns identity', () => {
    const s = live();
    adoptAnnouncement(s, { sessionNumber: 3, agentName: 'Tsuru' });
    expect(s.title).toBeUndefined();
  });

  it('normalises exactly as the first announcement does', () => {
    const s = live();
    adoptAnnouncement(s, { agentName: '', title: '', agentArt: '', needsSetup: 1 });
    expect(s.agentName).toBe('Agent');
    expect(s.title).toBeUndefined();
    expect(s.agentArt).toBeNull();
    expect(s.needsSetup).toBe(true);
  });

  it('keeps the number when the replay carries none, rather than stamping NaN on the tab', () => {
    const s = live();
    adoptAnnouncement(s, { agentName: 'Tsuru' });
    expect(s.number).toBe(3);
  });
});

describe('acceptsReplayedLog — scrollback for a view with nothing to show', () => {
  it('is the scrollback of a view that has drawn nothing', () => {
    expect(acceptsReplayedLog({ messages: [] })).toBe(true);
  });

  it('is a second copy for a view that already drew the turn', () => {
    expect(acceptsReplayedLog({ messages: [{ kind: 'user' }] })).toBe(false);
  });
});

// W9 round 2 — the bot's creature is part of IDENTITY, so it rides the same
// replay the title and the art do.
//
// The failure this guards is the ONE the split-brain shape makes easy: a chat
// opened as a bot, then popped out to its own editor tab. That tab is caught up
// by `replaySessionsTo`, and that post is the only thing that will ever tell it
// what this chat is — so a `botGlyph` handled on the FIRST announcement and
// skipped on the replay draws the creature in the sidebar and the crane in the
// popped tab, for one chat, at the same time. Neither view looks broken alone.
describe('adoptAnnouncement — the bot creature survives a catch-up replay', () => {
  it('adopts the glyph a replay carries', () => {
    const s = live();
    adoptAnnouncement(s, { agentName: 'Owl', botGlyph: 'owl' });
    expect(s.botGlyph).toBe('owl');
  });

  // MIRRORED, not merged — the same rule every other identity field follows:
  // the host is the source of truth, so a field the announcement does not carry
  // is a field the host does not have. A chat that stopped being a bot (the def
  // deleted, the session recalled as a plain chat) must lose the creature.
  it('clears a glyph the host no longer states', () => {
    const s: IdentityTarget = { ...live(), botGlyph: 'owl' };
    adoptAnnouncement(s, { agentName: 'Tsuru' });
    expect(s.botGlyph).toBeUndefined();
  });
});

describe('glyphOf — empty is absent', () => {
  // '' is what a def with no `glyph:` line sends (botsManager: `def?.glyph ??
  // ''`), and the empty state's rule is "a creature, or the crane" — so the one
  // falsy value on the wire has to arrive as the one absent value here. Reading
  // it as a glyph would ask ArchetypeGlyph to draw '' and get a letter tile.
  it('reads a stated glyph and rejects every way of stating none', () => {
    expect(glyphOf({ botGlyph: 'owl' })).toBe('owl');
    for (const none of [{}, { botGlyph: '' }, { botGlyph: null }, { botGlyph: 0 }, { botGlyph: ['owl'] }]) {
      expect(glyphOf(none), JSON.stringify(none)).toBeUndefined();
    }
  });
});
