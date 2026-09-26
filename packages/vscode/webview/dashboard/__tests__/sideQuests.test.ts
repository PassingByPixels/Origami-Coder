// Side quests (t-f89g49) — the SHELL half: the file contract, the folder, the
// four messages, the drawer, the popup, and the phone's share of all of it.
//
// THE FIXTURE IS WRITTEN HERE, not taken from the engine lane. The two halves
// ship in different packages and are built in parallel; a test that imported the
// producer would prove the two agree with each other rather than that either
// agrees with the contract. `quest()` below IS the agreed format, spelled out —
// five frontmatter keys, three `## ` sections, in order, UTF-8, LF — so a drift
// on either side of the folder fails on a literal somebody can read.
//
// The folder tests use a REAL temp directory. `.origami/sidequests` is the whole
// protocol between two processes, so a mocked `fs` would test the mock: "a chat
// closed and the drawer came back" is a claim about files on disk.
import { render, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSideQuest, sideQuestNumber, stampStatus } from '../../../src/dashboard/sideQuestFile';
import {
  SIDE_QUESTS_DIR,
  SIDE_QUESTS_MESSAGE_TYPES,
  handleSideQuestMessage,
  questPath,
  readOpenSideQuests,
  stopSideQuestWatchers,
  type SideQuestsHost,
} from '../../../src/dashboard/sideQuestsPane';
import { sideQuestsEnabled, SIDE_QUESTS_FLAG } from '../../../src/sideQuestsFlag';
import { NAMED_REFUSALS, PHONE_VERBS, verbNeeds, verbVerdict } from '../../../src/remote/remoteVerbs';
import { isPhoneMount, isSideQuestsData, type SideQuest } from '../panes/sideQuestProps';
import SideQuestsDock from '../components/SideQuestsDock.svelte';
import SideQuestsDrawer from '../components/SideQuestsDrawer.svelte';
import SideQuestPopup from '../components/SideQuestPopup.svelte';

// --- the agreed file format, spelled out ------------------------------------

function quest(
  n: number,
  opts: { status?: string; title?: string; rationale?: boolean; instructions?: string } = {},
): string {
  const lines = [
    '---',
    `id: SQ-${n}`,
    `title: ${opts.title ?? `Quest number ${n}`}`,
    `status: ${opts.status ?? 'open'}`,
    'created: 2026-09-15T20:11:02Z',
    'session: ses_abc123',
    '---',
    '',
    '## Summary',
    `Summary of ${n}.`,
    '',
  ];
  if (opts.rationale) lines.push('## Rationale', `Why ${n} is worth doing.`, '');
  lines.push('## Instructions', opts.instructions ?? `Do the thing for ${n}.`, '');
  return lines.join('\n');
}

const dirs: string[] = [];
function workspace(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-sq-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, SIDE_QUESTS_DIR), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, SIDE_QUESTS_DIR, name), text, 'utf8');
  }
  return root;
}

afterEach(() => {
  stopSideQuestWatchers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  globalThis.__vscodeApiMock.postMessage.mockClear();
});

/** A host whose every editor-facing callback is a spy. */
// `chatId: null` is the 'the host could not make a chat' case. NOT `undefined`:
// an explicit undefined re-triggers the default parameter, which is exactly the
// bug this note exists to stop being re-introduced.
function host(cwd: string, enabled = true, chatId: string | null = 'sess-new') {
  const posts: Array<Record<string, unknown>> = [];
  const chats: number[] = [];
  const saved: Array<{ fileName: string; bytes: string }> = [];
  const h: SideQuestsHost = {
    cwd,
    post: (m) => void posts.push(m),
    enabled: () => enabled,
    createChat: () => { chats.push(1); return chatId ?? undefined; },
    save: (fileName, bytes) => void saved.push({ fileName, bytes }),
  };
  /** The LAST list posted — every handler ends with one. */
  const quests = () => (posts.findLast((p) => p['type'] === 'sideQuestsData')?.['quests'] ?? []) as SideQuest[];
  const of = (type: string) => posts.filter((p) => p['type'] === type);
  return { h, posts, chats, saved, quests, of };
}

// --- the file contract -------------------------------------------------------

