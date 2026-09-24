import { describe, it, expect } from 'vitest';
import { findSlashAnywhere, replaceSlashToken, slashDispatch, slashPaletteAt, slashQueryAt } from './slashAnywhere';

const REGISTERED = new Set(['delegate', 'clear', 'deep-plan']);
const isRegistered = (name: string) => REGISTERED.has(name);

describe('findSlashAnywhere', () => {
  it('finds a command at the start of the line', () => {
    expect(findSlashAnywhere('/delegate build the thing', isRegistered))
      .toEqual({ command: 'delegate', args: 'build the thing' });
  });

  it('finds a command named mid-body, with the surrounding text as args', () => {
    expect(findSlashAnywhere('summarise this and then /delegate', isRegistered))
      .toEqual({ command: 'delegate', args: 'summarise this and then' });
  });

  it('leaves an unregistered /word as literal text — no match at all', () => {
    expect(findSlashAnywhere('meet me at the /notacommand later', isRegistered)).toBeNull();
  });

  it('only the FIRST of two commands runs — the second stays literal in the args', () => {
    const result = findSlashAnywhere('please /delegate this and also /clear the log', isRegistered);
    expect(result).toEqual({ command: 'delegate', args: 'please this and also /clear the log' });
  });

  it('a URL containing a slash does not trigger — no whitespace boundary before it', () => {
    expect(findSlashAnywhere('see https://example.com/delegate for docs', isRegistered)).toBeNull();
  });

  it('a fraction-like glued slash does not trigger either', () => {
    expect(findSlashAnywhere('open 5/6 days a week', isRegistered)).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(findSlashAnywhere('please /DELEGATE this', isRegistered))
      .toEqual({ command: 'delegate', args: 'please this' });
  });

  it('a hyphenated command name is not split on the hyphen', () => {
    expect(findSlashAnywhere('kick off /deep-plan for this', isRegistered))
      .toEqual({ command: 'deep-plan', args: 'kick off for this' });
  });

  it('a command with nothing around it has empty args', () => {
    expect(findSlashAnywhere('/delegate', isRegistered)).toEqual({ command: 'delegate', args: '' });
  });

  it('collapses the whitespace seam left by removing the token', () => {
    expect(findSlashAnywhere('before   /delegate   after', isRegistered))
      .toEqual({ command: 'delegate', args: 'before after' });
  });

  it('no slash in the message at all returns null', () => {
    expect(findSlashAnywhere('just an ordinary message', isRegistered)).toBeNull();
  });
});

// t-qi09w0 item 3 — the COMPLETION rules. Separate from findSlashAnywhere
// above, which decides what a finished message RUNS (still first-command-only).
describe('slashQueryAt — is the caret inside a command being typed?', () => {
  it('the bare slash the user just pressed mid-sentence opens the list', () => {
    expect(slashQueryAt('summarise this and then /', 25)).toEqual({ start: 24, query: '' });
  });

  it('carries the partial name as the filter', () => {
    expect(slashQueryAt('summarise this and then /del', 28)).toEqual({ start: 24, query: 'del' });
  });

  it('still answers at the START of the line — one rule, not two', () => {
    expect(slashQueryAt('/del', 4)).toEqual({ start: 0, query: 'del' });
  });

  it('a slash glued to the previous character is not a command', () => {
    expect(slashQueryAt('meet me at 5/6', 14)).toBeNull();
    expect(slashQueryAt('see example.com/delegate', 24)).toBeNull();
  });

  it('closes once the name is finished and arguments have started', () => {
    expect(slashQueryAt('/delegate the log', 17)).toBeNull();
    expect(slashQueryAt('run /delegate now', 17)).toBeNull();
  });

  it('reads the token the CARET is in, not the last one in the text', () => {
    // Caret parked inside `/del`, with a second token after it.
    expect(slashQueryAt('a /del and /spend', 6)).toEqual({ start: 2, query: 'del' });
  });

  it('no slash before the caret at all', () => {
    expect(slashQueryAt('plain prose', 11)).toBeNull();
  });
});

describe('replaceSlashToken — completing in place', () => {
  it('keeps the prose on BOTH sides and puts the caret after the insertion', () => {
    expect(replaceSlashToken('summarise this and then /del later', 24, 28, '/delegate ')).toEqual({
      text: 'summarise this and then /delegate later',
      caret: 33,
    });
  });

  it('does not double the space when the prose already has one after the token', () => {
    expect(replaceSlashToken('a /del b', 2, 6, '/delegate ').text).toBe('a /delegate b');
    // ...and still adds one at the end of the line, where nothing follows.
    expect(replaceSlashToken('a /del', 2, 6, '/delegate ').text).toBe('a /delegate ');
  });

  it('a whole-line command is the same operation with start 0', () => {
    expect(replaceSlashToken('/del', 0, 4, '/delegate ')).toEqual({ text: '/delegate ', caret: 10 });
  });

  it('an empty insertion removes the token — what a mode command leaves behind', () => {
    expect(replaceSlashToken('now /plan then', 4, 9, '')).toEqual({ text: 'now  then', caret: 4 });
  });

  it('clamps an end past the text instead of producing undefined', () => {
    expect(replaceSlashToken('/pl', 0, 99, '/plan ')).toEqual({ text: '/plan ', caret: 6 });
  });
});

describe('slashPaletteAt — the composer\'s palette rule, both ways in', () => {
  it('a leading slash filters on the WHOLE line and replaces the WHOLE line', () => {
    expect(slashPaletteAt('/deep-plan x', 3)).toEqual({ open: true, filter: 'deep-plan x', start: 0, end: 12 });
  });

  it('mid-message it is the token under the caret, and only that token', () => {
    expect(slashPaletteAt('please /del the log', 11)).toEqual({ open: true, filter: 'del', start: 7, end: 11 });
  });

  it('shut on plain prose', () => {
    expect(slashPaletteAt('plain prose', 11).open).toBe(false);
  });
});

describe('slashDispatch — EXECUTION, unchanged by the palette work', () => {
  it('a leading slash forwards ANY word, registered or not — the host decides', () => {
    expect(slashDispatch('/deep-plan ', () => false)).toEqual({ kind: 'host', command: 'deep-plan', args: '' });
  });

  it('loop and compose take the SEND path so the composer shows in-flight', () => {
    expect(slashDispatch('/loop every hour', () => false)).toEqual({ kind: 'send', command: 'loop', args: 'every hour' });
    expect(slashDispatch('compose /compose a note', isRegistered2)).toEqual({ kind: 'send', command: 'compose', args: 'compose a note' });
  });

  it('a mid-body token must be REGISTERED, or the message is a plain prompt', () => {
    expect(slashDispatch('meet me at the /notacommand later', isRegistered)).toEqual({ kind: 'prompt' });
    expect(slashDispatch('summarise this and then /delegate', isRegistered))
      .toEqual({ kind: 'host', command: 'delegate', args: 'summarise this and then' });
  });

  it('first command only: the second stays literal in the args', () => {
    const two = (n: string) => n === 'delegate' || n === 'spend';
    expect(slashDispatch('please /delegate this and also /spend the log', two))
      .toEqual({ kind: 'host', command: 'delegate', args: 'please this and also /spend the log' });
  });

  it('plain prose is a prompt', () => {
    expect(slashDispatch('just a message', isRegistered)).toEqual({ kind: 'prompt' });
  });
});

const isRegistered2 = (name: string) => name === 'compose';
