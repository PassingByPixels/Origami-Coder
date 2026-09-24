// R2.1 de-chimera guard — the slash-command categoriser must NOT
// surface a 'Custodian' bucket (the LiliNyx Diarchy paradigm). This
// asserts the OBSERVABLE requirement: no command name routes to
// 'Custodian', and the former custodian command names ('nyx'/'lili')
// fall through to the generic 'Other' bucket like any unknown command.
//
// If someone re-introduces the `['nyx','lili'] => 'Custodian'` mapping
// (in this file OR by re-duplicating it into InputBar), this test goes
// red. It is not an echo of the implementation: it pins the category
// CONTRACT the UI relies on, not the function body.

import { describe, expect, it } from 'vitest';
import { inferCategory, buildSlashCommand, SHELL_COMMANDS, DEFAULT_COMMANDS } from './slashCommands';

// A shell-only command is one the ENGINE never lists, so `availableCommands`
// can only ever REPLACE it — the composer re-appends this array on every push.
// t-v5qv6u: `/btw` left the list when the composer's Fork button replaced it
// (owner's decision). The host still catches a typed /btw and only forks.
describe('shell-only commands', () => {
  it('no longer offers /btw — forking is the Fork button', () => {
    expect(SHELL_COMMANDS.map((c) => c.name)).not.toContain('/btw');
    expect(DEFAULT_COMMANDS.map((c) => c.name)).not.toContain('/btw');
  });

  it('still offers the shell commands the engine never lists', () => {
    expect(SHELL_COMMANDS.map((c) => c.name)).toEqual(['/firstfold', '/spend', '/loop', '/compose']);
  });
});

describe('slashCommands categoriser — no custodian paradigm', () => {
  it('never returns a Custodian category for any input', () => {
    const probes = [
      'nyx', 'lili', 'custodian', 'help', 'status', 'model', 'memory',
      'board', 'plan', 'tools', 'retry', 'think', 'totally-unknown',
    ];
    for (const name of probes) {
      expect(inferCategory(name)).not.toBe('Custodian');
    }
  });

  it('routes the former custodian command names to the generic Other bucket', () => {
    // 'nyx'/'lili' are no longer first-class agent commands in V1; they
    // must categorise like any unrecognised command, not as 'Custodian'.
    expect(inferCategory('nyx')).toBe('Other');
    expect(inferCategory('lili')).toBe('Other');
  });

  it('still categorises real V1 commands correctly (sanity)', () => {
    expect(inferCategory('status')).toBe('Info');
    expect(inferCategory('memory')).toBe('Memory');
    expect(inferCategory('plan')).toBe('Mode');
  });

  it('buildSlashCommand never produces a Custodian-categorised command', () => {
    for (const raw of [{ name: '/nyx' }, { name: 'lili' }, { name: '/help' }]) {
      expect(buildSlashCommand(raw).category).not.toBe('Custodian');
    }
  });
});

// A FOREIGN vocabulary keeps the label its sender gave it. `inferCategory` is a
// lookup table of the ENGINE's own command names, so re-deriving someone else's
// through it buckets nearly all of it as 'Other' — which is how a Claude Code
// session's 53 commands lost the one label that said where they came from.
describe('slashCommands — a stated category is not second-guessed', () => {
  it('keeps a category the sender supplied', () => {
    expect(buildSlashCommand({ name: 'delegate', category: 'Claude Code' })).toEqual({
      name: '/delegate', description: '', category: 'Claude Code',
    });
    // …even where the guesser HAS an opinion, which is the case that matters:
    // Claude Code publishes a `/compact` too, and it is not the engine's Mode one.
    expect(inferCategory('plan')).toBe('Mode');
    expect(buildSlashCommand({ name: 'plan', category: 'Claude Code' }).category).toBe('Claude Code');
  });

  it('still guesses when the sender said nothing, or said nothing useful', () => {
    expect(buildSlashCommand({ name: 'memory' }).category).toBe('Memory');
    expect(buildSlashCommand({ name: 'memory', category: '' }).category).toBe('Memory');
    expect(buildSlashCommand({ name: 'memory', category: '   ' }).category).toBe('Memory');
    expect(buildSlashCommand({ name: 'memory', category: 42 }).category).toBe('Memory');
  });
});