describe('the side-quest file contract (t-f89g49)', () => {
  it('reads every agreed field out of a file in the agreed shape', () => {
    const parsed = parseSideQuest(quest(3, { rationale: true, title: 'Tighten the verb table' }));
    expect(parsed).toEqual({
      id: 'SQ-3',
      title: 'Tighten the verb table',
      status: 'open',
      created: '2026-09-15T20:11:02Z',
      session: 'ses_abc123',
      summary: 'Summary of 3.',
      rationale: 'Why 3 is worth doing.',
      instructions: 'Do the thing for 3.',
    });
  });

  it('an absent Rationale is empty, not missing — the popup renders nothing for it', () => {
    expect(parseSideQuest(quest(1))?.rationale).toBe('');
  });

  it('parses a file that came back through an editor as CRLF', () => {
    // The contract says LF, but the folder is the owner's and he may open a file
    // in anything. A quest that vanished from the drawer because Notepad saved it
    // would be unexplainable from the UI.
    expect(parseSideQuest(quest(4).replace(/\n/g, '\r\n'))?.id).toBe('SQ-4');
  });

  it('refuses anything that is not a quest file, rather than half-rendering it', () => {
    expect(parseSideQuest('just some notes')).toBeNull();
    expect(parseSideQuest(quest(2, { status: 'archived' }))).toBeNull(); // not one of the three
    expect(parseSideQuest(quest(2).replace('## Instructions\nDo the thing for 2.\n', ''))).toBeNull();
    expect(parseSideQuest(quest(2).replace('id: SQ-2', 'id: ../../etc/passwd'))).toBeNull();
  });

  it('sorts SQ-10 after SQ-9 — numerically, which a string compare gets wrong', () => {
    expect(sideQuestNumber('SQ-10')).toBeGreaterThan(sideQuestNumber('SQ-9'));
    expect(sideQuestNumber('nonsense')).toBe(-1);
  });

  it('a stamp rewrites the status LINE and nothing else in the file', () => {
    const before = quest(5, { rationale: true, instructions: 'status: keep this prose intact' });
    const after = stampStatus(before, 'started');
    expect(after).toBe(before.replace('status: open', 'status: started'));
    // ...including a `status:` that is body prose, which is not the key.
    expect(after).toContain('status: keep this prose intact');
    expect(parseSideQuest(after)?.status).toBe('started');
  });

  it('a stamp keeps the file\u2019s own line endings', () => {
    const crlf = quest(6).replace(/\n/g, '\r\n');
    expect(stampStatus(crlf, 'dismissed')).toContain('\r\n');
    expect(stampStatus(quest(6), 'dismissed')).not.toContain('\r');
  });

  it('a MIXED-EOL file (the status line CRLF, every other line LF) is stamped by rewriting only the status line\u2019s text \u2014 every other line stays byte-identical', () => {
    // A split-and-rejoin-with-one-eol implementation would renormalise every
    // line to whichever ending it saw first; this fixture has the status
    // line itself carry CRLF while the rest of the file is LF, so that bug
    // would flip the CLOSING fence and every later line to CRLF too.
    const before = quest(7).replace('status: open\n', 'status: open\r\n');
    const after = stampStatus(before, 'started');
    const beforeLines = before.split(/(?<=\r\n|(?<!\r)\n)/);
    const afterLines = after.split(/(?<=\r\n|(?<!\r)\n)/);
    expect(afterLines).toHaveLength(beforeLines.length);
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i]!.startsWith('status: open')) {
        expect(afterLines[i]).toBe('status: started\r\n'); // text changed, CRLF kept
      } else {
        expect(afterLines[i]).toBe(beforeLines[i]); // byte-identical, own ending untouched
      }
    }
  });
});

// --- the folder --------------------------------------------------------------

