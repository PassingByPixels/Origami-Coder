// collabMentions — the composer's `@` grammar.
//
// The load-bearing rule is the ROSTER FILTER: `collab_post` errors on an
// unknown slug and appends NOTHING, so a mention array built from prose alone
// would let one typo refuse a whole message. Everything else here exists
// because a chat line is prose: punctuation touches handles, e-mail addresses
// contain `@`, and the same handle gets typed twice.
import { describe, expect, it } from 'vitest';
import { allMentions, applyMention, filterMentions, mentionQuery, parseMentions } from './collabMentions';

const ROSTER = ['collab-crane', 'collab-heron', 'user_2'];

describe('parseMentions — what a submitted line targets', () => {
  it('picks the roster slugs out of an ordinary sentence, in the order they appear', () => {
    expect(parseMentions('@collab-heron take it, @collab-crane reviews', ROSTER)).toEqual([
      'collab-heron',
      'collab-crane',
    ]);
  });

  it('drops a slug the roster does not carry — the engine would refuse the whole post for it', () => {
    expect(parseMentions('@collab-ghost do the thing', ROSTER)).toEqual([]);
    expect(parseMentions('@collab-crane and @collab-ghost', ROSTER)).toEqual(['collab-crane']);
  });

  it('is exact, not prefix — @collab-cranes is a different word and matches nothing', () => {
    expect(parseMentions('@collab-cranes', ROSTER)).toEqual([]);
  });

  it('survives adjacent punctuation on either side', () => {
    expect(parseMentions('(@collab-crane), @collab-heron. done', ROSTER)).toEqual(['collab-crane', 'collab-heron']);
    expect(parseMentions("@collab-crane's turn", ROSTER)).toEqual(['collab-crane']);
    expect(parseMentions('ping @collab-heron!', ROSTER)).toEqual(['collab-heron']);
  });

  it('names the same agent once however many times it is typed', () => {
    expect(parseMentions('@collab-crane @collab-crane @collab-crane', ROSTER)).toEqual(['collab-crane']);
  });

  it('an e-mail address is not a mention — the @ has to open a word', () => {
    expect(parseMentions('mail collab-crane@collab-heron.dev', ROSTER)).toEqual([]);
  });

  it('a doubled @@ is not a mention either', () => {
    expect(parseMentions('@@collab-crane', ROSTER)).toEqual([]);
  });

  it('an empty roster targets nobody, whatever was typed', () => {
    expect(parseMentions('@collab-crane', [])).toEqual([]);
  });

  it('a line at the very start still counts', () => {
    expect(parseMentions('@user_2 hello', ROSTER)).toEqual(['user_2']);
  });
});

describe('mentionQuery — is the caret inside a handle being typed?', () => {
  it('a bare @ opens the picker with an empty query', () => {
    expect(mentionQuery('ping @', 6)).toEqual({ start: 5, query: '' });
  });

  it('the query grows with the handle', () => {
    expect(mentionQuery('ping @cra', 9)).toEqual({ start: 5, query: 'cra' });
  });

  it('a space after the handle closes it', () => {
    expect(mentionQuery('ping @crane ', 12)).toBeNull();
  });

  it('a caret before the @ is not in the token', () => {
    expect(mentionQuery('ping @crane', 3)).toBeNull();
  });

  it('an e-mail @ never opens the picker', () => {
    expect(mentionQuery('a@b', 3)).toBeNull();
  });

  it('no @ at all is null, not an empty query', () => {
    expect(mentionQuery('hello', 5)).toBeNull();
  });
});

describe('applyMention — what a pick does to the draft', () => {
  it('replaces the half-typed handle and leaves a trailing space + caret after it', () => {
    const r = applyMention('ping @cra', 9, 'collab-crane');
    expect(r.text).toBe('ping @collab-crane ');
    expect(r.caret).toBe(19);
    expect(r.text.slice(r.caret)).toBe('');
  });

  it('keeps whatever followed the caret', () => {
    const r = applyMention('ping @cra rest', 9, 'collab-crane');
    expect(r.text).toBe('ping @collab-crane  rest');
  });

  it('inserts at the caret when there is no token there — a click must never lose the pick', () => {
    expect(applyMention('ping ', 5, 'collab-heron').text).toBe('ping @collab-heron ');
  });
});

describe('filterMentions', () => {
  const cands = [
    { slug: 'collab-crane', name: 'Crane' },
    { slug: 'collab-heron', name: 'Heron' },
  ];

  it('an empty query offers the whole roster', () => {
    expect(filterMentions(cands, '')).toHaveLength(2);
  });

  it('matches the slug or the display name, case-insensitively', () => {
    expect(filterMentions(cands, 'HER').map((c) => c.slug)).toEqual(['collab-heron']);
    expect(filterMentions(cands, 'crane').map((c) => c.slug)).toEqual(['collab-crane']);
  });

  it('no hit is an empty list, never the unfiltered one', () => {
    expect(filterMentions(cands, 'zzz')).toEqual([]);
  });
});

// W3 wave 3 (report 2.5 / F8) — the PREVIEW's reading of the same grammar.
//
// The roster filter is right for a POST and wrong for a preview: `collab_post`
// refuses an unknown slug, so the composer must warn about one BEFORE the send,
// and it can only do that by asking about it. `collab_preview` answers exactly
// that — it classifies the addresses into `wake` and `unknown` itself.
describe('allMentions — every address a draft names, roster or not', () => {
  it('keeps an address the roster does not carry, which parseMentions drops', () => {
    expect(allMentions('@collab-ghost do the thing')).toEqual(['collab-ghost']);
    expect(parseMentions('@collab-ghost do the thing', ROSTER)).toEqual([]);
  });

  it('reads the same token shape as the submit path, in the same order', () => {
    const text = "(@collab-crane), @collab-heron. not a@b.com, @collab-crane's again";
    expect(allMentions(text)).toEqual(['collab-crane', 'collab-heron']);
    expect(parseMentions(text, ROSTER)).toEqual(['collab-crane', 'collab-heron']);
  });

  it('an unaddressed draft names nobody — which is a real question about the lead', () => {
    expect(allMentions('shall we ship the map?')).toEqual([]);
  });
});
