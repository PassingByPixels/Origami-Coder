// collabSlash — the collab composer's `/` vocabulary.
//
// The load-bearing rule is the FALL-THROUGH: anything this does not recognise
// is an ordinary message. A composer that swallowed unrecognised input would
// lose what the user typed, and a typo'd command is the exact input that
// triggers it. So the "not a command" cases are asserted at least as hard as
// the commands themselves.
//
// The second is `/cap`. null / 0 / N are three different settings, and folding
// them (`cap || default`) silently re-arms a loop breaker the user turned OFF.

import { describe, expect, it } from 'vitest';
import { COLLAB_COMMANDS, parseCollabSlash } from '../../chat/collabSlash';

describe('collabSlash — the allowlist', () => {
  it('offers exactly the nine collab-scoped commands, each with a leading slash', () => {
    expect(COLLAB_COMMANDS.map((c) => c.name)).toEqual([
      '/rename', '/archive', '/invite', '/remove', '/cap', '/context', '/lead', '/objective', '/stop',
    ]);
    for (const c of COLLAB_COMMANDS) expect(c.description).not.toBe('');
  });

  // The chat's commands run against an engine session a collab does not have.
  it('does not offer chat commands that would act on some unrelated session', () => {
    const names = COLLAB_COMMANDS.map((c) => c.name);
    for (const chatOnly of ['/clear', '/model', '/plan', '/new', '/retry']) {
      expect(names).not.toContain(chatOnly);
    }
  });
});

describe('collabSlash — anything unrecognised is a MESSAGE', () => {
  it.each([
    ['plain prose', 'ship it'],
    ['a typo for a real command', '/achive'],
    ['a lone slash', '/'],
    ['a path someone pasted', '/usr/local/bin/thing is missing'],
    ['a regex in a code note', '/^[a-z]+$/ should match'],
  ])('%s posts verbatim', (_label, text) => {
    expect(parseCollabSlash(text)).toEqual({ kind: 'post', text });
  });

  it('trims the posted text but never rewrites it', () => {
    expect(parseCollabSlash('   ship it   ')).toEqual({ kind: 'post', text: 'ship it' });
  });

  it('an empty submission is still a post, so the caller keeps its own send guard', () => {
    expect(parseCollabSlash('   ')).toEqual({ kind: 'post', text: '' });
  });
});

describe('collabSlash — the commands', () => {
  it('/rename takes the whole rest of the line, spaces and all', () => {
    expect(parseCollabSlash('/rename The Storm Plan, part 2')).toEqual({
      kind: 'rename', title: 'The Storm Plan, part 2',
    });
  });

  it('/archive takes no argument and ignores one', () => {
    expect(parseCollabSlash('/archive')).toEqual({ kind: 'archive' });
    expect(parseCollabSlash('/archive please')).toEqual({ kind: 'archive' });
  });

  it('/invite and /remove take the FIRST word only — a slug is one token', () => {
    expect(parseCollabSlash('/invite collab-heron and crane')).toEqual({ kind: 'invite', slug: 'collab-heron' });
    expect(parseCollabSlash('/remove  collab-crane ')).toEqual({ kind: 'remove', slug: 'collab-crane' });
  });

  it('/context names an agent', () => {
    expect(parseCollabSlash('/context collab-crane')).toEqual({ kind: 'context', slug: 'collab-crane' });
  });

  it('the command name is case-insensitive; its ARGUMENT is not', () => {
    expect(parseCollabSlash('/RENAME Storm Plan')).toEqual({ kind: 'rename', title: 'Storm Plan' });
    expect(parseCollabSlash('/INVITE Collab-Heron')).toEqual({ kind: 'invite', slug: 'Collab-Heron' });
  });
});

// Flock M4 wave X1 — three commands added for lead/objective/stop.
describe('collabSlash — flock M4: /lead, /objective, /stop', () => {
  it('/lead takes the first word — a slug is one token', () => {
    expect(parseCollabSlash('/lead collab-crane')).toEqual({ kind: 'lead', slug: 'collab-crane' });
    expect(parseCollabSlash('/lead collab-crane please')).toEqual({ kind: 'lead', slug: 'collab-crane' });
  });

  it('/objective takes the whole rest of the line, spaces and all', () => {
    expect(parseCollabSlash('/objective Ship the M4 picker by Friday')).toEqual({
      kind: 'objective', text: 'Ship the M4 picker by Friday',
    });
  });

  it('/stop takes no argument and ignores one', () => {
    expect(parseCollabSlash('/stop')).toEqual({ kind: 'stop' });
    expect(parseCollabSlash('/stop please')).toEqual({ kind: 'stop' });
  });

  it('/lead and /objective without an argument refuse rather than guess', () => {
    for (const cmd of ['/lead', '/objective']) {
      const action = parseCollabSlash(cmd);
      expect(action.kind).toBe('error');
      if (action.kind === 'error') expect(action.message).toContain(cmd);
    }
  });
});

describe('collabSlash — /cap keeps its three values apart', () => {
  it('off is 0 — the breaker DISABLED, not "the default"', () => {
    expect(parseCollabSlash('/cap off')).toEqual({ kind: 'cap', cap: 0 });
    expect(parseCollabSlash('/cap OFF')).toEqual({ kind: 'cap', cap: 0 });
  });

  it('default (and a bare /cap) is null — restore the engine default', () => {
    expect(parseCollabSlash('/cap default')).toEqual({ kind: 'cap', cap: null });
    expect(parseCollabSlash('/cap')).toEqual({ kind: 'cap', cap: null });
  });

  it('a whole number is that number, including a large one', () => {
    expect(parseCollabSlash('/cap 1')).toEqual({ kind: 'cap', cap: 1 });
    expect(parseCollabSlash('/cap 200')).toEqual({ kind: 'cap', cap: 200 });
  });

  // 0 and null are NOT interchangeable, so neither may be reached by accident.
  it('refuses a negative, a fraction and a non-number rather than coercing one', () => {
    for (const bad of ['/cap -1', '/cap 2.5', '/cap lots', '/cap 1e3x']) {
      expect(parseCollabSlash(bad).kind).toBe('error');
    }
  });
});

describe('collabSlash — a command missing its argument REFUSES, it does not guess', () => {
  it.each(['/rename', '/invite', '/remove', '/context'])('%s alone is an error naming what it needs', (cmd) => {
    const action = parseCollabSlash(cmd);
    expect(action.kind).toBe('error');
    if (action.kind === 'error') {
      expect(action.message).toContain(cmd);
      expect(action.message.length).toBeGreaterThan(cmd.length + 5);
    }
  });

  it('an error is never a post — the refused line must not land in the stream', () => {
    expect(parseCollabSlash('/rename').kind).not.toBe('post');
  });
});