describe('the folder is the state (t-f89g49)', () => {
  it('lists only OPEN quests, in SQ number order, and ignores what it cannot read', () => {
    const cwd = workspace({
      'SQ-10.md': quest(10),
      'SQ-2.md': quest(2),
      'SQ-3.md': quest(3, { status: 'dismissed' }),
      'SQ-4.md': quest(4, { status: 'started' }),
      'notes.md': 'a file somebody dropped in here',
      'SQ-5.txt': quest(5),
    });
    expect(readOpenSideQuests(cwd).map((q) => q.id)).toEqual(['SQ-2', 'SQ-10']);
  });

  it('a workspace that has never raised one lists nothing, and does not throw', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-sq-bare-'));
    dirs.push(cwd);
    expect(readOpenSideQuests(cwd)).toEqual([]);
  });

  it('an id that is not SQ-<n> never reaches path.join', () => {
    // The id is webview input. A bare join on it is how `../../` writes outside
    // the folder, so the shape is checked before the path is built at all.
    expect(questPath('C:/ws', '../../../etc/passwd')).toBeNull();
    expect(questPath('C:/ws', 'SQ-7')).toBe(path.join('C:/ws', SIDE_QUESTS_DIR, 'SQ-7.md'));
  });
});

// --- the four messages -------------------------------------------------------

describe('the side-quest messages (t-f89g49)', () => {
  it('the request replays the FOLDER — which is why a reload and a chat close cost nothing', () => {
    const cwd = workspace({ 'SQ-1.md': quest(1), 'SQ-2.md': quest(2) });
    const a = host(cwd);
    void handleSideQuestMessage(a.h, { type: 'requestSideQuests' });
    expect(a.quests().map((q) => q.id)).toEqual(['SQ-1', 'SQ-2']);
    // A SECOND, independent host — a fresh webview after a reload, or another
    // chat cell — gets the same list with no state carried between them.
    const b = host(cwd);
    void handleSideQuestMessage(b.h, { type: 'requestSideQuests' });
    expect(b.quests().map((q) => q.id)).toEqual(['SQ-1', 'SQ-2']);
  });

  it('Start opens an empty chat and PREFILLS it — it never sends the brief', async () => {
    // The owner's own wording: "new session would need to be prompted for what
    // model and sub agent model". A send here would spend that choice on the new
    // cell's default before he ever saw the picker.
    const cwd = workspace({ 'SQ-1.md': quest(1, { instructions: 'Port the verb table test.' }), 'SQ-2.md': quest(2) });
    const h = host(cwd);
    await handleSideQuestMessage(h.h, { type: 'sideQuestStart', id: 'SQ-1' });
    expect(h.chats).toHaveLength(1);
    expect(h.of('composerPrefill')).toEqual([
      { type: 'composerPrefill', sessionId: 'sess-new', text: 'Port the verb table test.' },
    ]);
    expect(h.of('send')).toEqual([]);
    expect(h.posts.some((p) => String(p['type']).toLowerCase().includes('send'))).toBe(false);
    expect(fs.readFileSync(path.join(cwd, SIDE_QUESTS_DIR, 'SQ-1.md'), 'utf8')).toContain('status: started');
    expect(h.quests().map((q) => q.id)).toEqual(['SQ-2']);
  });

  it('a chat the host could not make prefills nothing, and the stamp still stands', async () => {
    const cwd = workspace({ 'SQ-1.md': quest(1) });
    const h = host(cwd, true, null);
    await handleSideQuestMessage(h.h, { type: 'sideQuestStart', id: 'SQ-1' });
    expect(h.of('composerPrefill')).toEqual([]);
    // Deliberate: the quest is `started` and off the list either way. A row that
    // came back because the window could not open a tab would be startable twice.
    expect(h.quests()).toEqual([]);
  });

  it('Dismiss stamps `dismissed`, hides the row, and KEEPS the file', async () => {
    const cwd = workspace({ 'SQ-1.md': quest(1) });
    const h = host(cwd);
    await handleSideQuestMessage(h.h, { type: 'sideQuestDismiss', id: 'SQ-1' });
    expect(h.quests()).toEqual([]);
    expect(fs.existsSync(path.join(cwd, SIDE_QUESTS_DIR, 'SQ-1.md'))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, SIDE_QUESTS_DIR, 'SQ-1.md'), 'utf8')).toContain('status: dismissed');
  });

  it('Export hands over the file\u2019s own bytes and changes nothing', async () => {
    const text = quest(1, { rationale: true });
    const cwd = workspace({ 'SQ-1.md': text });
    const h = host(cwd);
    await handleSideQuestMessage(h.h, { type: 'sideQuestExport', id: 'SQ-1' });
    expect(h.saved).toEqual([{ fileName: 'SQ-1.md', bytes: text }]);
    expect(fs.readFileSync(path.join(cwd, SIDE_QUESTS_DIR, 'SQ-1.md'), 'utf8')).toBe(text);
    expect(h.quests().map((q) => q.id)).toEqual(['SQ-1']); // still open
  });

  it('an id the folder does not hold writes nothing and starts nothing', async () => {
    const cwd = workspace({ 'SQ-1.md': quest(1) });
    const h = host(cwd);
    await handleSideQuestMessage(h.h, { type: 'sideQuestStart', id: '../../../etc/passwd' });
    await handleSideQuestMessage(h.h, { type: 'sideQuestDismiss', id: 'SQ-99' });
    expect(h.chats).toEqual([]);
    expect(h.quests().map((q) => q.id)).toEqual(['SQ-1']);
  });

  it('FLAG OFF: no list, no start, no export, no post at all', async () => {
    const cwd = workspace({ 'SQ-1.md': quest(1) });
    const h = host(cwd, false);
    for (const type of [...SIDE_QUESTS_MESSAGE_TYPES]) {
      await handleSideQuestMessage(h.h, { type, id: 'SQ-1' });
    }
    expect(h.posts).toEqual([]);
    expect(h.chats).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(fs.readFileSync(path.join(cwd, SIDE_QUESTS_DIR, 'SQ-1.md'), 'utf8')).toContain('status: open');
  });

  // t-ffjau8. ON is the default now, here too: there is no `vscode` settings
  // store under vitest, and an unreadable store means ON, the same as the
  // engine's own default. Only an explicit `false` — in the env or in the
  // setting — turns it off.
  it('the flag itself is on unless the env says otherwise', () => {
    expect(sideQuestsEnabled({})).toBe(true);
    expect(sideQuestsEnabled({ [SIDE_QUESTS_FLAG]: 'false' })).toBe(false);
    expect(sideQuestsEnabled({ [SIDE_QUESTS_FLAG]: 'true' })).toBe(true);
    expect(sideQuestsEnabled({ [SIDE_QUESTS_FLAG]: '1' })).toBe(true);
  });
});

