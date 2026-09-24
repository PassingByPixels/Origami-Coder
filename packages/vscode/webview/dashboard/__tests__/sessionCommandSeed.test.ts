// sessionCommandSeed.ts — re-seeding the `/` palette for a composer that
// mounted after the engine's ONE-SHOT command push.
//
// The claim under test is not "the function loops". It is the reconciliation:
// which sessions get a message, which are skipped, and what a skipped one would
// have cost. A session posted with an EMPTY list is the case that matters — the
// composer treats `availableCommands` as a REPLACEMENT for its vocabulary
// (InputBar.svelte assigns rather than merges), so an empty seed would trade the
// baseline fallback for a palette that offers nothing at all.

import { describe, expect, it } from 'vitest';
import { commandSeedMessages, type CommandSeedSource } from '../../../src/dashboard/sessionCommandSeed';

const WRAP = { name: 'wrap', description: 'End of session' };
const GRILL = { name: 'grill-me', description: 'Interview first' };

/** The shape DashboardPanel passes: its own `Map<string, Session>`. */
const sessions = (entries: Record<string, CommandSeedSource>) => new Map(Object.entries(entries));

describe('commandSeedMessages', () => {
  it('re-sends each session its own cached list, tagged with its own id', () => {
    // The composer drops a message whose sessionId is not its own, so a seed
    // carrying the wrong id is the same as no seed at all.
    const out = commandSeedMessages(sessions({ 'session-1': { availableCommands: [WRAP] }, 'session-2': { availableCommands: [GRILL] } }));
    expect(out).toEqual([
      { type: 'availableCommands', commands: [WRAP], sessionId: 'session-1' },
      { type: 'availableCommands', commands: [GRILL], sessionId: 'session-2' },
    ]);
  });

  it('skips a session the engine has not answered for yet', () => {
    // A chat whose engine child is still starting has no list to re-send. Posting
    // one anyway would REPLACE the composer's fallback with nothing.
    const out = commandSeedMessages(sessions({ 'session-1': {}, 'session-2': { availableCommands: [WRAP] } }));
    expect(out.map((m) => m.sessionId)).toEqual(['session-2']);
  });

  it('skips a cached list that came back EMPTY, for the same reason', () => {
    const out = commandSeedMessages(sessions({ 'session-1': { availableCommands: [] } }));
    expect(out).toEqual([]);
  });

  it('is a pure read — the same sessions seed the same messages twice', () => {
    // It runs on every pane mount, and panes mount repeatedly (a solo tab, a
    // reopened picker). A second call must be as harmless as the first.
    const live = sessions({ 'session-1': { availableCommands: [WRAP] } });
    expect(commandSeedMessages(live)).toEqual(commandSeedMessages(live));
  });

  it('emits nothing at all when there are no sessions', () => {
    expect(commandSeedMessages(sessions({}))).toEqual([]);
  });
});
