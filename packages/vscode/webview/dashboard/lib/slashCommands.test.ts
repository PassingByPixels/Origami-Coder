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
import { inferCategory, buildSlashCommand } from './slashCommands';

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