// --- the folder watcher ------------------------------------------------------

/** Waits for a real `fs.watch` event to land, up to `ms`. The watcher is an OS
 *  notification, not a promise: there is nothing to await, so this polls the
 *  host's own post list. Returns whether the condition came true. */
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

describe('the folder watcher follows the LIVE panel (t-fisfs5 R4)', () => {
  it('re-points to the second host for the same cwd, and the first stops hearing', async () => {
    // One workspace, two DashboardPanel hosts in turn — the reopened-panel case.
    // The watcher is module state keyed by cwd, so the second host used to be
    // handed nothing and the FIRST kept receiving posts into a dead webview.
    const cwd = workspace({ 'SQ-1.md': quest(1) });
    const first = host(cwd);
    const second = host(cwd);

    await handleSideQuestMessage(first.h, { type: 'requestSideQuests' });
    await handleSideQuestMessage(second.h, { type: 'requestSideQuests' });
    const firstPostsBefore = first.posts.length;

    fs.writeFileSync(path.join(cwd, SIDE_QUESTS_DIR, 'SQ-2.md'), quest(2), 'utf8');

    expect(await until(() => second.quests().length === 2)).toBe(true);
    expect(second.quests().map((q) => q.id)).toEqual(['SQ-1', 'SQ-2']);
    // The disposed panel heard nothing after its own list.
    expect(first.posts.length).toBe(firstPostsBefore);
  });

  it('stopSideQuestWatchers silences the folder, so a disposed panel hears nothing', async () => {
    const cwd = workspace({ 'SQ-1.md': quest(1) });
    const only = host(cwd);
    await handleSideQuestMessage(only.h, { type: 'requestSideQuests' });
    const before = only.posts.length;

    stopSideQuestWatchers();
    fs.writeFileSync(path.join(cwd, SIDE_QUESTS_DIR, 'SQ-2.md'), quest(2), 'utf8');

    // Nothing to await on a watcher that must NOT fire: give a real event the
    // same window the positive test above needed, then assert silence.
    await until(() => only.posts.length > before, 500);
    expect(only.posts.length).toBe(before);
  });
});

// --- the phone ---------------------------------------------------------------

