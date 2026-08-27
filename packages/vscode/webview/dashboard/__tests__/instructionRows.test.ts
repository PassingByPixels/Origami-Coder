// instructionRows.ts — the pure rank/section rules the Instructions pane
// renders off. `sections()` is the one that matters for the redesigned list:
// a single MAIN row, one COLLAB row, and the rest as ordinary FILEs — the bug
// worth catching is a row landing in the wrong tier (or in two of them).
//
// M4.1 retired `collab-manual`. The test that used to pin it now asserts the
// opposite: a stale engine still sending that source must DEGRADE to an
// ordinary file row, never render a pinned control whose "Restore default"
// would ask the host to delete a file it can no longer resolve.

import { describe, expect, it } from 'vitest';
import { badge, displayName, isPinned, openMessage, rank, sections } from '../components/instructionRows';

const row = (source: string, chars = 0, over: Record<string, unknown> = {}) => ({
  path: `C:\\ws\\${source}.md`, source, chars, ...over,
});

describe('sections — the three tiers', () => {
  it('the base prompt is the only row in MAIN', () => {
    const out = sections([row('base-prompt'), row('project', 500)]);
    expect(out.main).toEqual([row('base-prompt')]);
  });

  it('the collab prompt lands in COLLAB, never in main or files', () => {
    const out = sections([
      row('base-prompt'),
      row('collab-agent-base', 900),
      row('project', 500),
    ]);
    expect(out.collab.map((e) => e.source)).toEqual(['collab-agent-base']);
    expect(out.main).toHaveLength(1);
    expect(out.files.map((e) => e.source)).toEqual(['project']);
  });

  it('a retired collab-manual row from a stale engine degrades to a FILE', () => {
    const out = sections([row('base-prompt'), row('collab-agent-base', 900), row('collab-manual', 500)]);
    expect(out.collab.map((e) => e.source)).toEqual(['collab-agent-base']);
    expect(out.files.map((e) => e.source)).toEqual(['collab-manual']);
  });

  it('ordinary files sort biggest-first, independent of their arrival order', () => {
    const out = sections([row('project', 400), row('global', 4000), row('memory', 40)]);
    expect(out.files.map((e) => e.source)).toEqual(['global', 'project', 'memory']);
  });

  it('a URL row is a FILE (unmeasured size, chars 0) — never pinned', () => {
    const out = sections([row('url', 0), row('project', 400)]);
    expect(out.files.map((e) => e.source)).toEqual(['project', 'url']);
  });

  it('an inventory with no collab layers yet leaves COLLAB empty, not missing rows', () => {
    const out = sections([row('base-prompt'), row('project', 400)]);
    expect(out.collab).toEqual([]);
  });

  it('an empty inventory yields three empty tiers, not an error', () => {
    expect(sections([])).toEqual({ main: [], collab: [], files: [] });
  });
});

// The rest of the module is unchanged by the section split — pinned unaffected.
describe('isPinned / rank / displayName / badge / openMessage — unchanged by sections', () => {
  it('isPinned is true for exactly the shipped prompts', () => {
    expect(isPinned(row('base-prompt'))).toBe(true);
    expect(isPinned(row('collab-agent-base'))).toBe(true);
    expect(isPinned(row('collab-manual'))).toBe(false);
    expect(isPinned(row('project'))).toBe(false);
  });

  it('rank orders the pinned kinds and floors everything else at 0', () => {
    expect(rank(row('base-prompt'))).toBeGreaterThan(rank(row('collab-agent-base')));
    expect(rank(row('collab-agent-base'))).toBeGreaterThan(0);
    expect(rank(row('project'))).toBe(0);
    expect(rank(row('collab-manual'))).toBe(0);
  });

  it('displayName names a pinned row and falls back to the filename otherwise', () => {
    expect(displayName(row('collab-agent-base'))).toBe('Collab base prompt');
    expect(displayName(row('project'))).toBe('project.md');
    // Retired source: the filename, not a dangling "Collab room manual".
    expect(displayName(row('collab-manual'))).toBe('collab-manual.md');
  });

  it('badge says built-in/overridden for a pinned row, else its own source', () => {
    expect(badge(row('base-prompt'))).toBe('built-in');
    expect(badge(row('base-prompt', 0, { overridden: true }))).toBe('overridden');
    expect(badge(row('memory'))).toBe('memory');
  });

  it('openMessage never lets a pinned row leak its path to the webview', () => {
    expect(openMessage(row('collab-agent-base'))).toEqual({ type: 'openBasePrompt', kind: 'collab-agent-base' });
    expect(openMessage(row('url'))).toBeNull();
    // A retired source opens as an ordinary file — the host has no kind for it.
    expect(openMessage(row('collab-manual'))).toEqual({ type: 'openAbsoluteFile', path: 'C:\\ws\\collab-manual.md' });
  });
});
