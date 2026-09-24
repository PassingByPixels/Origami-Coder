// skillScope.ts (src/dashboard) — pure leaf behind the Skills pane's
// Local/Global filter (t-7vslix), tested directly with no DOM. Imported
// cross-tree the way skillsPane.test.ts already imports handleSkillsPaneMessage:
// this .test.ts is not part of tsconfig.webview.json's program, so the rootDir
// restriction that blocks a .svelte or .ts SOURCE file under webview/ from
// importing src/ does not apply here.
import { describe, it, expect } from 'vitest';
import { classifyScope, scanRoots } from '../../../src/dashboard/skillScope';

describe('classifyScope', () => {
  it('is local for a path inside the project root', () => {
    expect(classifyScope('C:\\ws\\.origami\\skills\\alpha\\SKILL.md', 'C:\\ws')).toBe('local');
  });

  it('is global for a path under the user home directory', () => {
    expect(classifyScope('C:\\Users\\pat\\.claude\\skills\\alpha\\SKILL.md', 'C:\\ws')).toBe('global');
  });

  it('is global for a pulled-URL cache path outside the project', () => {
    expect(classifyScope('C:\\Users\\pat\\.cache\\origami\\skills\\alpha\\SKILL.md', 'C:\\ws')).toBe('global');
  });

  it('does not let a same-prefix sibling folder count as inside the project', () => {
    // A bare `location.startsWith(cwd)` test would wrongly call this local.
    expect(classifyScope('C:\\ws-old\\.origami\\skills\\alpha\\SKILL.md', 'C:\\ws')).toBe('global');
  });

  it('treats the project root itself as outside its own tree (no SKILL.md is literally the root)', () => {
    expect(classifyScope('C:\\ws', 'C:\\ws')).toBe('global');
  });

  it('is case-insensitive on a drive letter, matching Windows filesystem semantics', () => {
    expect(classifyScope('c:\\ws\\.origami\\skills\\alpha\\SKILL.md', 'C:\\ws')).toBe('local');
  });
});

describe('scanRoots', () => {
  it('roots the local set at cwd and the global set at home', () => {
    const roots = scanRoots('C:\\ws', 'C:\\Users\\pat');
    expect(roots.local.every((d) => d.startsWith('C:\\ws'))).toBe(true);
    expect(roots.global.every((d) => d.startsWith('C:\\Users\\pat'))).toBe(true);
  });

  it('names all three real skill roots per scope: .origami, .claude, .agents', () => {
    const roots = scanRoots('C:\\ws', 'C:\\Users\\pat');
    for (const set of [roots.local, roots.global]) {
      expect(set.some((d) => d.includes('.origami'))).toBe(true);
      expect(set.some((d) => d.includes('.claude'))).toBe(true);
      expect(set.some((d) => d.includes('.agents'))).toBe(true);
    }
  });
});
