// ARTIFACTS — both halves, the shape skillsPane.test.ts uses: the pane
// (webview) and its host module (src/dashboard/artifactsPane.ts), plus the ACP
// drift guard for the seven methods this lane DEFINES (round 3, t-s9kc6o, adds
// artifact_rename and artifact_delete beside the original five).
//
// Why the empty state is tested first and hardest: the engine has no
// artifact_* handler on any branch today, so "method not found" is the answer
// the pane gets on a real machine right now. A pane that throws, blanks or
// renders half a list on that answer would ship as the feature.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
import ArtifactsPane from '../panes/ArtifactsPane.svelte';
import { VIEWS, isViewId, viewForSection } from '../panes/boardViews';
import {
  artifactRows, conflictSentence, deviceLabel, filterArtifacts, lastChange, syncLine, versionRows,
} from '../panes/artifactRows';
import {
  ARTIFACT_LIST_WAIT_MS, ARTIFACTS_PANE_MESSAGE_TYPES, handleArtifactsPaneMessage, resetArtifactsSeen, type ArtifactsPaneHost,
} from '../../../src/dashboard/artifactsPane';
import {
  ARTIFACT_METHOD_NAMES, ARTIFACT_METHODS, ARTIFACT_PARAM_FIELDS, ARTIFACT_RESULT_FIELDS,
  ARTIFACT_ROW_FIELDS, ARTIFACT_VERSION_FIELDS, ARTIFACT_CONFLICT_FIELDS, ARTIFACTS_CHANGED_NOTIFICATIONS,
} from '../../../src/dashboard/artifactAcp';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;

async function send(data: Record<string, unknown>): Promise<void> {
  window.dispatchEvent(new MessageEvent('message', { data }));
  await tick();
}

/** Two rows: one made here, one that arrived from the MacBook unopened. */
const FIXTURE = [
  {
    id: 'a1', title: 'Relief lab report', latest: 4, updated: new Date(Date.now() - 2 * 86400000).toISOString(),
    ownerDevice: '5090', here: true, sessionID: 'ses_17', project: 'origami-coder', unopened: false,
  },
  {
    id: 'a2', title: 'Terrain dashboard', latest: 3, updated: new Date(Date.now() - 3600000).toISOString(),
    ownerDevice: 'MacBook', here: false, sessionID: 'ses_18', project: 'aetheron', unopened: true,
    conflict: { device: 'MacBook', theirVersion: 4, yourVersion: 3 },
  },
];

async function withList(extra: Record<string, unknown> = {}) {
  const rendered = render(ArtifactsPane);
  await send({ type: 'artifactsData', artifacts: FIXTURE, homeDevice: '5090', ...extra });
  return rendered;
}

beforeEach(() => {
  globalThis.__vscodeApiMock.postMessage.mockClear();
  resetArtifactsSeen();
});
afterEach(() => cleanup());

describe('ArtifactsPane — the empty state is the state a real machine is in today', () => {
  it('asks the host for the list on mount', () => {
    render(ArtifactsPane);
    expect(posts()).toEqual([{ type: 'artifactsRequest' }]);
  });

  // t-v47qh6: until the first answer the pane does not know the store is empty.
  it('says it is loading, not "No artifacts yet", before the first answer arrives', async () => {
    const { container } = render(ArtifactsPane);
    expect(container.querySelector('.af-empty-head')).toBeNull();
    expect(container.textContent).toContain('Loading artifacts');
    await send({ type: 'artifactsData', artifacts: [] });
    expect(container.querySelector('.af-empty-head')!.textContent).toBe('No artifacts yet');
    expect(container.textContent).not.toContain('Loading artifacts');
  });

  it('an engine that does not know the method draws the explainer, not a broken pane', async () => {
    const { container } = render(ArtifactsPane);
    await send({ type: 'artifactsData', artifacts: [], error: 'Method not found: artifact_list' });

    expect(container.querySelector('.af-empty-head')!.textContent).toBe('No artifacts yet');
    // Two sentences that say what an artifact IS — an empty box would leave
    // the reader to guess what the pill they clicked was even for.
    const body = container.querySelector('.af-empty-body')!.textContent!.trim();
    expect(body.split('.').filter((s) => s.trim()).length).toBeGreaterThanOrEqual(2);
    expect(body).toMatch(/version/i);
    // t-vbj8xu: only the LIST travels, only with Nests on; files come on Open
    // (nestArtifacts.ts sync / ensure). "The copies follow you" overstated it.
    expect(body).toContain('With Nests on, the list reaches your other desks.');
    expect(body).toContain('The files come over when you open one.');
    expect(body).not.toMatch(/follow you/i);
    // The engine's own words are kept, quietly, under the explainer.
    expect(container.textContent).toContain('Method not found: artifact_list');
    expect(container.querySelector('.af-list')).toBeNull();
  });
});

