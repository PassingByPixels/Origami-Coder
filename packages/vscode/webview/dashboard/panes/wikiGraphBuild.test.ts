// wikiGraphBuild — the pure half of the memory graph's build step.
//
// Every case below is a link shape a real wiki produces. The ambiguity cases
// matter most: before the byBase/byTitle split, a repeated basename (index.md
// under two folders) resolved to whichever page happened to be parsed last, so
// the graph drew a confident edge to the wrong page and nothing failed.
//
// Fixtures are shaped like WorkspaceReader.readWikiPagesFromDir output
// (src/workspace/WorkspaceReader.ts): `id` is the path relative to the wiki
// root, `links` are RAW targets exactly as they appear in the markdown.

import { describe, expect, it } from 'vitest';
import { evenHues, folderOf, hash01, resolveLinkEdges, type LinkablePage } from './wikiGraphBuild';

const page = (id: string, title: string, links: string[] = []): LinkablePage => ({ id, title, links });

describe('resolveLinkEdges — which [[target]] means which page', () => {
  it('resolves an exact page id', () => {
    const edges = resolveLinkEdges([page('a.md', 'Alpha', ['b.md']), page('b.md', 'Beta')]);
    expect(edges).toEqual([{ source: 'page:a.md', target: 'page:b.md', kind: 'link' }]);
  });

  it('resolves a source-relative md link, ../ and all', () => {
    // guide/setup.md links "../ref/api.md" — only meaningful relative to guide/.
    const edges = resolveLinkEdges([
      page('guide/setup.md', 'Setup', ['../ref/api.md']),
      page('ref/api.md', 'API'),
    ]);
    expect(edges).toEqual([{ source: 'page:guide/setup.md', target: 'page:ref/api.md', kind: 'link' }]);
  });

  it('resolves a bare basename when only one page carries it', () => {
    const edges = resolveLinkEdges([page('x.md', 'X', ['deep/notes']), page('deep/notes.md', 'Notes')]);
    expect(edges.map((e) => e.target)).toEqual(['page:deep/notes.md']);
  });

  it('resolves a title when nothing else matches, case-insensitively', () => {
    const edges = resolveLinkEdges([page('x.md', 'X', ['  bEtA  ']), page('folder/b.md', 'Beta')]);
    expect(edges.map((e) => e.target)).toEqual(['page:folder/b.md']);
  });

  it('DROPS an ambiguous basename rather than guessing the last one parsed', () => {
    const edges = resolveLinkEdges([
      page('x.md', 'X', ['index']),
      page('one/index.md', 'One index'),
      page('two/index.md', 'Two index'),
    ]);
    expect(edges).toEqual([]);
  });

  it('DROPS an ambiguous title the same way', () => {
    const edges = resolveLinkEdges([
      page('x.md', 'X', ['Overview']),
      page('one/a.md', 'Overview'),
      page('two/b.md', 'Overview'),
    ]);
    expect(edges).toEqual([]);
  });

  it('lets an exact id win over an ambiguous basename', () => {
    const edges = resolveLinkEdges([
      page('x.md', 'X', ['one/index.md']),
      page('one/index.md', 'One index'),
      page('two/index.md', 'Two index'),
    ]);
    expect(edges.map((e) => e.target)).toEqual(['page:one/index.md']);
  });

  it('drops a self-link — a page pointing at itself is not an edge', () => {
    expect(resolveLinkEdges([page('a.md', 'Alpha', ['a.md', 'Alpha'])])).toEqual([]);
  });

  it('emits ONE edge for a reciprocal pair, and one for a repeated target', () => {
    const edges = resolveLinkEdges([
      page('a.md', 'Alpha', ['b.md', 'Beta', 'b.md']),
      page('b.md', 'Beta', ['a.md']),
    ]);
    expect(edges).toHaveLength(1);
  });

  it('ignores a target that resolves to nothing, and pages with no links at all', () => {
    expect(resolveLinkEdges([page('a.md', 'Alpha', ['ghost'])])).toEqual([]);
    expect(resolveLinkEdges([{ id: 'a.md', title: 'Alpha' }])).toEqual([]);
    expect(resolveLinkEdges([])).toEqual([]);
  });

  it('reads a windows-style backslash target the same as a forward-slash one', () => {
    const edges = resolveLinkEdges([page('x.md', 'X', ['deep\\notes.md']), page('deep/notes.md', 'Notes')]);
    expect(edges.map((e) => e.target)).toEqual(['page:deep/notes.md']);
  });
});

describe('folderOf — the key every hue table and bubble group is grouped by', () => {
  it('strips the trailing slash the reader puts on a namespace', () => {
    expect(folderOf({ namespace: 'pages/projects/' })).toBe('pages/projects');
  });

  it('sends a bare "." and an empty namespace to the pinned root hub key', () => {
    expect(folderOf({ namespace: '.' })).toBe('(root)');
    expect(folderOf({ namespace: '' })).toBe('(root)');
    expect(folderOf({})).toBe('(root)');
  });
});

describe('hue + jitter tables', () => {
  it('gives one lone key a mid hue, not 0 — a single red folder reads as an error', () => {
    expect(evenHues(['solo'])).toEqual(new Map([['solo', 200]]));
  });

  it('spaces distinct keys evenly in sorted order, and dedupes repeats', () => {
    expect([...evenHues(['c', 'a', 'b', 'a'])]).toEqual([['a', 0], ['b', 120], ['c', 240]]);
  });

  it('never collides two distinct keys onto one hue', () => {
    const hues = [...evenHues(['alpha', 'beta', 'gamma', 'delta']).values()];
    expect(new Set(hues).size).toBe(hues.length);
  });

  it('hash01 is deterministic and stays inside [0,1)', () => {
    expect(hash01('pages/alpha.md')).toBe(hash01('pages/alpha.md'));
    expect(hash01('a')).not.toBe(hash01('b'));
    for (const s of ['', 'a', 'a very long page id/with/slashes.md', 'ünïcødé']) {
      const v = hash01(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
