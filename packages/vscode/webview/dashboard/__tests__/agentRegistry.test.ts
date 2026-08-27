// Agent Manager - registry.ts (S3.5) pure-logic unit tests: the multi-repo hub
// list. Real temp directories exercise the fs-backed isGitRepo (.git as a dir
// AND as a file), dedupe, missing-flagging, and path normalization. No vscode.

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  composeRepoList, normalizeRepoPath, isGitRepo, findEntry,
} from '../../../src/dashboard/agentManager/registry';
import { mergeAgentTypes, modesFromOption } from '../../../src/dashboard/agentManager/agentTypes';

const tmp: string[] = [];
function mk(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(d);
  return d;
}
/** .git as a real directory (ordinary clone). */
function gitDir(): string { const d = mk('reg-git-'); fs.mkdirSync(path.join(d, '.git')); return d; }
/** .git as a FILE (worktree / submodule gitlink). */
function gitFileDir(): string { const d = mk('reg-gitfile-'); fs.writeFileSync(path.join(d, '.git'), 'gitdir: /elsewhere\n'); return d; }
function plainDir(): string { return mk('reg-plain-'); }
function goneDir(): string { const d = plainDir(); fs.rmSync(d, { recursive: true, force: true }); return d; }

afterAll(() => { for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

describe('normalizeRepoPath', () => {
  it('resolves and strips trailing separators without changing identity', () => {
    const base = plainDir();
    expect(normalizeRepoPath(base + path.sep)).toBe(base);
    expect(normalizeRepoPath(base + path.sep + path.sep)).toBe(base);
    expect(normalizeRepoPath(base)).toBe(base);
  });
});

describe('isGitRepo', () => {
  it('accepts .git as a directory OR as a file, rejects a plain directory', () => {
    expect(isGitRepo(gitDir())).toBe(true);
    expect(isGitRepo(gitFileDir())).toBe(true);
    expect(isGitRepo(plainDir())).toBe(false);
  });
});

describe('composeRepoList', () => {
  it('empty inputs yield an empty list', () => {
    expect(composeRepoList(undefined, [])).toEqual([]);
  });

  it('a non-git workspace is dropped; a git workspace leads with workspace:true', () => {
    const ws = gitDir();
    expect(composeRepoList(ws, [])).toEqual([
      { root: ws, name: path.basename(ws), workspace: true, missing: false },
    ]);
    expect(composeRepoList(plainDir(), [])).toEqual([]);
  });

  it('known repos follow the workspace and dedupe against it (case-insensitive on win32)', () => {
    const ws = gitDir();
    const other = gitDir();
    const wsDupe = process.platform === 'win32' ? ws.toUpperCase() : ws;
    const list = composeRepoList(ws, [wsDupe, other]);
    expect(list.map((e) => e.workspace)).toEqual([true, false]);
    expect(list.map((e) => e.root)).toEqual([ws, other]); // wsDupe deduped out
  });

  it('dedupes known entries against each other, trailing separators normalized', () => {
    const a = gitDir();
    const list = composeRepoList(undefined, [a, a + path.sep, a + path.sep + path.sep]);
    expect(list).toHaveLength(1);
    expect(list[0].root).toBe(a);
  });

  it('a known repo whose folder is gone is KEPT and flagged missing (not dropped)', () => {
    const gone = goneDir();
    const list = composeRepoList(undefined, [gone]);
    expect(list).toEqual([
      { root: normalizeRepoPath(gone), name: path.basename(normalizeRepoPath(gone)), workspace: false, missing: true },
    ]);
  });

  it('accepts a known repo whose .git is a file (worktree gitlink) as present', () => {
    const wt = gitFileDir();
    expect(composeRepoList(undefined, [wt])[0]).toMatchObject({ root: wt, missing: false, workspace: false });
  });
});

describe('mergeAgentTypes (S6a roster union)', () => {
  it('adds new modes, keeps order, and returns null when nothing changed', () => {
    // First harvest into an empty roster: everything is new.
    const first = mergeAgentTypes([], [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }]);
    expect(first).toEqual([{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }]);
    // Re-harvesting the SAME set is a no-op (no persist / no broadcast).
    expect(mergeAgentTypes(first!, [{ id: 'plan', name: 'Plan' }, { id: 'build', name: 'Build' }])).toBeNull();
    // A NEW id unions in at the end; existing order is preserved.
    expect(mergeAgentTypes(first!, [{ id: 'review', name: 'Review' }]))
      .toEqual([{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }, { id: 'review', name: 'Review' }]);
  });

  it('a renamed mode refreshes in place (id stable, name updated)', () => {
    const merged = mergeAgentTypes([{ id: 'plan', name: 'Plan' }], [{ id: 'plan', name: 'Planner' }]);
    expect(merged).toEqual([{ id: 'plan', name: 'Planner' }]);
  });

  it('an empty harvest never changes the roster', () => {
    expect(mergeAgentTypes([{ id: 'build', name: 'Build' }], [])).toBeNull();
  });

  it('carries an option description through, and refreshes when only the description changes', () => {
    // A harvested mode with a description must land in the roster carrying it, so
    // the picker can show what the agent type is for.
    const first = mergeAgentTypes([], [{ id: 'ask', name: 'Ask', description: 'Read-only' }]);
    expect(first).toEqual([{ id: 'ask', name: 'Ask', description: 'Read-only' }]);
    // Same id + name but a NEW description is a change (the picker tooltip updates).
    const reworded = mergeAgentTypes(first!, [{ id: 'ask', name: 'Ask', description: 'Explains, never edits' }]);
    expect(reworded).toEqual([{ id: 'ask', name: 'Ask', description: 'Explains, never edits' }]);
    // Re-harvesting the identical description is a no-op.
    expect(mergeAgentTypes(reworded!, [{ id: 'ask', name: 'Ask', description: 'Explains, never edits' }])).toBeNull();
  });

  it('carries the default flag through and refreshes it when the engine default moves', () => {
    // A harvest that marks 'build' the engine default persists that flag - the
    // picker reads it to hide the default entry (not a hardcoded id).
    const first = mergeAgentTypes([], [{ id: 'build', name: 'Build', default: true }, { id: 'plan', name: 'Plan' }]);
    expect(first).toEqual([{ id: 'build', name: 'Build', default: true }, { id: 'plan', name: 'Plan' }]);
    // `default_agent: 'plan'` later makes 'plan' the default and 'build' a normal
    // agent: a re-harvest with the moved flag is a CHANGE (name stable, flag flipped)
    // so the roster updates - even though no name changed.
    const moved = mergeAgentTypes(first!, [{ id: 'build', name: 'Build', default: false }, { id: 'plan', name: 'Plan', default: true }]);
    expect(moved).toEqual([{ id: 'build', name: 'Build', default: false }, { id: 'plan', name: 'Plan', default: true }]);
    // Re-harvesting the SAME flags is a no-op (undefined and false compare equal).
    expect(mergeAgentTypes(moved!, [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan', default: true }])).toBeNull();
  });
});

describe('modesFromOption (ACP mode-select -> roster entries)', () => {
  it('maps value->id, name->name, flags the current mode default, and carries description', () => {
    const roster = modesFromOption({
      current: 'build',
      options: [
        { value: 'build', name: 'Build' },
        { value: 'ask', name: 'Ask', description: 'Explains, never edits' },
      ],
    });
    expect(roster).toEqual([
      { id: 'build', name: 'Build', default: true },
      { id: 'ask', name: 'Ask', default: false, description: 'Explains, never edits' },
    ]);
  });

  it('omits the description key entirely when the option has none, and returns null for null in', () => {
    const roster = modesFromOption({ current: 'plan', options: [{ value: 'plan', name: 'Plan' }] });
    expect(roster).toEqual([{ id: 'plan', name: 'Plan', default: true }]);
    expect(Object.prototype.hasOwnProperty.call(roster![0], 'description')).toBe(false);
    expect(modesFromOption(null)).toBeNull();
    expect(modesFromOption(undefined)).toBeNull();
  });
});

describe('findEntry', () => {
  it('matches by comparison key (case-insensitive on win32), undefined for absent/none', () => {
    const a = gitDir();
    const list = composeRepoList(undefined, [a]);
    expect(findEntry(list, a)?.root).toBe(a);
    if (process.platform === 'win32') expect(findEntry(list, a.toUpperCase())?.root).toBe(a);
    expect(findEntry(list, undefined)).toBeUndefined();
    expect(findEntry(list, path.join(os.tmpdir(), 'nope-not-here'))).toBeUndefined();
  });
});