describe('ArtifactsPane — the list', () => {
  it('renders title, version, device, last change and the chat + repo it came from', async () => {
    const { container } = await withList();
    const rows = Array.from(container.querySelectorAll('.af-row')) as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Relief lab report');
    expect(rows[0]!.textContent).toContain('v4');
    expect(rows[0]!.textContent).toContain('2 days ago');
    expect(rows[0]!.textContent).toContain('origami-coder');
    expect(rows[0]!.textContent).toContain('chat ses_17');
  });

  it('t-v7i2au: last change reads the engine\'s real shape — `updated` and `created` as epoch ms', async () => {
    // packages/engine/src/acp/artifacts.ts ListRow.updated and VersionRow.created are numbers.
    const { container } = render(ArtifactsPane);
    await send({ type: 'artifactsData', homeDevice: 'this machine', artifacts: [
      { id: 'n1', title: 'Numeric', latest: 2, updated: Date.now() - 3 * 3600000, ownerDevice: 'this machine', here: true },
    ] });
    const row = container.querySelector('.af-row') as HTMLElement;
    expect(row.textContent).toContain('3 h ago');
    await fireEvent.click(row.querySelector('.af-rowbtn')!);
    await send({ type: 'artifactVersions', artifactId: 'n1', versions: [{ number: 2, digest: 'd', created: Date.now() - 2 * 86400000 }] });
    expect(container.querySelector('.af-row')!.textContent).toContain('2 days ago');
  });

  it('calls THIS machine "this desk" and every other device by its own name', async () => {
    const { container } = await withList();
    const rows = Array.from(container.querySelectorAll('.af-row')) as HTMLElement[];
    // homeDevice = '5090', so that row reads "this desk" and never "5090".
    // t-vbj8xu: not "mother base": no mother base was posted.
    expect(rows[0]!.textContent).toContain('this desk');
    expect(rows[0]!.textContent).not.toContain('mother base');
    expect(rows[0]!.textContent).not.toContain('5090');
    expect(rows[1]!.textContent).toContain('MacBook');
  });

  it('carries the sync status line, and marks a body this machine has not pulled', async () => {
    const { container } = await withList();
    const rows = Array.from(container.querySelectorAll('.af-row')) as HTMLElement[];
    expect(rows[0]!.querySelector('.af-sync')!.textContent).toBe('on this desk v4');
    expect(rows[1]!.querySelector('.af-sync')!.textContent).toContain('body not on this machine yet');
    expect(rows[1]!.querySelector('.af-away')).not.toBeNull();
  });

  it('search filters by title and says so when nothing matches', async () => {
    const { container } = await withList();
    const search = container.querySelector('.af-search') as HTMLInputElement;

    await fireEvent.input(search, { target: { value: 'terrain' } });
    expect(Array.from(container.querySelectorAll('.af-row')).map((r) => r.getAttribute('data-artifact-id'))).toEqual(['a2']);

    await fireEvent.input(search, { target: { value: 'zzz' } });
    expect(container.querySelectorAll('.af-row')).toHaveLength(0);
    expect(container.textContent).toContain('No artifact matches that title');
  });
});

describe('ArtifactsPane — versions and their three actions', () => {
  async function opened() {
    const rendered = await withList();
    await fireEvent.click(rendered.container.querySelector('[data-artifact-id="a1"] .af-rowbtn')!);
    await send({
      type: 'artifactVersions', artifactId: 'a1',
      versions: [
        { number: 1, digest: 'aa', created: new Date(Date.now() - 4 * 86400000).toISOString(), device: '5090' },
        { number: 4, digest: 'bb', created: new Date(Date.now() - 86400000).toISOString(), device: 'MacBook' },
      ],
    });
    return rendered;
  }

  it('asks for the versions of the artifact that was clicked', async () => {
    const { container } = await withList();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('[data-artifact-id="a2"] .af-rowbtn')!);
    expect(posts()).toContainEqual({ type: 'artifactVersionsRequest', artifactId: 'a2' });
  });

  it('ignores a versions reply for an artifact the user is no longer looking at', async () => {
    const { container } = await opened();
    // The slow answer for a1 lands after the user has moved to a2. Rendering it
    // would put a1's history under a2's title, which is worse than nothing.
    await fireEvent.click(container.querySelector('[data-artifact-id="a2"] .af-rowbtn')!);
    await send({ type: 'artifactVersions', artifactId: 'a1', versions: [{ number: 9 }] });
    expect(container.querySelector('[data-version="9"]')).toBeNull();
  });

  it('shows every version with Open, Restore and Compare', async () => {
    const { container } = await opened();
    const rows = Array.from(container.querySelectorAll('.af-vrow')) as HTMLElement[];
    expect(rows.map((r) => r.getAttribute('data-version'))).toEqual(['1', '4']);
    expect(rows[0]!.textContent).toContain('this desk');
    expect(rows[1]!.textContent).toContain('MacBook');
    const labels = Array.from(rows[0]!.querySelectorAll('.af-btn')).map((b) => b.textContent!.trim());
    expect(labels).toEqual(['Open', 'Restore as new version', 'Compare', 'Show in Explorer']);
  });

  it('Open posts artifact_open\'s message with the version that was clicked', async () => {
    const { container } = await opened();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('[data-version="1"] .af-btn')!);
    expect(posts()).toEqual([{ type: 'artifactOpen', artifactId: 'a1', version: 1 }]);
  });

  it('Restore posts artifact_restore\'s message', async () => {
    const { container } = await opened();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const buttons = Array.from(container.querySelectorAll('[data-version="1"] .af-btn')) as HTMLButtonElement[];
    await fireEvent.click(buttons[1]!);
    expect(posts()).toEqual([{ type: 'artifactRestore', artifactId: 'a1', version: 1 }]);
  });

  it('Compare asks for the diff from that version to the latest, and lists the files', async () => {
    const { container } = await opened();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const buttons = Array.from(container.querySelectorAll('[data-version="1"] .af-btn')) as HTMLButtonElement[];
    await fireEvent.click(buttons[2]!);
    expect(posts()).toEqual([{ type: 'artifactDiff', artifactId: 'a1', from: 1, to: 4 }]);

    await send({
      type: 'artifactDiffData', artifactId: 'a1', from: 1, to: 4,
      added: ['style.css'], changed: ['index.html'], removed: ['old.js'],
    });
    const diff = container.querySelector('[data-artifact-diff="1-4"]')!;
    expect(diff.textContent).toContain('added · style.css');
    expect(diff.textContent).toContain('changed · index.html');
    expect(diff.textContent).toContain('removed · old.js');
  });

  it('Compare on the LATEST version is offered as disabled, not as a diff against itself', async () => {
    const { container } = await opened();
    const buttons = Array.from(container.querySelectorAll('[data-version="4"] .af-btn')) as HTMLButtonElement[];
    expect(buttons[2]!.disabled).toBe(true);
  });

  it('Show in Explorer posts artifactReveal with that version', async () => {
    const { container } = await opened();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const buttons = Array.from(container.querySelectorAll('[data-version="1"] .af-btn')) as HTMLButtonElement[];
    await fireEvent.click(buttons[3]!);
    expect(posts()).toEqual([{ type: 'artifactReveal', artifactId: 'a1', version: 1 }]);
  });

  it('picking Open on a version collapses the versions list, and the chevron re-expands it', async () => {
    const { container } = await opened();
    expect(container.querySelectorAll('.af-vrow')).toHaveLength(2);

    await fireEvent.click(container.querySelector('[data-version="1"] .af-btn')!);
    expect(container.querySelectorAll('.af-vrow')).toHaveLength(0);

    await fireEvent.click(container.querySelector('.af-vtoggle')!);
    expect(container.querySelectorAll('.af-vrow')).toHaveLength(2);
  });

  it('selecting a different artifact resets the collapse', async () => {
    const { container } = await opened();
    await fireEvent.click(container.querySelector('[data-version="1"] .af-btn')!);
    expect(container.querySelectorAll('.af-vrow')).toHaveLength(0);

    await fireEvent.click(container.querySelector('[data-artifact-id="a2"] .af-rowbtn')!);
    await send({ type: 'artifactVersions', artifactId: 'a2', versions: [{ number: 3 }] });
    expect(container.querySelectorAll('.af-vrow')).toHaveLength(1);
  });
});

