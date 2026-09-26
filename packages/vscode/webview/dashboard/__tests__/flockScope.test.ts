// The scope pickers' SOURCES — src/dashboard/flockScope.ts.
//
// What is under test is not "does it read a directory". It is that the three
// lists a permission checklist offers are the lists the rest of this workspace
// already keeps, in the form the ENGINE matches them in. The old comma-separated
// text boxes could not be wrong in a way anybody saw; a checklist built from the
// wrong source is wrong in exactly the same silent way, one layer down.
//
// Everything here runs on a temp directory. `repoOptions` takes its home as an
// argument for that reason (the same seam `repoFilePath(home)` already had), so
// no assertion in this file can be satisfied by the developer's own registry.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { relativeToWorkspace, repoOptions, wikiFolders } from '../../../src/dashboard/flockScope';

let home: string;
let workspace: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-scope-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-scope-ws-'));

  fs.mkdirSync(path.join(home, '.origami'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.origami', 'repos.json'),
    JSON.stringify({
      version: 1,
      repos: [
        { root: 'C:/Repos/acme/site', name: 'site', workspace: true, addedAt: 1 },
        // A board display-name override. The picker must show what the BOARD
        // shows: two lists naming one repo differently are two lists the owner
        // has to reconcile by hand.
        { root: 'C:/Repos/Projects/demo-app', name: 'demo-app', displayName: 'Demo app', workspace: false, addedAt: 2 },
      ],
    }),
  );

  for (const folder of ['pages', 'drafts', '.git']) fs.mkdirSync(path.join(workspace, 'wiki', folder), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'wiki', 'index.md'), '# index\n');
});

afterAll(() => {
  for (const dir of [home, workspace]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('repoOptions — the Folds board registry, not a second list', () => {
  it('offers every registered repo, preferring the board display name', () => {
    expect(repoOptions(home)).toEqual([
      { root: 'C:/Repos/acme/site', name: 'site' },
      { root: 'C:/Repos/Projects/demo-app', name: 'Demo app' },
    ]);
  });

  it('a missing registry is an EMPTY list, not a throw', () => {
    // The Browse button still works with no registry at all, and a broken file
    // must not take the whole Permissions section down with it.
    expect(repoOptions(fs.mkdtempSync(path.join(os.tmpdir(), 'flock-scope-none-')))).toEqual([]);
  });
});

describe('wikiFolders — the folders under wiki/, as the engine matches them', () => {
  it('lists top-level FOLDERS only, posix-separated and workspace-relative', () => {
    // Posix on purpose: the engine matches these as globs (policy.ts
    // scopeRuleset), and a `wiki\pages` written on Windows matches nothing
    // anywhere. Folders only: a bare entry is expanded to `<entry>/**`, which
    // means nothing for a file.
    expect(wikiFolders(workspace)).toEqual(['wiki/drafts', 'wiki/pages']);
  });

  it('says nothing rather than guessing when there is no wiki, or no workspace', () => {
    expect(wikiFolders(os.tmpdir())).toEqual([]);
    expect(wikiFolders(undefined)).toEqual([]);
  });
});

describe('relativeToWorkspace — what a browsed folder is STORED as', () => {
  it('turns a folder inside the workspace into a posix relative path', () => {
    expect(relativeToWorkspace(path.join(workspace, 'wiki', 'pages'), workspace)).toBe('wiki/pages');
  });

  it('leaves a folder OUTSIDE the workspace absolute rather than climbing out with ..', () => {
    const outside = path.resolve(workspace, '..', 'somewhere-else');
    // A `../somewhere-else` glob matches nothing the cage evaluates, so the
    // absolute path is the only honest thing to store.
    expect(relativeToWorkspace(outside, workspace)).toBe(outside);
  });

  it('with no workspace open, the absolute path is all there is', () => {
    expect(relativeToWorkspace('C:/Repos/thing', undefined)).toBe('C:/Repos/thing');
  });
});
