// claudeCodeResume.test.ts — the resume store's rules, driven directly.
//
// The seam test proves the BEHAVIOUR through the manager (a second chat in one
// folder does not join the first chat's Claude session). This file proves the
// rules that behaviour rests on, including the ones the seam cannot reach from
// outside: what a store written by an earlier WINDOW does, and what a write
// leaves behind.

import { describe, expect, it } from 'vitest';
import {
  RESUME_RUN, rememberResume, resumeIdFor, type ResumeStore,
} from '../../../src/dashboard/claudeCodeResume';

const CWD = 'C:\\repo';
const OTHER = 'C:\\elsewhere';
const SESSION = 'c6bab4a9-9d8a-4bf1-855d-9d7e146f884a';

function io(seed?: ResumeStore) {
  const store: { value: ResumeStore | undefined } = { value: seed };
  const logs: string[] = [];
  return {
    store, logs,
    read: () => store.value,
    write: (next: ResumeStore) => { store.value = next; },
    log: (line: string) => logs.push(line),
  };
}

const entry = (cwd: string, session: string, run = RESUME_RUN) => ({ cwd, session, run });

describe('reading', () => {
  it('gives nothing for a cell nothing was stored for — a NEW chat', () => {
    const t = io({ 'session-1': entry(CWD, SESSION) });
    expect(resumeIdFor(t, 'session-2', CWD)).toBeUndefined();
  });

  it('gives this cell its own session back', () => {
    const t = io({ 'session-1': entry(CWD, SESSION) });
    expect(resumeIdFor(t, 'session-1', CWD)).toBe(SESSION);
  });

  // `--resume` is only valid in the directory the session was created in, so a
  // cell whose cwd moved must start fresh rather than fail at spawn.
  it('refuses an entry made in a different directory', () => {
    const t = io({ 'session-1': entry(OTHER, SESSION) });
    expect(resumeIdFor(t, 'session-1', CWD)).toBeUndefined();
  });

  // `session-<n>` restarts at 1 in every extension host while workspaceState
  // outlives the window, so without this the first chat of the next window
  // would inherit the last window's conversation — the same bug, one reload on.
  it('refuses an entry written by an earlier window run', () => {
    const t = io({ 'session-1': entry(CWD, SESSION, 'a-previous-run') });
    expect(resumeIdFor(t, 'session-1', CWD)).toBeUndefined();
  });

  it('discards phase 1\'s cwd-keyed string entry, and says so', () => {
    // The literal shape an upgraded install still holds: { <cwd>: <session id> }.
    const t = io({ [CWD]: SESSION } as unknown as ResumeStore);
    expect(resumeIdFor(t, CWD, CWD)).toBeUndefined();
    expect(t.logs.at(-1)).toContain('stale resume entry');
  });

  for (const [name, value] of [
    ['null', null], ['an array', []], ['a number', 7],
    ['a half-written entry', { cwd: CWD }], ['an empty session id', entry(CWD, '')],
  ] as const) {
    it(`discards ${name} rather than spawning --resume with it`, () => {
      const t = io({ 'session-1': value } as unknown as ResumeStore);
      expect(resumeIdFor(t, 'session-1', CWD)).toBeUndefined();
    });
  }
});

describe('writing', () => {
  it('files the session under the CELL, never under the folder', () => {
    const t = io();
    rememberResume(t, 'session-1', CWD, SESSION);
    expect(t.store.value).toEqual({ 'session-1': entry(CWD, SESSION) });
  });

  it('keeps one entry PER CELL — two chats in one folder do not overwrite each other', () => {
    const t = io();
    rememberResume(t, 'session-1', CWD, SESSION);
    rememberResume(t, 'session-2', CWD, 'a-second-conversation');
    expect(resumeIdFor(t, 'session-1', CWD)).toBe(SESSION);
    expect(resumeIdFor(t, 'session-2', CWD)).toBe('a-second-conversation');
  });

  it('does not write when nothing changed', () => {
    const t = io();
    rememberResume(t, 'session-1', CWD, SESSION);
    const written = t.store.value;
    rememberResume(t, 'session-1', CWD, SESSION);
    // Same object identity: the event stream repeats the id on every frame, and
    // a workspaceState write per frame is a write per frame.
    expect(t.store.value).toBe(written);
  });

  it('prunes entries no run can ever use again — the migration, done lazily', () => {
    const t = io({
      [CWD]: SESSION as unknown as ResumeStore[string],   // phase 1's shape
      'session-9': entry(CWD, 'from-a-past-window', 'an-older-run'),
      'session-3': entry(OTHER, 'still-this-run'),
    });
    rememberResume(t, 'session-1', CWD, SESSION);
    expect(Object.keys(t.store.value!).sort()).toEqual(['session-1', 'session-3']);
  });

  it('ignores a call with no cell or no session', () => {
    const t = io();
    rememberResume(t, '', CWD, SESSION);
    rememberResume(t, 'session-1', CWD, '');
    expect(t.store.value).toBeUndefined();
  });
});