describe('ArtifactsPane — row actions: Open, Open chat about, Rename, Delete', () => {
  it('Open opens the latest version of the row that was clicked', async () => {
    const { container } = await withList();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const actions = container.querySelector('[data-artifact-id="a1"] .af-actions')!;
    await fireEvent.click(Array.from(actions.querySelectorAll('.af-btn')).find((b) => b.textContent === 'Open')!);
    expect(posts()).toContainEqual({ type: 'artifactOpen', artifactId: 'a1' });
  });

  it('Open chat about posts the artifact id, title and latest version', async () => {
    const { container } = await withList();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    const actions = container.querySelector('[data-artifact-id="a1"] .af-actions')!;
    await fireEvent.click(Array.from(actions.querySelectorAll('.af-btn')).find((b) => b.textContent === 'Open chat about')!);
    expect(posts()).toEqual([{ type: 'artifactOpenChatAbout', artifactId: 'a1', title: 'Relief lab report', version: 4 }]);
  });

  it('Rename shows an inline input seeded with the current title', async () => {
    const { container } = await withList();
    const actions = container.querySelector('[data-artifact-id="a1"] .af-actions')!;
    await fireEvent.click(Array.from(actions.querySelectorAll('.af-btn')).find((b) => b.textContent === 'Rename')!);
    const input = container.querySelector('[data-artifact-id="a1"] .af-rename-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Relief lab report');
  });

  it('Enter commits the rename: the row updates at once and artifactRename is posted', async () => {
    const { container } = await withList();
    const actions = container.querySelector('[data-artifact-id="a1"] .af-actions')!;
    await fireEvent.click(Array.from(actions.querySelectorAll('.af-btn')).find((b) => b.textContent === 'Rename')!);
    const input = container.querySelector('[data-artifact-id="a1"] .af-rename-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Final report' } });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(posts()).toEqual([{ type: 'artifactRename', artifactId: 'a1', title: 'Final report' }]);
    expect(container.querySelector('[data-artifact-id="a1"] .af-rowtitle')!.textContent).toBe('Final report');
    expect(container.querySelector('[data-artifact-id="a1"] .af-rename-input')).toBeNull();
  });

  it('Escape cancels the rename: nothing is posted and the title is unchanged', async () => {
    const { container } = await withList();
    const actions = container.querySelector('[data-artifact-id="a1"] .af-actions')!;
    await fireEvent.click(Array.from(actions.querySelectorAll('.af-btn')).find((b) => b.textContent === 'Rename')!);
    const input = container.querySelector('[data-artifact-id="a1"] .af-rename-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Whatever' } });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(posts()).toEqual([]);
    expect(container.querySelector('[data-artifact-id="a1"] .af-rowtitle')!.textContent).toBe('Relief lab report');
  });

  it('Delete takes the row out at once and shows an Undo toast; Undo brings it back with no post', async () => {
    const { container } = await withList();
    const actions = container.querySelector('[data-artifact-id="a1"] .af-actions')!;
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(Array.from(actions.querySelectorAll('.af-btn')).find((b) => b.textContent === 'Delete')!);

    expect(container.querySelector('[data-artifact-id="a1"]')).toBeNull();
    expect(posts()).toEqual([]);
    const toast = container.querySelector('.af-delete-toast')!;
    expect(toast.textContent).toContain('Relief lab report');

    await fireEvent.click(toast.querySelector('.og-toast-action')!);
    expect(container.querySelector('[data-artifact-id="a1"]')).not.toBeNull();
    expect(posts()).toEqual([]);
    expect(container.querySelector('.af-delete-toast')).toBeNull();
  });

  it('a burned-out Undo fuse (no click within 4s) commits the delete', async () => {
    vi.useFakeTimers();
    try {
      const { container } = await withList();
      const actions = container.querySelector('[data-artifact-id="a1"] .af-actions')!;
      globalThis.__vscodeApiMock.postMessage.mockClear();
      await fireEvent.click(Array.from(actions.querySelectorAll('.af-btn')).find((b) => b.textContent === 'Delete')!);
      expect(posts()).toEqual([]);
      await vi.advanceTimersByTimeAsync(4000);
      expect(posts()).toEqual([{ type: 'artifactDelete', artifactId: 'a1' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// t-vbj8xu: "mother base" is the Nests role (the group roster's flag), not "this
// machine". The engine names this machine `homeDevice` ('this machine',
// acp/artifacts.ts THIS_MACHINE); before this fix every such row read "mother base"
// even on a desk that is not the mother base, or with Nests off.
describe('ArtifactsPane — which desk is called the mother base', () => {
  const MINE = { id: 'm1', title: 'Mine', latest: 2, ownerDevice: 'this machine', here: true };
  const SURFACE = { id: 's1', title: 'Theirs', latest: 5, ownerDevice: 'Surface', here: false };
  const syncOf = (c: HTMLElement, id: string) => c.querySelector(`[data-artifact-id="${id}"] .af-sync`)!.textContent;

  it('this desk, not the mother base (or Nests off): its rows read "this desk", never "mother base"', async () => {
    const { container } = render(ArtifactsPane);
    await send({ type: 'artifactsData', homeDevice: 'this machine', artifacts: [MINE, SURFACE] });
    expect(syncOf(container, 'm1')).toBe('on this desk v2');
    expect(container.textContent).not.toContain('mother base');
  });

  it('another desk is the mother base: that desk reads "mother base (<name>)", this one "this desk"', async () => {
    const { container } = render(ArtifactsPane);
    await send({ type: 'artifactsData', homeDevice: 'this machine', motherBase: { self: false, name: 'Surface' }, artifacts: [MINE, SURFACE] });
    expect(syncOf(container, 'm1')).toBe('on this desk v2');
    expect(syncOf(container, 's1')).toContain('on mother base (Surface) v5');
  });

  it('this desk IS the mother base: its rows read "mother base (this desk)"', async () => {
    const { container } = render(ArtifactsPane);
    await send({ type: 'artifactsData', homeDevice: 'this machine', motherBase: { self: true, name: 'Here' }, artifacts: [MINE, SURFACE] });
    expect(syncOf(container, 'm1')).toBe('on mother base (this desk) v2');
    expect(syncOf(container, 's1')).toContain('on Surface v5');
  });
});

describe('ArtifactsPane — the conflict banner', () => {
  it('names the device and both versions, in the sentence the design note wrote', async () => {
    const { container } = await withList();
    const banner = container.querySelector('[data-artifact-conflict="a2"]')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.querySelector('.af-conflict-text')!.textContent)
      .toBe('MacBook published v4 after you opened v3.');
    // Only the artifact that HAS a conflict gets one.
    expect(container.querySelector('[data-artifact-conflict="a1"]')).toBeNull();
  });

  it('Open v4 opens THEIR version and Keep mine restores YOURS — both as ACP messages', async () => {
    const { container } = await withList();
    const actions = Array.from(container.querySelectorAll('[data-artifact-conflict="a2"] .af-btn')) as HTMLButtonElement[];
    expect(actions.map((b) => b.textContent!.trim())).toEqual(['Open v4', 'Keep mine as a sibling']);

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(actions[0]!);
    expect(posts()).toContainEqual({ type: 'artifactOpen', artifactId: 'a2', version: 4 });

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(actions[1]!);
    // "Keep mine as a sibling" is a RESTORE of the version you opened: yours is
    // published on top of theirs and both survive.
    expect(posts()).toContainEqual({ type: 'artifactRestore', artifactId: 'a2', version: 3 });
  });

  it('tells the host the arrivals have been seen, so the pill badge clears', async () => {
    await withList();
    expect(posts()).toContainEqual({ type: 'artifactsOpened', ids: 'a2' });
  });
});

describe('artifactRows — the rules, without a pane', () => {
  it('drops rows with no id and defaults a missing title to the id', () => {
    expect(artifactRows([{ title: 'no id' }, null, 'x', { id: 'a9' }])).toEqual([
      { id: 'a9', title: 'a9', latest: 1 },
    ]);
  });

  it('deviceLabel: home, empty and a case-different home name all read this desk', () => {
    expect(deviceLabel('5090', '5090')).toBe('this desk');
    expect(deviceLabel('5090', '5090 ')).toBe('this desk');
    expect(deviceLabel('macbook', '5090')).toBe('macbook');
    expect(deviceLabel(undefined)).toBe('this desk');
    expect(deviceLabel('MacBook')).toBe('MacBook');
  });

  it('deviceLabel: "mother base" only for the desk the roster marks (t-vbj8xu)', () => {
    expect(deviceLabel('this machine', 'this machine', { self: true, name: 'Here' })).toBe('mother base (this desk)');
    expect(deviceLabel(undefined, 'this machine', { self: true, name: 'Here' })).toBe('mother base (this desk)');
    expect(deviceLabel('surface', 'this machine', { self: false, name: 'Surface' })).toBe('mother base (surface)');
    expect(deviceLabel('MacBook', 'this machine', { self: false, name: 'Surface' })).toBe('MacBook');
    // This desk is the mother base: another desk that shares nothing with it keeps its name.
    expect(deviceLabel('Surface', 'this machine', { self: true, name: 'Here' })).toBe('Surface');
  });

  it('search is case-insensitive, trimmed, and an empty query keeps everything', () => {
    const rows = artifactRows(FIXTURE);
    expect(filterArtifacts(rows, '  TERRAIN ').map((r) => r.id)).toEqual(['a2']);
    expect(filterArtifacts(rows, '')).toHaveLength(2);
  });

  it('lastChange says nothing rather than "Invalid Date" for a timestamp it cannot read', () => {
    expect(lastChange(undefined)).toBe('');
    expect(lastChange('not a date')).toBe('');
    expect(lastChange(new Date(Date.now() - 30000).toISOString())).toBe('just now');
    expect(lastChange(new Date(Date.now() - 86400000).toISOString())).toBe('1 day ago');
  });

  it('syncLine and conflictSentence survive a row with no device and no conflict', () => {
    const [row] = artifactRows([{ id: 'a1', title: 't', latest: 2 }]);
    expect(syncLine(row!)).toBe('on this desk v2');
    expect(conflictSentence(row!)).toBe('');
  });

  it('versionRows drops a version with no number — no button could act on it', () => {
    expect(versionRows([{ number: 2 }, { digest: 'x' }, null])).toEqual([{ number: 2 }]);
  });
});

describe('artifactsPane host — what it sends the engine and what it does with the answer', () => {
  function host(extMethod: ArtifactsPaneHost['client'] extends undefined ? never : (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const out: Array<Record<string, unknown>> = [];
    const opened: string[] = [];
    const revealed: string[] = [];
    const chats: string[] = [];
    const h: ArtifactsPaneHost = {
      client: { extMethod: (method, params) => { sent.push({ method, params }); return extMethod(method, params); } },
      post: (m) => out.push(m),
      openUrl: (url) => { opened.push(url); },
      revealPath: (p) => { revealed.push(p); },
      createChat: () => { const id = `chat-${chats.length + 1}`; chats.push(id); return id; },
    };
    return { h, sent, out, opened, revealed, chats };
  }

  const ok = (result: Record<string, unknown>) => async () => result;

  it('artifactsRequest reads artifact_list and posts the list AND the badge count', async () => {
    const { h, sent, out } = host(ok({ artifacts: FIXTURE, homeDevice: '5090' }));
    await handleArtifactsPaneMessage(h, { type: 'artifactsRequest' });
    expect(sent).toEqual([{ method: 'artifact_list', params: {} }]);
    expect(out[0]).toMatchObject({ type: 'artifactsData', homeDevice: '5090' });
    // Exactly the one row flagged unopened.
    expect(out[1]).toEqual({ type: 'artifactsBadge', count: 1 });
  });

  it('an engine that rejects the method answers with an empty list and the reason', async () => {
    const { h, out } = host(async () => { throw new Error('Method not found: artifact_list'); });
    await handleArtifactsPaneMessage(h, { type: 'artifactsRequest' });
    expect(out[0]).toEqual({ type: 'artifactsData', artifacts: [], error: 'Method not found: artifact_list' });
    expect(out[1]).toEqual({ type: 'artifactsBadge', count: 0 });
  });

  it('with no live session it says so rather than reporting an empty group', async () => {
    const out: Array<Record<string, unknown>> = [];
    await handleArtifactsPaneMessage({ post: (m) => out.push(m) }, { type: 'artifactsRequest' });
    expect(String(out[0]!['error'])).toContain('Open a chat first');
  });

  // t-v47qh6: the owner's pane said "No artifacts yet" with NO note while the
  // store held an artifact. An engine that never answers left the pane with no
  // reply at all, so "still waiting" looked exactly like "empty".
  it('an engine that never answers becomes a reason on screen, not a silent empty list', async () => {
    vi.useFakeTimers();
    try {
      const { h, out } = host(() => new Promise<Record<string, unknown>>(() => undefined));
      const done = handleArtifactsPaneMessage(h, { type: 'artifactsRequest' });
      await vi.advanceTimersByTimeAsync(ARTIFACT_LIST_WAIT_MS);
      await done;
      expect(out[0]).toMatchObject({ type: 'artifactsData', artifacts: [] });
      expect(String(out[0]!['error'])).toMatch(/did not answer/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('artifactOpen calls artifact_open and opens the URL it returned', async () => {
    const { h, sent, opened, out } = host(ok({ url: 'https://origami.local/a1/v4' }));
    await handleArtifactsPaneMessage(h, { type: 'artifactOpen', artifactId: 'a1', version: 4 });
    expect(sent).toEqual([{ method: 'artifact_open', params: { artifactId: 'a1', version: 4 } }]);
    // The URL the ENGINE returned, untouched — the host does not build one.
    expect(opened).toEqual(['https://origami.local/a1/v4']);
    expect(out[0]).toEqual({ type: 'artifactOpened', artifactId: 'a1', version: 4, url: 'https://origami.local/a1/v4' });
  });

  it('artifactOpen with no version asks for the latest, and sends no version key at all', async () => {
    const { h, sent } = host(ok({ url: 'file:///tmp/a1.html' }));
    await handleArtifactsPaneMessage(h, { type: 'artifactOpen', artifactId: 'a1' });
    expect(sent[0]!.params).toEqual({ artifactId: 'a1' });
  });

  it('an artifact_open that returns no url opens nothing and says why', async () => {
    const { h, opened, out } = host(ok({}));
    await handleArtifactsPaneMessage(h, { type: 'artifactOpen', artifactId: 'a1' });
    expect(opened).toEqual([]);
    expect(String(out[0]!['error'])).toContain('no url');
  });

  it('opening an arrival takes it out of the badge count on the NEXT read', async () => {
    const { h, out } = host(async (method) =>
      method === 'artifact_open' ? { url: 'file:///tmp/a2.html' } : { artifacts: FIXTURE });
    await handleArtifactsPaneMessage(h, { type: 'artifactsRequest' });
    expect(out.at(-1)).toEqual({ type: 'artifactsBadge', count: 1 });
    await handleArtifactsPaneMessage(h, { type: 'artifactOpen', artifactId: 'a2' });
    await handleArtifactsPaneMessage(h, { type: 'artifactsRequest' });
    expect(out.at(-1)).toEqual({ type: 'artifactsBadge', count: 0 });
  });

  it('artifactsOpened clears the badge and keeps it clear across a re-read', async () => {
    const { h, out } = host(ok({ artifacts: FIXTURE }));
    await handleArtifactsPaneMessage(h, { type: 'artifactsOpened', ids: 'a2' });
    expect(out.at(-1)).toEqual({ type: 'artifactsBadge', count: 0 });
    await handleArtifactsPaneMessage(h, { type: 'artifactsRequest' });
    expect(out.at(-1)).toEqual({ type: 'artifactsBadge', count: 0 });
  });

  it('artifactRestore publishes the version again and re-reads the list', async () => {
    const { h, sent, out } = host(async (method) =>
      method === 'artifact_restore' ? { version: 5 } : { artifacts: FIXTURE });
    await handleArtifactsPaneMessage(h, { type: 'artifactRestore', artifactId: 'a2', version: 3 });
    expect(sent[0]).toEqual({ method: 'artifact_restore', params: { artifactId: 'a2', version: 3 } });
    expect(out[0]).toEqual({ type: 'artifactRestored', artifactId: 'a2', version: 5 });
    // A restore changes the latest version, so the list cannot be left stale.
    expect(sent[1]!.method).toBe('artifact_list');
  });

  it('artifactDiff forwards the three file lists, and an empty one on failure', async () => {
    const { h, sent, out } = host(ok({ added: ['a'], removed: [], changed: ['b'] }));
    await handleArtifactsPaneMessage(h, { type: 'artifactDiff', artifactId: 'a1', from: 1, to: 4 });
    expect(sent).toEqual([{ method: 'artifact_diff', params: { artifactId: 'a1', from: 1, to: 4 } }]);
    expect(out[0]).toMatchObject({ type: 'artifactDiffData', added: ['a'], removed: [], changed: ['b'] });

    const bad = host(async () => { throw new Error('nope'); });
    await handleArtifactsPaneMessage(bad.h, { type: 'artifactDiff', artifactId: 'a1', from: 1, to: 4 });
    expect(bad.out[0]).toMatchObject({ added: [], removed: [], changed: [], error: 'nope' });
  });

  it('a message missing its id or version reaches no engine at all', async () => {
    const { h, sent } = host(ok({}));
    await handleArtifactsPaneMessage(h, { type: 'artifactOpen' });
    await handleArtifactsPaneMessage(h, { type: 'artifactRestore', artifactId: 'a1' });
    await handleArtifactsPaneMessage(h, { type: 'artifactDiff', artifactId: 'a1', from: 1 });
    await handleArtifactsPaneMessage(h, { type: 'artifactVersionsRequest' });
    expect(sent).toEqual([]);
  });

  it('artifactRename calls artifact_rename and re-reads the list', async () => {
    const { h, sent, out } = host(async (method) =>
      method === 'artifact_rename' ? { title: 'Final report' } : { artifacts: FIXTURE });
    await handleArtifactsPaneMessage(h, { type: 'artifactRename', artifactId: 'a1', title: 'Final report' });
    expect(sent[0]).toEqual({ method: 'artifact_rename', params: { artifactId: 'a1', title: 'Final report' } });
    expect(out[0]).toEqual({ type: 'artifactRenamed', artifactId: 'a1', title: 'Final report' });
    expect(sent[1]!.method).toBe('artifact_list');
  });

  it('artifactRename with no title reaches no engine at all', async () => {
    const { h, sent } = host(ok({}));
    await handleArtifactsPaneMessage(h, { type: 'artifactRename', artifactId: 'a1', title: '' });
    expect(sent).toEqual([]);
  });

  it('artifactDelete calls artifact_delete and re-reads the list', async () => {
    const { h, sent, out } = host(async (method) =>
      method === 'artifact_delete' ? { removedVersions: 2, removedBlobs: 1 } : { artifacts: FIXTURE });
    await handleArtifactsPaneMessage(h, { type: 'artifactDelete', artifactId: 'a1' });
    expect(sent[0]).toEqual({ method: 'artifact_delete', params: { artifactId: 'a1' } });
    expect(out[0]).toEqual({ type: 'artifactDeleted', artifactId: 'a1' });
    expect(sent[1]!.method).toBe('artifact_list');
  });

  it('an engine that refuses a delete answers with the reason, not a silent no-op', async () => {
    const { h, out } = host(async (method) => {
      if (method === 'artifact_delete') throw new Error('no artifact a1');
      return { artifacts: FIXTURE };
    });
    await handleArtifactsPaneMessage(h, { type: 'artifactDelete', artifactId: 'a1' });
    expect(out[0]).toEqual({ type: 'artifactDeleted', artifactId: 'a1', error: 'no artifact a1' });
  });

  it('artifactOpenChatAbout opens a new chat, seeds its composer, then opens the artifact tab beside it', async () => {
    const { h, sent, out, opened, chats } = host(ok({ url: 'https://origami.local/a1/v4' }));
    await handleArtifactsPaneMessage(h, {
      type: 'artifactOpenChatAbout', artifactId: 'a1', title: 'Relief lab report', version: 4,
    });
    // The chat, THEN the seed, THEN the artifact tab — the post sequence the
    // ticket names as the acceptance check.
    expect(chats).toEqual(['chat-1']);
    expect(out[0]).toEqual({
      type: 'composerPrefill', sessionId: 'chat-1',
      text: 'About the artifact Relief lab report (origami://artifact/a1?v=4): ',
    });
    expect(sent).toEqual([{ method: 'artifact_open', params: { artifactId: 'a1', version: 4 } }]);
    expect(opened).toEqual(['https://origami.local/a1/v4']);
    expect(out.at(-1)).toEqual({ type: 'artifactChatOpened', artifactId: 'a1', sessionId: 'chat-1' });
  });

  it('artifactOpenChatAbout with no chat available opens nothing and says why', async () => {
    const { h, out, sent } = host(ok({ url: 'https://x' }));
    h.createChat = () => undefined;
    await handleArtifactsPaneMessage(h, {
      type: 'artifactOpenChatAbout', artifactId: 'a1', title: 'Relief lab report', version: 4,
    });
    expect(sent).toEqual([]);
    expect(out).toEqual([{ type: 'artifactChatOpened', artifactId: 'a1', error: 'Could not open a new chat.' }]);
  });

  it('artifactReveal reads localPath off artifact_open and hands it straight to revealPath', async () => {
    const { h, sent, out, revealed } = host(ok({ url: 'https://x', localPath: 'C:\\data\\artifacts\\blobs\\abc' }));
    await handleArtifactsPaneMessage(h, { type: 'artifactReveal', artifactId: 'a1', version: 4 });
    expect(sent).toEqual([{ method: 'artifact_open', params: { artifactId: 'a1', version: 4 } }]);
    expect(revealed).toEqual(['C:\\data\\artifacts\\blobs\\abc']);
    expect(out).toEqual([{ type: 'artifactRevealed', artifactId: 'a1' }]);
  });

  it('artifactReveal with no localPath reveals nothing and says why', async () => {
    const { h, out, revealed } = host(ok({ url: 'https://x' }));
    await handleArtifactsPaneMessage(h, { type: 'artifactReveal', artifactId: 'a1' });
    expect(revealed).toEqual([]);
    expect(String(out[0]!['error'])).toContain('no local path');
  });
});

// The drift guard. It CANNOT check the engine's dispatch the way the flock one
// does, because no engine implements these methods yet — so it checks the two
// things that exist: that the host sends only contract methods with only
// contract fields, and that the moment an engine grows ONE artifact_* case it
// must have grown all five.
describe('artifacts ACP wire — the contract this lane defines', () => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const hostFile = nodePath.resolve(here, '..', '..', '..', 'src', 'dashboard', 'artifactsPane.ts');
  const engineAgent = nodePath.resolve(here, '..', '..', '..', '..', 'engine', 'src', 'acp', 'agent.ts');

  it('reads the files it claims to (guards the paths, not just the regexes)', () => {
    expect(existsSync(hostFile), `${hostFile} not found`).toBe(true);
    expect(existsSync(engineAgent), `${engineAgent} not found`).toBe(true);
  });

  it('names the seven methods and the notification the engine lanes must match', () => {
    expect(ARTIFACT_METHOD_NAMES).toEqual([
      'artifact_list', 'artifact_versions', 'artifact_open', 'artifact_restore', 'artifact_diff',
      'artifact_rename', 'artifact_delete',
    ]);
    expect(ARTIFACTS_CHANGED_NOTIFICATIONS).toContain('origami/artifactsChanged');
  });

  it('every payload field shape is declared, both ways', () => {
    expect(ARTIFACT_PARAM_FIELDS['artifact_diff']).toEqual(['artifactId', 'from', 'to']);
    expect(ARTIFACT_RESULT_FIELDS['artifact_diff']).toEqual(['added', 'removed', 'changed']);
    expect(ARTIFACT_RESULT_FIELDS['artifact_open']).toEqual(['url', 'localPath']);
    expect(ARTIFACT_PARAM_FIELDS['artifact_rename']).toEqual(['artifactId', 'title']);
    expect(ARTIFACT_RESULT_FIELDS['artifact_delete']).toEqual(['removedVersions', 'removedBlobs']);
    expect(ARTIFACT_ROW_FIELDS).toEqual(expect.arrayContaining(['id', 'title', 'latest', 'ownerDevice', 'here', 'unopened', 'conflict']));
    expect(ARTIFACT_VERSION_FIELDS).toEqual(['number', 'digest', 'created', 'device']);
    expect(ARTIFACT_CONFLICT_FIELDS).toEqual(['device', 'theirVersion', 'yourVersion']);
    // Every method declared on one side is declared on the other.
    expect(Object.keys(ARTIFACT_PARAM_FIELDS).sort()).toEqual([...ARTIFACT_METHOD_NAMES].sort());
    expect(Object.keys(ARTIFACT_RESULT_FIELDS).sort()).toEqual([...ARTIFACT_METHOD_NAMES].sort());
  });

  it('the host sends no artifact_* method the contract does not name', () => {
    const src = readFileSync(hostFile, 'utf8');
    const sent = [...src.matchAll(/'(artifact_[a-z_]+)'/g)].map((m) => m[1]!);
    // The host reaches the wire through ARTIFACT_METHODS, so a bare literal
    // here is already the drift this guard is for.
    expect(sent, 'artifactsPane.ts hard-codes a method name; use ARTIFACT_METHODS').toEqual([]);
    for (const name of ARTIFACT_METHOD_NAMES) {
      const key = Object.entries(ARTIFACT_METHODS).find(([, v]) => v === name)![0];
      expect(src, `nothing in the host calls ${name}`).toContain(`ARTIFACT_METHODS.${key}`);
    }
  });

  it('the params the host builds are the params the contract declares', () => {
    const src = readFileSync(hostFile, 'utf8');
    // Read the object literal after each ARTIFACT_METHODS.<key> call site.
    for (const [key, method] of Object.entries(ARTIFACT_METHODS)) {
      const call = new RegExp(`ARTIFACT_METHODS\\.${key},\\s*\\{([^}]*(?:\\{[^}]*\\}[^}]*)*)\\}`, 's').exec(src);
      expect(call, `no call site for ${method}`).not.toBeNull();
      const fields = [...call![1]!.matchAll(/(?:^|[\s{,])([a-zA-Z]+)\s*[:,}]/g)].map((m) => m[1]!);
      const allowed = new Set(ARTIFACT_PARAM_FIELDS[method]!);
      const extra = [...new Set(fields)].filter((f) => !allowed.has(f));
      expect(extra, `${method} sends ${extra.join(', ')}, which the contract does not declare`).toEqual([]);
    }
  });

  it('an engine that implements ONE artifact method must implement all five', () => {
    const handled = new Set(
      [...readFileSync(engineAgent, 'utf8').matchAll(/case "(artifact_[a-z_]+)":/g)].map((m) => m[1]!),
    );
    // Today this set is empty and the pane lives on its empty state; the check
    // bites the moment an engine lane lands the first case.
    if (handled.size === 0) return;
    const missing = ARTIFACT_METHOD_NAMES.filter((name) => !handled.has(name));
    expect(missing, `acp/agent.ts has no case for ${missing.join(', ')}`).toEqual([]);
  });

  // The host's openUrl seam is injected by DashboardPanel, and a test that
  // only ever sees the seam would pass with nothing wired behind it. This reads
  // the wiring itself: the artifacts route hands the url to openArtifactUrl.
  //
  // NOT `handleBrowserRequest({ action: 'open' })`, which it used to be: that
  // is the agent's browser tool, it remembers no page, and every artifact url
  // shares the host `127.0.0.1:<port>` - so a second Open stacked a second tab
  // (or reused the tab of a DIFFERENT artifact, on VS Code's same-host
  // "similar page" rule). openArtifactUrl remembers the page it opened,
  // re-checks it against `list_browser_pages` and REVEALS it instead; the
  // behaviour itself is proved in artifactsOpen.test.ts.
  it('the panel wires openUrl to the integrated browser, not to a stub', () => {
    const panel = readFileSync(nodePath.resolve(here, '..', '..', '..', 'src', 'dashboard', 'DashboardPanel.ts'), 'utf8');
    const route = panel.split('\n').find((l) => l.includes('ARTIFACTS_PANE_MESSAGE_TYPES.has(m.type)'));
    expect(route, 'DashboardPanel.ts does not route the artifacts messages').toBeTruthy();
    expect(route!).toContain('await openArtifactUrl(url)');
    expect(panel).toContain("import { openArtifactUrl } from '../artifactsOpen'");
    // And the helper it names really is the reveal-reusing one.
    const opener = readFileSync(nodePath.resolve(here, '..', '..', '..', 'src', 'artifactsOpen.ts'), 'utf8');
    expect(opener).toContain('export async function openArtifactUrl');
    expect(opener).toContain('revealPage');
  });

  it('every message type the pane posts is one the host routes', () => {
    const pane = readFileSync(nodePath.join(here, '..', 'panes', 'ArtifactsPane.svelte'), 'utf8');
    const posted = [...pane.matchAll(/type: '(artifact[A-Za-z]*)'/g)].map((m) => m[1]!);
    expect(posted.length).toBeGreaterThan(3);
    const unrouted = [...new Set(posted)].filter((t) => !ARTIFACTS_PANE_MESSAGE_TYPES.has(t));
    expect(unrouted, `${unrouted.join(', ')} would be posted into the void`).toEqual([]);
  });
});

describe('the Artifacts view is on the board rail', () => {
  it('has a row of its own, mounting ArtifactsPane', () => {
    const entry = VIEWS.find((v) => v.id === 'artifacts');
    expect(entry, 'no artifacts row in VIEWS').toBeTruthy();
    expect(entry!.component).toBe(ArtifactsPane);
    expect(entry!.icon).toContain('<path');
  });

  it('the dock pill\'s section word resolves to that view — the same switch every pane uses', () => {
    expect(isViewId('artifacts')).toBe(true);
    expect(viewForSection('artifacts')).toBe('artifacts');
  });
});

describe('theme — the new files name colours only as --og-* vars', () => {
  const pkg = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const FILES = [
    'webview/dashboard/panes/ArtifactsPane.svelte',
    'webview/dashboard/components/ArtifactVersions.svelte',
    'webview/dashboard/components/ArtifactConflictBanner.svelte',
  ];

  it.each(FILES)('%s hard-codes no colour', (rel) => {
    const src = readFileSync(nodePath.join(pkg, rel), 'utf8');
    const literals = [
      ...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...src.matchAll(/\brgba?\(/g),
      ...src.matchAll(/\bhsla?\(/g),
    ].map((m) => m[0]);
    expect(literals, `${rel} hard-codes ${literals.join(', ')}`).toEqual([]);
  });
});
