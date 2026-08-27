// The local-echo rule on its own: what the host will echo back, and whether an
// arriving echo is a confirmation or a message in its own right.
//
// The sharp case is the SECOND identical send. Text is the only identity the
// wire carries (`echoUser` has no id), so "did I already draw this?" has to be
// a one-shot match — otherwise a history replay of words the user happened to
// repeat would be silently swallowed and a turn would vanish from the recall.

import { describe, it, expect } from 'vitest';
import { echoTextFor, consumeEcho } from './userEcho';

describe('echoTextFor — the local row has to say what the host will say', () => {
  it('is the trimmed text for a plain send', () => {
    expect(echoTextFor('  who are you  ', '')).toBe('who are you');
  });

  it('carries the /mode prefix the host stamps on a mode command', () => {
    expect(echoTextFor('30m triage tests', 'loop')).toBe('/loop 30m triage tests');
  });

  it('is the bare command when a mode arrives with no args (/compose opens an interview)', () => {
    expect(echoTextFor('', 'compose')).toBe('/compose');
  });
});

describe('consumeEcho — one send, one row', () => {
  it('claims the echo that matches the row already drawn', () => {
    const s = { pendingEcho: 'who are you' };
    expect(consumeEcho(s, 'who are you')).toBe(true);
    expect(s.pendingEcho, 'and stops waiting for it').toBeNull();
  });

  it('claims it only ONCE — a second identical echo is a second turn', () => {
    const s = { pendingEcho: 'again' };
    expect(consumeEcho(s, 'again')).toBe(true);
    expect(consumeEcho(s, 'again')).toBe(false);
  });

  it('leaves a turn this pane never sent alone', () => {
    expect(consumeEcho({ pendingEcho: 'who are you' }, 'restored turn')).toBe(false);
    expect(consumeEcho({}, 'restored turn')).toBe(false);
    expect(consumeEcho(null, 'restored turn')).toBe(false);
  });

  it('does not treat an empty echo as a match for an empty pending slot', () => {
    expect(consumeEcho({ pendingEcho: '' }, '')).toBe(false);
  });
});