describe('the phone reads side quests and acts on none of them (t-f89g49)', () => {
  it('the drawer verb is `watch`, the same tier the sub-agent drawer sits at', () => {
    expect(PHONE_VERBS.get('openSideQuestsDrawer')).toBe('watch');
    expect(verbNeeds({ type: 'openSideQuestsDrawer', sessionId: 'a' })).toBe('watch');
  });

  it('the LIST rides the `request*` prefix rule, so a watch phone can read it', () => {
    expect(verbNeeds({ type: 'requestSideQuests' })).toBe('watch');
  });

  it('Start, Export and Dismiss are refused at EVERY capability, including full', () => {
    for (const type of ['sideQuestStart', 'sideQuestExport', 'sideQuestDismiss']) {
      expect(NAMED_REFUSALS, type).toContain(type);
      expect(PHONE_VERBS.has(type), type).toBe(false);
      for (const capability of ['watch', 'ask', 'full'] as const) {
        const verdict = verbVerdict({ type, id: 'SQ-1' }, capability);
        expect(verdict.allow, `${type} at ${capability}`).toBe(false);
      }
    }
  });

  it('the popup shows the phone a sentence where the desk gets three buttons', () => {
    const { getByText, queryByText } = render(SideQuestPopup, {
      props: { quest: ROW, phoneOnly: true, onStart: vi.fn(), onExport: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() },
    });
    expect(queryByText('Start in a new session')).toBeNull();
    expect(getByText(/desk only/)).toBeInTheDocument();
  });

  it('neither surface pins a width a 390px page cannot hold', () => {
    // A SOURCE assertion, deliberately, and the report says so: jsdom has no
    // layout engine, so a rendered-width expectation here would be a number the
    // test invented. What CAN be checked is that no fixed px width is declared
    // without a percentage beside it \u2014 `width: 640px` on the popup is the one
    // way this feature breaks the phone page, and it is visible in the text.
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of ['SideQuestPopup.svelte', 'SideQuestsDrawer.svelte', 'SideQuestsTab.svelte']) {
      const src = fs.readFileSync(path.join(here, '..', 'components', rel), 'utf8');
      for (const decl of src.match(/^\s*(?:width|min-width):[^;]+;/gm) ?? []) {
        // A `min(...)` or a percentage already yields to the viewport. Anything
        // else has to be a px value the page can actually hold.
        if (decl.includes('min(') || decl.includes('%')) continue;
        const widest = Math.max(0, ...[...decl.matchAll(/(\d+)px/g)].map((m) => Number(m[1])));
        expect(widest, `${rel}: ${decl.trim()}`).toBeLessThanOrEqual(390);
      }
    }
  });

  it('isPhoneMount reads the remote shell\u2019s own marker, and nothing else', () => {
    expect(isPhoneMount({})).toBe(false);
    expect(isPhoneMount({ __ORIGAMI_REMOTE_READY__: Promise.resolve() })).toBe(true);
  });
});

// --- the drawer and the popup ------------------------------------------------

const ROW: SideQuest = {
  id: 'SQ-7',
  title: 'Port the verb table test',
  summary: 'The coverage test scans the bundle but not the shell verbs.',
  rationale: 'Noticed while adding a row; not this task.',
  instructions: 'Extend extractWireVerbs to the shell frames and assert each has a row.',
  created: '2026-09-15T20:11:02Z',
};

describe('the Side quests drawer (t-f89g49)', () => {
  it('draws nothing at all — not even a tab — when there are no open quests', () => {
    const { container } = render(SideQuestsDrawer, {
      props: { quests: [], open: false, onToggle: vi.fn(), onOpen: vi.fn() },
    });
    expect(container.querySelector('.sq-drawer')).toBeNull();
  });

  it('is COLLAPSED by default and carries the open count on its tab', () => {
    const { container, getByTitle } = render(SideQuestsDrawer, {
      props: { quests: [ROW], open: false, onToggle: vi.fn(), onOpen: vi.fn() },
    });
    expect(container.querySelector('.sq-drawer.collapsed')).not.toBeNull();
    expect(getByTitle('1 side quest waiting')).toBeInTheDocument();
    // The list itself is shut too: the panel costs one line until expanded.
    expect(container.querySelector('.sq-row')).toBeNull();
  });

  it('expands to one row per open quest, and a row opens the popup by id', async () => {
    const onOpen = vi.fn();
    const two = [ROW, { ...ROW, id: 'SQ-8', title: 'Second one' }];
    const { container, getByText } = render(SideQuestsDrawer, {
      props: { quests: two, open: true, onToggle: vi.fn(), onOpen },
    });
    await fireEvent.click(getByText('Side quests'));
    expect(container.querySelectorAll('.sq-row')).toHaveLength(2);
    await fireEvent.click(getByText('Second one'));
    expect(onOpen).toHaveBeenCalledWith('SQ-8');
  });
});

describe('the side-quest popup (t-f89g49)', () => {
  const mount = (over: Partial<Record<string, unknown>> = {}) => {
    const spies = { onStart: vi.fn(), onExport: vi.fn(), onDismiss: vi.fn(), onClose: vi.fn() };
    return { spies, ...render(SideQuestPopup, { props: { quest: ROW, ...spies, ...over } }) };
  };

  it('shows the id, the title, the summary and the rationale', () => {
    const { getByText } = mount();
    expect(getByText('Suggested side quest · SQ-7')).toBeInTheDocument();
    expect(getByText(ROW.title)).toBeInTheDocument();
    expect(getByText(ROW.summary)).toBeInTheDocument();
    expect(getByText(ROW.rationale)).toBeInTheDocument();
  });

  it('keeps the instructions behind a fold — they are for the agent, not the reader', async () => {
    const { getByText, queryByText } = mount();
    expect(queryByText(ROW.instructions)).toBeNull();
    await fireEvent.click(getByText(/Show instructions/)); // t-yyz5je: mockup label
    expect(getByText(ROW.instructions)).toBeInTheDocument();
  });

  it('each of the three actions fires its own callback and nothing else\u2019s', async () => {
    for (const [label, key] of [
      ['Start in a new session', 'onStart'],
      ['Export', 'onExport'],
      ['Dismiss', 'onDismiss'],
    ] as const) {
      // UNMOUNTED each pass: the queries are bound to document.body, so three
      // live popups would make every `getByText` ambiguous.
      const { spies, getByText, unmount } = mount();
      await fireEvent.click(getByText(label));
      expect(spies[key]).toHaveBeenCalledTimes(1);
      for (const other of ['onStart', 'onExport', 'onDismiss'] as const) {
        if (other !== key) expect(spies[other], `${label} also fired ${other}`).not.toHaveBeenCalled();
      }
      unmount();
    }
  });

  it('Escape closes it — it covers the chat cell, so the key has nowhere else to go', async () => {
    const { spies } = mount();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(spies.onClose).toHaveBeenCalled();
  });

  it('is NON-BLOCKING: aria-modal is false, so nothing behind it is inert', () => {
    const { container } = mount();
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('false');
  });
});

describe('the dock’s wire (t-f89g49)', () => {
  const posts = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0] as { type: string });

  /** Deliver a host payload the way the panel does. */
  const deliver = async (quests: SideQuest[]) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sideQuestsData', quests } }));
    await Promise.resolve();
  };

  it('asks the host for the folder on mount, and again whenever the window is focused', async () => {
    render(SideQuestsDock, { props: { sessionId: 'sess-1', open: false, onToggle: vi.fn() } });
    expect(posts().filter((m) => m.type === 'requestSideQuests')).toHaveLength(1);
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(posts().filter((m) => m.type === 'requestSideQuests')).toHaveLength(2);
  });

  it('renders the host’s rows, and holds NO list of its own between payloads', async () => {
    const { container } = render(SideQuestsDock, { props: { sessionId: 'sess-1', open: true, onToggle: vi.fn() } });
    expect(container.querySelector('.sq-drawer')).toBeNull();
    await deliver([ROW]);
    expect(container.querySelector('.sq-drawer')).not.toBeNull();
    // A host that has just been told the flag is off (or the quest was started)
    // sends an empty list, and the drawer goes away with it.
    await deliver([]);
    expect(container.querySelector('.sq-drawer')).toBeNull();
  });

  it('posts `openSideQuestsDrawer` when the tab OPENS, and nothing when it shuts', async () => {
    const onToggle = vi.fn();
    const { getByTitle, rerender } = render(SideQuestsDock, { props: { sessionId: 'sess-1', open: false, onToggle } });
    await deliver([ROW]);
    await fireEvent.click(getByTitle('1 side quest waiting'));
    expect(posts()).toContainEqual({ type: 'openSideQuestsDrawer', sessionId: 'sess-1' });
    expect(onToggle).toHaveBeenCalledTimes(1);

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await rerender({ sessionId: 'sess-1', open: true, onToggle });
    await fireEvent.click(getByTitle('Hide side quests'));
    expect(posts().some((m) => m.type === 'openSideQuestsDrawer')).toBe(false);
  });

  it('a row’s action posts its own message by id, and closes the popup', async () => {
    const { getByText, queryByText, container } = render(SideQuestsDock, {
      props: { sessionId: 'sess-1', open: true, onToggle: vi.fn() },
    });
    await deliver([ROW]);
    await fireEvent.click(getByText('Side quests'));
    await fireEvent.click(getByText(ROW.title));
    expect(container.querySelector('.sqp-scrim')).not.toBeNull();
    await fireEvent.click(getByText('Dismiss'));
    expect(posts()).toContainEqual({ type: 'sideQuestDismiss', id: 'SQ-7' });
    expect(queryByText('Suggested side quest · SQ-7')).toBeNull();
  });
});

describe('the host payload guard', () => {
  it('accepts a real payload and refuses a host too old to send one', () => {
    expect(isSideQuestsData({ type: 'sideQuestsData', quests: [] })).toBe(true);
    expect(isSideQuestsData({ type: 'sideQuestsData' })).toBe(false);
    expect(isSideQuestsData({ type: 'somethingElse', quests: [] })).toBe(false);
    expect(isSideQuestsData(null)).toBe(false);
  });
});

// t-fh4tbx — the drawer rendered BEHIND the transcript and over the pinned user
// message. jsdom has no layout engine and no cascade across component
// boundaries, so a rendered assertion here would prove nothing: the two rules
// below live in two different files and only ever meet in a real browser. What
// IS breakable is the SOURCE pair — the same technique todoTabsRender.test.ts
// uses for the tab strip's numbers. These pin the two claims the fix rests on:
// the drawer outranks the sticky band, and its top edge starts below it.
describe('the Side quests drawer clears the pinned user message (t-fh4tbx, CSS source)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (file: string) =>
    fs.readFileSync(path.resolve(here, '../components', file), 'utf8');

  // Slices one named rule block out of a stylesheet source string.
  const rule = (src: string, selector: string) => {
    const start = src.indexOf(selector);
    if (start < 0) throw new Error(`${selector} not found`);
    return src.slice(start, src.indexOf('}', start));
  };

  it('outranks the pinned band — a tie loses on DOM order, so it must be strictly greater', () => {
    const drawer = Number(rule(read('SideQuestsDrawer.svelte'), '.sq-drawer {').match(/z-index:\s*(\d+)/)?.[1]);
    const pinned = Number(rule(read('PinnedUserMessage.svelte'), '.pinned-user {').match(/z-index:\s*(\d+)/)?.[1]);
    expect(pinned).toBeGreaterThan(0);
    expect(drawer).toBeGreaterThan(pinned);
  });

  it('starts 72px down — the multi-up band (header 24 + pad 6 + band 36) plus a 6px gap', () => {
    const drawer = rule(read('SideQuestsDrawer.svelte'), '.sq-drawer {');
    expect(Number(drawer.match(/top:\s*(\d+)px/)?.[1])).toBe(72);
    // The band's own height is the sum this number was built from; if any of
    // these three change, 72 is stale and this test is the place it shows.
    const pinned = rule(read('PinnedUserMessage.svelte'), '.pinned-user {');
    expect(pinned).toMatch(/padding:\s*5px 10px 10px/);
    expect(pinned).toMatch(/font-size:\s*11\.5px/);
    // t-qmzegs item 4 turned the band into a fade: the bottom padding grew from
    // 5 to 10 to give the gradient room, and the margin shrank from 8 to 3 to
    // pay for it. 10 + 3 = 5 + 8, so the band's HEIGHT — which is what 72 is
    // built from — did not move, and this test still fails if it ever does.
    expect(pinned).toMatch(/margin:\s*0 0 3px 0/);
  });
});
