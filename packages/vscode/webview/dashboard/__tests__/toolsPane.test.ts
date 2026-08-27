// toolsPane.test.ts — the Tools view, both halves.
//
// Host side (src/dashboard/toolsPane.ts), against a faked `vscode`: the five
// messages the pane can send, and the two WRITES they can trigger. Both writes
// are the case that matters, for the same reason: the webview names a TOOL,
// never a path and never a verdict. The scaffold's name is refused before it
// becomes a filename and an existing tool is opened rather than overwritten;
// the state control and copy-path re-read the catalog and take `hardRequired`
// and `location` off THAT, so a stale or compromised webview cannot aim either
// one — and the STATE itself is a closed set of three, so a garbled message
// cannot switch a tool off by accident. Both `node:fs` and `node:os` are faked here as well as `vscode`, so the
// origami.json writer never touches the real home directory of whoever runs
// this suite.
//
// Webview side (panes/ToolsPane.svelte + ToolCard/ToolStateSwitch/
// NewToolPanel): each of the three states has to be visibly different from the
// other two, and reachable from the same control. jsdom has no layout
// engine and no <style>, so this asserts the CLASS and the badge TEXT — never a
// computed colour, which would assert nothing while looking rigorous. By the
// same limit, nothing here proves the GRID lays out; that needs a human eye.
//
// Last block is the drift guard over the three-way `source` mirror — see its
// own comment for why the failure it catches is silent.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { fake } = vi.hoisted(() => ({
  fake: {
    settings: {} as Record<string, unknown>,
    updates: [] as Array<{ key: string; value: unknown }>,
    folders: [{ uri: { fsPath: 'C:/ws' } }] as unknown[] | undefined,
    existing: new Set<string>(),
    written: [] as Array<{ path: string; text: string }>,
    dirs: [] as string[],
    opened: [] as string[],
    errors: [] as string[],
    infos: [] as string[],
    copied: [] as string[],
    // Every path the host actually asked VS Code to delete. The delete tests
    // below assert on this list rather than on a real file, so a bug that
    // aimed the unlink somewhere else shows up as a wrong string here instead
    // of as a missing file on the machine running the suite.
    deleted: [] as Array<{ path: string; useTrash: boolean }>,
    deleteThrows: false,
    // A fully in-memory stand-in for the GLOBAL origami.json (node:fs below),
    // so writeDeferOverride never touches a real file on the machine running
    // this suite.
    globalConfig: new Map<string, string>(),
  },
}));

// path.join gives backslashes on Windows and forward slashes elsewhere, and
// this suite must assert the same string on both, so the fake FS keys on a
// separator-normalised path rather than on the raw one.
const key = (p: string) => p.split('\\').join('/');

vi.mock('vscode', () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  ConfigurationTarget: { Global: 1 },
  env: {
    clipboard: {
      // Normalised the same way the fake FS keys paths: path.join gives
      // backslashes on Windows, and this suite asserts the same string on
      // both platforms.
      writeText: async (text: string) => void fake.copied.push(key(text)),
    },
  },
  window: {
    showErrorMessage: (m: string) => void fake.errors.push(m),
    showInformationMessage: (m: string) => void fake.infos.push(m),
    showTextDocument: async (doc: { fsPath: string }) => void fake.opened.push(doc.fsPath),
  },
  workspace: {
    get workspaceFolders() {
      return fake.folders;
    },
    getConfiguration: () => ({
      get: (key: string) => fake.settings[key],
      update: async (key: string, value: unknown) => {
        fake.settings[key] = value;
        fake.updates.push({ key, value });
      },
    }),
    openTextDocument: async (uri: { fsPath: string }) => uri,
    fs: {
      stat: async (uri: { fsPath: string }) => {
        if (!fake.existing.has(key(uri.fsPath))) throw new Error('ENOENT');
        return {};
      },
      createDirectory: async (uri: { fsPath: string }) => void fake.dirs.push(key(uri.fsPath)),
      writeFile: async (uri: { fsPath: string }, data: Uint8Array) => {
        fake.written.push({ path: key(uri.fsPath), text: Buffer.from(data).toString('utf8') });
        fake.existing.add(key(uri.fsPath));
      },
      delete: async (uri: { fsPath: string }, options?: { useTrash?: boolean }) => {
        if (fake.deleteThrows) throw new Error('EPERM: file is read-only');
        fake.deleted.push({ path: key(uri.fsPath), useTrash: options?.useTrash === true });
        fake.existing.delete(key(uri.fsPath));
      },
    },
  },
}));

// writeDeferOverride reads/writes the GLOBAL origami.json through node:fs
// directly (matching firstFold.ts's existing config writers), so THIS suite
// mocks node:fs/node:os the same way it mocks vscode — never the real home
// directory.
// The fake owns only the paths it has actually been given: a READ of anything
// else falls through to the real fs, because the drift guard at the bottom of
// this file reads three real source files through this same import. WRITES are
// faked unconditionally — no test here has any business touching the disk.
vi.mock('node:os', () => ({ homedir: () => 'C:/fakehome' }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => fake.globalConfig.has(key(p)),
    readFileSync: ((p: string, enc?: unknown) => {
      const v = fake.globalConfig.get(key(p));
      return v !== undefined ? v : actual.readFileSync(p, enc as never);
    }) as typeof actual.readFileSync,
    writeFileSync: (p: string, data: string) => void fake.globalConfig.set(key(p), data),
    // The config write is tmp+rename now (connections review finding 7), so the
    // fake needs the rename too — otherwise the real renameSync runs against a
    // temp file that only ever existed in this Map.
    renameSync: ((from: string, to: string) => {
      const v = fake.globalConfig.get(key(from));
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      fake.globalConfig.delete(key(from));
      fake.globalConfig.set(key(to), v);
    }) as unknown as typeof actual.renameSync,
    mkdirSync: (() => {}) as unknown as typeof actual.mkdirSync,
  };
});

import { TOOLS_PANE_MESSAGE_TYPES, handleToolsPaneMessage } from '../../../src/dashboard/toolsPane';
import { toolFileName, toolTemplate } from '../../../src/dashboard/toolScaffold';
import ToolsPane from '../panes/ToolsPane.svelte';

const CATALOG = {
  tools: [
    { id: 'read', description: 'Read a file', deferred: false, disabled: false, source: 'builtin', hardRequired: false },
    {
      id: 'board_board_tickets',
      description: 'List tickets\nsecond line',
      deferred: true,
      disabled: false,
      source: 'user-file',
      location: 'C:/ws/.origami/tool/board_board_tickets.ts',
      hardRequired: false,
    },
  ],
  settings: { enabled: true, mcp: true, defer: [], always: [] },
};

const hostWith = (client?: { listTools: () => Promise<typeof CATALOG> }) => {
  const posted: Record<string, unknown>[] = [];
  return { host: { ...(client ? { client } : {}), post: (m: Record<string, unknown>) => void posted.push(m) }, posted };
};

let savedXdg: string | undefined;

beforeEach(() => {
  fake.settings = {};
  fake.updates = [];
  fake.folders = [{ uri: { fsPath: 'C:/ws' } }];
  fake.existing = new Set();
  fake.written = [];
  fake.dirs = [];
  fake.opened = [];
  fake.errors = [];
  fake.infos = [];
  fake.copied = [];
  fake.deleted = [];
  fake.deleteThrows = false;
  fake.globalConfig = new Map();
  // The config path is XDG_CONFIG_HOME-aware now (finding 5), so mocking
  // homedir alone no longer pins it: on a machine with XDG_CONFIG_HOME set,
  // the writer would aim somewhere this fake never keyed.
  savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
});
afterEach(() => {
  if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
  cleanup();
});

describe('toolsPane host — reading the catalog', () => {
  it('routes exactly the seven messages the pane sends and nothing else', () => {
    expect([...TOOLS_PANE_MESSAGE_TYPES].sort()).toEqual([
      'toolsCopyPath',
      'toolsDeleteProblem',
      'toolsOpenProblem',
      'toolsRequest',
      'toolsScaffold',
      'toolsSetCodeMode',
      'toolsSetState',
    ]);
  });

  it('posts the engine’s catalog with the live code-mode setting alongside it', async () => {
    fake.settings['experimentalCodeMode'] = true;
    const { host, posted } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    // tools carries every engine-reported entry PLUS the synthetic tool_search
    // row (see the dedicated describe block below) — asserted here as a
    // superset so this test stays about codeMode, not tool_search's shape.
    expect(posted[0]).toMatchObject({ type: 'toolsData', codeMode: true });
    expect(posted[0]!['tools']).toEqual(expect.arrayContaining(CATALOG.tools));
  });

  it('answers with a reason, not an empty pane, when no chat is open', async () => {
    const { host, posted } = hostWith();

    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    expect(posted[0]).toMatchObject({ type: 'toolsData', tools: [] });
    expect(String(posted[0]!['error'])).toContain('Open a chat first');
  });

  it('reports an engine failure as an error on the pane instead of throwing', async () => {
    const { host, posted } = hostWith({
      listTools: async () => {
        throw new Error('engine gone');
      },
    });

    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    expect(String(posted[0]!['error'])).toContain('engine gone');
  });

  // t-q41knp — `tool_search` is a tool (it is what does the deferring), but
  // the engine never registers it (session/tools.ts synthesizes it per-turn),
  // so `GET /experimental/tool` never lists it. Without this row the pane
  // silently contradicted its own note text, which already names it.
  it('includes a synthetic tool_search row — the engine never registers the tool that does the deferring', async () => {
    const { host, posted } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    const ts = (posted[0]!['tools'] as Array<Record<string, unknown>>).find((t) => t.id === 'tool_search');
    expect(ts, 'tool_search row missing from the catalog').toBeDefined();
    expect(ts).toMatchObject({ deferred: false, disabled: false, hardRequired: true, source: 'builtin' });
  });

  it('does not duplicate tool_search if the engine ever starts reporting it itself', async () => {
    const withRow = { ...CATALOG, tools: [...CATALOG.tools, { id: 'tool_search', description: 'x', deferred: false, disabled: false, source: 'builtin', hardRequired: true }] };
    const { host, posted } = hostWith({ listTools: async () => withRow });

    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    const rows = (posted[0]!['tools'] as Array<{ id: string }>).filter((t) => t.id === 'tool_search');
    expect(rows).toHaveLength(1);
  });
});

describe('toolsPane host — the code-mode toggle', () => {
  it('writes the setting, re-posts state, and says the change needs a reload', async () => {
    const { host, posted } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetCodeMode', on: true });

    expect(fake.updates).toEqual([{ key: 'experimentalCodeMode', value: true }]);
    expect(posted[0]).toMatchObject({ type: 'toolsData', codeMode: true });
    expect(fake.infos.join(' ')).toMatch(/reload/i);
  });

  it('treats anything that is not an exact true as off', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetCodeMode', on: 'yes' });

    expect(fake.updates).toEqual([{ key: 'experimentalCodeMode', value: false }]);
  });
});

describe('toolsPane host — scaffolding a user tool', () => {
  it('accepts a name the engine can register, and normalises spaces and case', () => {
    expect(toolFileName('deploy')).toBe('deploy');
    expect(toolFileName('  My Tool ')).toBe('my_tool');
    expect(toolFileName('read-notes')).toBe('read_notes');
  });

  it('refuses a name that would escape the tool directory or that no model could call', () => {
    for (const bad of ['../evil', 'a/b', '2fast', '', '.', 'x'.repeat(41), 42, null]) {
      expect(toolFileName(bad)).toBeNull();
    }
  });

  it('writes the template into .origami/tool, opens it, and copies its path', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsScaffold', name: 'Deploy Thing' });

    expect(fake.written).toHaveLength(1);
    expect(fake.written[0]!.path).toBe('C:/ws/.origami/tool/deploy_thing.ts');
    // THE FILE MUST BE LOADABLE AS WRITTEN. It used to open with
    // `import { tool } from "@origami/plugin"`, a package that is never
    // resolvable from a workspace .origami folder (it is unpublished, so the
    // engine's background install of it 404s) — and the throw that caused took
    // down every prompt in the workspace, not just the tool. So the assertion
    // is on the PROPERTY, not the prose: no import statement at all.
    expect(fake.written[0]!.text).not.toMatch(/^\s*import\s/m);
    expect(fake.written[0]!.text).toContain('export default {');
    expect(fake.written[0]!.text).toContain('description:');
    expect(fake.written[0]!.text).toContain('async execute(');
    expect(fake.opened).toHaveLength(1);
    // Honest create (t-kgtaac round 3): scaffold + open + copy IS the feature.
    expect(fake.copied).toEqual(['C:/ws/.origami/tool/deploy_thing.ts']);
  });

  it('opens an existing tool of that name instead of overwriting it', async () => {
    fake.existing.add('C:/ws/.origami/tool/deploy.ts');
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsScaffold', name: 'deploy' });

    expect(fake.written).toHaveLength(0);
    expect(fake.opened).toHaveLength(1);
  });

  it('refuses a bad name with a message and writes nothing at all', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsScaffold', name: '../../etc/passwd' });

    expect(fake.written).toEqual([]);
    expect(fake.errors).toHaveLength(1);
  });

  it('names the tool after the file in the template it writes', () => {
    expect(toolTemplate('deploy')).toContain('"deploy"');
  });
});

// `tool_search`, NOT `invalid`. The engine no longer lists repair-only tools
// at all (engine/src/acp/tools.ts drops SessionPromptCapture.REPAIR_ONLY_TOOLS),
// so the synthetic tool_search row the shell appends is the only hardRequired
// row that can exist — keeping `invalid` here would go on testing a card the
// user is never shown.
const HARD_REQUIRED_CATALOG = {
  tools: [
    ...CATALOG.tools,
    { id: 'tool_search', description: 'Loads a deferred schema', deferred: false, disabled: false, source: 'builtin', hardRequired: true },
  ],
  settings: CATALOG.settings,
};

describe('toolsPane host — the Loaded / Deferred / Off control', () => {
  const CFG = 'C:/fakehome/.config/origami/origami.json';
  const cfg = () => JSON.parse(fake.globalConfig.get(CFG)!);

  it('writes the tool id into the GLOBAL origami.json defer list, and back out on deferred -> loaded', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'deferred' });

    expect(cfg().experimental.tool_search.defer).toEqual(['read']);
    expect(cfg().experimental.tool_search.always).toEqual([]);
    expect(fake.infos.join(' ')).toMatch(/reload/i);

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'loaded' });

    // Mutually exclusive: flipping to "load" removes it from defer and adds
    // it to always, never leaves it in both.
    expect(cfg().experimental.tool_search.defer).toEqual([]);
    expect(cfg().experimental.tool_search.always).toEqual(['read']);
  });

  it('OFF writes `tools: { id: false }` and clears BOTH tool_search lists', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'deferred' });
    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'off' });

    expect(cfg().tools).toEqual({ read: false });
    // The presentation lists must not keep an opinion about a tool that is not
    // offered — a leftover `defer` entry would pick the state for the user the
    // next time they switch it back on.
    expect(cfg().experimental.tool_search.defer).toEqual([]);
    expect(cfg().experimental.tool_search.always).toEqual([]);
    expect(fake.infos.join(' ')).toMatch(/not be offered to the model/i);
  });

  it('OFF is reversible, and leaves no `false` behind when it is reversed', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'off' });
    expect(cfg().tools).toEqual({ read: false });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'loaded' });
    // ON is the ABSENCE of the key, not `true`: the `tools` block disappears
    // once nothing is switched off, so a hand-editable file does not silt up
    // with a record of every tool anyone ever clicked.
    expect(cfg().tools).toBeUndefined();
    expect(cfg().experimental.tool_search.always).toEqual(['read']);
  });

  it('switching one tool off leaves another one off', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'off' });
    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'board_board_tickets', state: 'off' });
    expect(cfg().tools).toEqual({ read: false, board_board_tickets: false });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'loaded' });
    expect(cfg().tools).toEqual({ board_board_tickets: false });
  });

  it('a state the webview invented is never written', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    for (const bad of ['unloaded', true, 1, null, undefined, 'OFF']) {
      await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: bad });
    }
    // Nothing was written at all — not even a harmless one. `off` is not
    // guessable and the cost of guessing it is a tool that silently stops being
    // offered, so an unrecognised value is refused rather than rounded.
    expect(fake.globalConfig.size).toBe(0);
  });

  it('preserves an unrelated key already in the global config', async () => {
    fake.globalConfig.set(CFG, JSON.stringify({ model: 'anthropic/claude' }));
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'board_board_tickets', state: 'deferred' });

    expect(cfg().model).toBe('anthropic/claude');
    expect(cfg().experimental.tool_search.defer).toEqual(['board_board_tickets']);
  });

  it('refuses to change a hard-required tool, writing nothing — including OFF', async () => {
    const { host } = hostWith({ listTools: async () => HARD_REQUIRED_CATALOG });

    for (const state of ['deferred', 'off']) {
      await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'tool_search', state });
    }

    expect(fake.globalConfig.size).toBe(0);
    expect(fake.errors.join(' ')).toContain('tool_search');
  });

  // t-q41knp — the reported bug: clicking the toggle did not visibly move.
  // The write succeeds, but a fresh `listTools()` answers from the ENGINE's
  // own cached config (no file watcher — see toolDeferConfig.ts's own note),
  // so the re-post the pane relies on to show the new state echoed the OLD
  // one straight back. `CATALOG` here is exactly that: a static reply that
  // never itself changes, the same shape the real cached engine takes — so
  // this is the regression this fake would have shown even without a real
  // engine involved.
  const lastRow = (posted: Record<string, unknown>[], id: string) =>
    (posted.at(-1)!['tools'] as Array<Record<string, unknown>>).find((t) => t.id === id);

  it('the control VISIBLY moves in the re-posted catalog, not just on disk', async () => {
    const { host, posted } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'read', state: 'deferred' });

    expect(lastRow(posted, 'read')?.deferred, 'still the STALE engine value — the control did nothing visible').toBe(true);
    // The OTHER row is untouched — this patches the one entry that changed.
    expect(lastRow(posted, 'board_board_tickets')?.deferred).toBe(true); // CATALOG's own starting value
  });

  it('an OFF write re-posts the row as off — and NOT as deferred as well', async () => {
    // The round trip the state control depends on. Both fields are rewritten,
    // never one: a row that came back `{disabled: true, deferred: true}` would
    // leave the pane to pick which of the two to believe.
    const { host, posted } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'board_board_tickets', state: 'off' });

    const row = lastRow(posted, 'board_board_tickets');
    expect(row?.disabled).toBe(true);
    expect(row?.deferred, 'stale deferred left standing beside disabled').toBe(false);
  });

  it('a refused write re-posts the catalog UNCHANGED — no cosmetic flip on failure', async () => {
    const { host, posted } = hostWith({ listTools: async () => HARD_REQUIRED_CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetState', id: 'tool_search', state: 'off' });

    const row = lastRow(posted, 'tool_search');
    expect(row?.deferred).toBe(false);
    expect(row?.disabled).toBe(false);
  });
});

describe('toolsPane host — copy path', () => {
  it('copies a user-file tool location, resolved from a FRESH catalog read, not the message', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    // A compromised/stale webview naming a path that isn't this tool's real
    // location must not matter — only the id crosses, the host resolves
    // location itself.
    await handleToolsPaneMessage(host, { type: 'toolsCopyPath', id: 'board_board_tickets', location: '/evil/path' });

    expect(fake.copied).toEqual(['C:/ws/.origami/tool/board_board_tickets.ts']);
  });

  it('does nothing for a tool with no location', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsCopyPath', id: 'read' });

    expect(fake.copied).toEqual([]);
  });
});

describe('ToolsPane — each of the three states reads differently from the others', () => {
  /** One card's segmented control, by state name. */
  const seg = (card: Element, state: string) =>
    card.querySelector(`.ts3-seg.${state}`) as HTMLButtonElement;
  /** Which segment is currently ON — the single source the card renders from. */
  const activeSeg = (card: Element) =>
    (card.querySelector('.ts3-seg.on') as HTMLButtonElement | null)?.textContent?.trim();
  const deliver = (payload: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolsData', ...payload } }));

  it('asks the host for the catalog as soon as it mounts', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(ToolsPane);
    await tick();

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('toolsRequest');
  });

  it('badges each card with its state and counts both in the header', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const cards = Array.from(container.querySelectorAll('.tool-card'));
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('.tl-badge')!.textContent).toBe('loaded');
    expect(cards[1]!.querySelector('.tl-badge')!.textContent).toBe('deferred');
    expect(cards[1]!.classList.contains('deferred')).toBe(true);
    expect(cards[0]!.classList.contains('deferred')).toBe(false);
    const totals = container.querySelector('.tl-totals')!.textContent!;
    expect(totals).toContain('1 loaded');
    expect(totals).toContain('1 deferred');
    expect(totals).toContain('0 off');
  });

  it('badges an OFF tool distinctly — not as deferred — and counts it apart', async () => {
    // The round-trip guard: a tool the host reports as disabled must render as
    // OFF, never fall back to the loaded/deferred pair. The `deferred: true`
    // here is deliberate — it is exactly what a stale engine verdict looks
    // like beside a fresh `disabled`, and OFF has to win.
    const { container } = render(ToolsPane);
    await tick();
    deliver({
      tools: [
        { ...CATALOG.tools[0], disabled: true },
        { ...CATALOG.tools[1], deferred: true, disabled: true },
      ],
      settings: CATALOG.settings,
      codeMode: false,
    });
    await tick();

    const cards = Array.from(container.querySelectorAll('.tool-card'));
    expect(cards.map((c) => c.querySelector('.tl-badge')!.textContent)).toEqual(['off', 'off']);
    expect(cards.map((c) => activeSeg(c))).toEqual(['Off', 'Off']);
    // Off is its own look, not a heavier "deferred".
    expect(cards[0]!.classList.contains('off')).toBe(true);
    expect(cards[0]!.classList.contains('deferred')).toBe(false);
    const totals = container.querySelector('.tl-totals')!.textContent!;
    expect(totals).toContain('2 off');
    expect(totals).toContain('0 deferred');
    expect(totals).toContain('0 loaded');
  });

  it('draws all three states at once, so the current one is legible at a glance', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({
      tools: [
        { ...CATALOG.tools[0], id: 'a', deferred: false, disabled: false },
        { ...CATALOG.tools[0], id: 'b', deferred: true, disabled: false },
        { ...CATALOG.tools[0], id: 'c', deferred: false, disabled: true },
      ],
      settings: CATALOG.settings,
      codeMode: false,
    });
    await tick();

    const cards = Array.from(container.querySelectorAll('.tool-card'));
    // Every card offers all three options — that is the difference from a
    // toggle, which shows what a tool IS but not what else it could be.
    for (const card of cards) {
      expect(Array.from(card.querySelectorAll('.ts3-seg')).map((s) => s.textContent!.trim()))
        .toEqual(['Loaded', 'Deferred', 'Off']);
      expect(card.querySelectorAll('.ts3-seg.on')).toHaveLength(1);
    }
    expect(cards.map((c) => activeSeg(c))).toEqual(['Loaded', 'Deferred', 'Off']);
    // aria mirrors the fill, so the state is not carried by colour alone.
    expect(seg(cards[2]!, 'off').getAttribute('aria-checked')).toBe('true');
    expect(seg(cards[2]!, 'loaded').getAttribute('aria-checked')).toBe('false');
  });

  it('shows only the first line of a multi-line description', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const descriptions = Array.from(container.querySelectorAll('.tool-desc')).map((n) => n.textContent);
    expect(descriptions).toEqual(['Read a file', 'List tickets']);
  });

  it('shows the source badge on each card', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const sources = Array.from(container.querySelectorAll('.tool-source')).map((n) => n.textContent);
    expect(sources).toEqual(['builtin', 'user file']);
  });

  it('filters cards by a name/description substring, narrowing the count', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();
    expect(container.querySelectorAll('.tool-card')).toHaveLength(2);

    const search = container.querySelector('.tl-search') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'ticket' } });
    await tick();

    const cards = Array.from(container.querySelectorAll('.tool-card'));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector('.tool-name')!.textContent).toBe('board_board_tickets');
    expect(container.querySelector('.tl-count')!.textContent).toBe('1/2');
  });

  it('matches on id as well as description, case-insensitively', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const search = container.querySelector('.tl-search') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'READ' } });
    await tick();

    expect(Array.from(container.querySelectorAll('.tool-name')).map((n) => n.textContent)).toEqual(['read']);
  });

  it('shows a copy-path button only for a user-file tool with a location, and wires it to the host', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const cards = Array.from(container.querySelectorAll('.tool-card'));
    expect(cards[0]!.querySelector('.tool-copy')).toBeNull(); // read: builtin, no location
    const copyBtn = cards[1]!.querySelector('.tool-copy') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull(); // board_board_tickets: user-file

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(copyBtn);

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'toolsCopyPath',
      id: 'board_board_tickets',
    });
  });

  it('asks the host for the state that was CLICKED, not for a flip of the current one', async () => {
    // The control names its target outright. A toggle sends "the other one",
    // which with three states is ambiguous, and off a stale render can send
    // the opposite of what the user pressed.
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const readCard = Array.from(container.querySelectorAll('.tool-card'))[0]!;
    expect(activeSeg(readCard)).toBe('Loaded');

    for (const state of ['deferred', 'off', 'loaded']) {
      globalThis.__vscodeApiMock.postMessage.mockClear();
      await fireEvent.click(seg(readCard, state));
      if (state === 'loaded') {
        // Already Loaded: clicking the segment it is already on is a no-op
        // rather than a redundant write plus a reload nag.
        expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
      } else {
        expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
          type: 'toolsSetState',
          id: 'read',
          state,
        });
      }
    }
  });

  it('OFF is reversible from the same control', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: [{ ...CATALOG.tools[0], disabled: true }], settings: CATALOG.settings, codeMode: false });
    await tick();

    const card = container.querySelector('.tool-card')!;
    expect(activeSeg(card)).toBe('Off');

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(seg(card, 'loaded'));

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'toolsSetState',
      id: 'read',
      state: 'loaded',
    });
  });

  it('renders the tool_search card, loaded and disabled, with its own tooltip', async () => {
    // Mirrors withToolSearchRow's own shape (toolSearchRow.ts) — the host
    // seam that produces it is covered separately above; this only proves
    // the CLIENT renders that shape correctly once told about it.
    const withToolSearch = [...CATALOG.tools, { id: 'tool_search', description: 'x', deferred: false, disabled: false, source: 'builtin', hardRequired: true }];
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: withToolSearch, settings: CATALOG.settings, codeMode: false });
    await tick();

    const card = Array.from(container.querySelectorAll('.tool-card')).find(
      (c) => c.querySelector('.tool-name')!.textContent === 'tool_search',
    )!;
    expect(card, 'tool_search card missing').toBeDefined();
    expect(card.querySelector('.tl-badge')!.textContent).toBe('loaded');
    // Every segment is inert, not just the two it is not on — there is no
    // state to move it to.
    const segs = Array.from(card.querySelectorAll('.ts3-seg')) as HTMLButtonElement[];
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.disabled)).toBe(true);
    expect(segs[0]!.title).toContain('no state to set');
  });

  it('disables every segment for a hard-required tool and posts nothing when clicked', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: HARD_REQUIRED_CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const card = Array.from(container.querySelectorAll('.tool-card')).find(
      (c) => c.querySelector('.tool-name')!.textContent === 'tool_search',
    )!;
    globalThis.__vscodeApiMock.postMessage.mockClear();
    for (const state of ['loaded', 'deferred', 'off']) {
      await fireEvent.click(seg(card, state));
    }

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'toolsSetState' }),
    );
  });

  it('reflects the code-mode setting on the switch and asks the host to flip it', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: [], settings: CATALOG.settings, codeMode: true });
    await tick();
    const sw = container.querySelector('.tl-switch') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(sw);

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'toolsSetCodeMode', on: false });
  });

  it('says plainly when the deferred catalog is switched off entirely', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: { ...CATALOG.settings, enabled: false }, codeMode: false });
    await tick();

    expect(container.querySelector('.tl-off')).not.toBeNull();
  });

  // Owner ruling: new-tool creation sits directly below the code-mode card —
  // the two settings a session starts from, ahead of the (potentially long)
  // tool list a user has to scroll past otherwise.
  it('renders the new-tool box directly below the code-mode card, ahead of the tool list', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false });
    await tick();

    const scroll = container.querySelector('.tl-scroll')!;
    const children = Array.from(scroll.children);
    const codeModeIdx = children.findIndex((c) => c.classList.contains('tl-card'));
    const newToolIdx = children.findIndex((c) => c.classList.contains('tl-new'));
    const gridIdx = children.findIndex((c) => c.classList.contains('tools-grid'));
    expect(codeModeIdx, 'code-mode card missing').toBeGreaterThanOrEqual(0);
    expect(newToolIdx, 'new-tool box missing').toBeGreaterThanOrEqual(0);
    expect(gridIdx, 'tools grid missing').toBeGreaterThanOrEqual(0);
    expect(newToolIdx).toBe(codeModeIdx + 1);
    expect(newToolIdx).toBeLessThan(gridIdx);
  });

  it('sends a NAME and never a path when scaffolding, and refuses to send an empty one', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: [], settings: CATALOG.settings, codeMode: false });
    await tick();
    const input = container.querySelector('.tl-new-input') as HTMLInputElement;
    const go = container.querySelector('.tl-new-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);

    await fireEvent.input(input, { target: { value: 'deploy' } });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(go);

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'toolsScaffold', name: 'deploy' });
  });
});

// The `source` union is written out in full in THREE files, because
// tsconfig.webview.json pins rootDir to `webview/` and the engine is a
// different package again, so neither copy can import the other (the same rule
// SkillsPane and the five repo-map pillars already live under). Three copies of
// one list is three chances to disagree, and the failure is SILENT in the worst
// way: ToolCard's `sourceLabel()` ends in `return 'builtin'`, so a source the
// engine starts emitting and the card has never heard of does not throw or
// render blank — it renders the word "builtin", and a user-file tool quietly
// claims to be part of the engine. Hence this guard, on the acpTaskMeta.test.ts
// pattern: read all three sources and assert the sets are identical.
describe('tool source — drift guard across the three mirrors', () => {
  const SOURCES = ['builtin', 'mcp', 'user-file', 'plugin'];
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(path.resolve(here, rel), 'utf8');
  const deliverTools = (tools: unknown[]) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'toolsData', tools, settings: CATALOG.settings, codeMode: false },
      }),
    );

  // Slice out ONE named declaration, drop its comments, then read the union.
  // Both narrowing steps are load-bearing, and both were put here by a test
  // that went red without them: `source:` on its own also matches SkillEntry's
  // 'config' | 'global' | ... union further up acpExtTypes.ts, and the doc
  // comment ON the field quotes 'mcp' and 'user-file' in prose. Either one is a
  // green-looking test asserting the wrong list. A declaration that has been
  // renamed or moved THROWS rather than silently matching nothing.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const unionIn = (src: string, declaration: RegExp, what: string, field = /source\??:[^;\n]*/): string[] => {
    const block = src.match(declaration);
    if (!block) throw new Error(`${what}: declaration not found — it was renamed or moved`);
    const line = stripComments(block[0]).match(field);
    if (!line) throw new Error(`${what}: no source union inside the declaration`);
    return [...line[0].matchAll(/['"]([a-z-]+)['"]/g)].map((m) => m[1]!).sort();
  };

  it('the engine, the ext types and the card all name the same sources', () => {
    // The engine declares it as a standalone type alias, the two client-side
    // copies as a field on their entry interface — hence the different anchors.
    const engine = unionIn(
      read('../../../../engine/src/acp/tools.ts'),
      /export type ToolSource =[^\n]*/,
      'acp/tools.ts ToolSource',
      /=[^\n]*/,
    );
    const extTypes = unionIn(
      read('../../../src/acpExtTypes.ts'),
      /interface ToolCatalogEntry \{[\s\S]*?\n\}/,
      'acpExtTypes.ts ToolCatalogEntry',
    );
    const card = unionIn(
      read('../panes/ToolCard.svelte'),
      /interface ToolCardEntry \{[\s\S]*?\n  \}/,
      'ToolCard.svelte ToolCardEntry',
    );

    expect(engine, 'acp/tools.ts ToolSource changed').toEqual([...SOURCES].sort());
    expect(extTypes, 'acpExtTypes.ts ToolCatalogEntry.source drifted from the engine').toEqual(engine);
    expect(card, 'ToolCard.svelte ToolCardEntry.source drifted from the engine').toEqual(engine);
  });

  // The SAME three-file problem the source union has, now for the state
  // FIELDS — and with a worse failure. `source` drifting renders a wrong word;
  // a state field drifting renders a wrong STATE: ToolCard computes off ->
  // deferred -> loaded in that order, so an entry whose `disabled` never
  // crossed (because one of the three declarations forgot it) reads as Loaded
  // for a tool the engine is not offering at all. That is a lie in the exact
  // direction this feature exists to prevent, and nothing throws.
  it('the engine, the ext types and the card declare the same state fields', () => {
    const boolFields = (src: string, declaration: RegExp, what: string): string[] => {
      const block = src.match(declaration);
      if (!block) throw new Error(`${what}: declaration not found — it was renamed or moved`);
      return [...stripComments(block[0]).matchAll(/(?:readonly\s+)?(\w+)\s*:\s*boolean/g)]
        .map((m) => m[1]!)
        .sort();
    };

    const engine = boolFields(
      read('../../../../engine/src/acp/tools.ts'),
      /export type ToolRow = \{[\s\S]*?\n\}/,
      'acp/tools.ts ToolRow',
    );
    const extTypes = boolFields(
      read('../../../src/acpExtTypes.ts'),
      /interface ToolCatalogEntry \{[\s\S]*?\n\}/,
      'acpExtTypes.ts ToolCatalogEntry',
    );
    const card = boolFields(
      read('../panes/ToolCard.svelte'),
      /interface ToolCardEntry \{[\s\S]*?\n  \}/,
      'ToolCard.svelte ToolCardEntry',
    );

    expect(engine, 'the engine stopped reporting one of the three state flags')
      .toEqual(['deferred', 'disabled', 'hardRequired']);
    expect(extTypes, 'acpExtTypes.ts ToolCatalogEntry drifted from the engine').toEqual(engine);
    expect(card, 'ToolCard.svelte ToolCardEntry drifted from the engine').toEqual(engine);
  });

  // ToolState is the WIRE value: the webview puts one of these strings in a
  // postMessage and the host refuses anything it does not recognise
  // (toolStateMessage.parseToolState). A rename on one side alone is therefore
  // not a type error anywhere — it is a control that silently stops working.
  it('the state union is identical on both sides of the postMessage', () => {
    const union = (src: string, what: string): string[] => {
      const line = stripComments(src).match(/export type ToolState =[^;\n]*/);
      if (!line) throw new Error(`${what}: ToolState declaration not found`);
      return [...line[0].matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).sort();
    };

    const host = union(read('../../../src/dashboard/toolDeferConfig.ts'), 'toolDeferConfig.ts');
    const view = union(read('../panes/ToolStateSwitch.svelte'), 'ToolStateSwitch.svelte');

    expect(host).toEqual(['deferred', 'loaded', 'off']);
    expect(view, 'ToolStateSwitch.svelte ToolState drifted from the host writer').toEqual(host);
  });

  it('ToolCard renders a distinct label for every source, so none can fall through to "builtin"', async () => {
    // The other direction, on the RENDERED output rather than the source text:
    // a member added to all three unions but forgotten in `sourceLabel()` still
    // reads as "builtin". Only `builtin` itself may produce that word.
    const { container } = render(ToolsPane);
    await tick();
    deliverTools(
      SOURCES.map((source, i) => ({
        id: `tool_${i}`,
        description: source,
        deferred: false,
        disabled: false,
        source,
        hardRequired: false,
      })),
    );
    await tick();

    const labels = Array.from(container.querySelectorAll('.tool-source')).map((n) => n.textContent);
    expect(labels).toHaveLength(SOURCES.length);
    expect(new Set(labels).size, `two sources render the same label: ${labels.join(', ')}`).toBe(SOURCES.length);
    // ...and the one that legitimately says "builtin" is the builtin.
    expect(labels[SOURCES.indexOf('builtin')]).toBe('builtin');
  });
});

// ── A USER TOOL FILE THAT WOULD NOT LOAD ───────────────────────────────────
// The incident this block exists for: the pane's own "New tool" box wrote a
// file the engine could not import, and the only feedback anywhere was every
// prompt in the workspace failing with a redacted "Origami service failure".
// The engine now skips the file and reports it; these assert the report
// survives the trip to the screen, because a contained failure nobody can see
// is still a tool the user thinks they created.
describe('toolsPane — a user tool file the engine could not load', () => {
  const BROKEN = {
    file: 'C:/ws/.origami/tool/ticket.ts',
    message: "Cannot find module '@origami/plugin'",
  };
  const withProblems = { ...CATALOG, problems: [BROKEN] };
  const deliver = (payload: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolsData', ...payload } }));

  it('passes the engine’s problems through to the webview', async () => {
    const { host, posted } = hostWith({ listTools: async () => withProblems as unknown as typeof CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    expect(posted[0]).toMatchObject({ type: 'toolsData', problems: [BROKEN] });
  });

  // The three payload shapes must agree, or the webview has to branch on which
  // one it got just to know whether `problems` is meaningful.
  it('always carries a problems array — engine silent, no session, or read failed', async () => {
    const older = hostWith({ listTools: async () => CATALOG }); // engine without the field
    const dead = hostWith({ listTools: async () => { throw new Error('engine gone'); } });
    const none = hostWith(); // no chat open

    await handleToolsPaneMessage(older.host, { type: 'toolsRequest' });
    await handleToolsPaneMessage(dead.host, { type: 'toolsRequest' });
    await handleToolsPaneMessage(none.host, { type: 'toolsRequest' });

    expect(older.posted[0]!['problems']).toEqual([]);
    expect(dead.posted[0]!['problems']).toEqual([]);
    expect(none.posted[0]!['problems']).toEqual([]);
  });

  // Was `.tl-problem`, one line of muted text. The owner could not see it on
  // the real pane, so the assertion moved with the markup: all three facts —
  // the BASENAME (what the user called the tool), the full path, and the
  // engine's reason VERBATIM — have to be on the card, not just the path.
  it('names the file, its basename and the reason on the card', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN] });
    await tick();

    const card = container.querySelector('.tp-card')!;
    expect(card.querySelector('.tp-name')!.textContent).toBe('ticket.ts');
    expect(card.querySelector('.tp-path')!.textContent).toBe('C:/ws/.origami/tool/ticket.ts');
    expect(card.querySelector('.tp-reason')!.textContent).toBe("Cannot find module '@origami/plugin'");
    // Not carried by the error tone alone — jsdom has no <style>, so the tone
    // itself is unassertable here and the WORDS are what this can prove.
    expect(card.querySelector('.tp-tag')!.textContent).toContain('not loaded');
  });

  // The card started as one line of muted text, then became a page-wide banner
  // ABOVE the pane's own boxes — which read as pane chrome rather than as one
  // of the things being listed. It now sits WITH the tool cards, first in the
  // grid, so it is read as "this tool, and it is broken".
  it('sits at the TOP OF THE GRID, with the tool cards — not above the pane', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN] });
    await tick();

    const grid = container.querySelector('.tools-grid')!;
    const problem = container.querySelector('.tp-card')!;
    expect(problem.parentElement, 'the card is not in the grid').toBe(grid);
    expect(grid.children[0]).toBe(problem);
    // ...and it is no longer a direct child of the scroller, where it sat above
    // the code-mode card and the New tool box.
    expect(Array.from(container.querySelector('.tl-scroll')!.children).includes(problem)).toBe(false);
  });

  // Placement must not cost the card its independence: a broken tool file is
  // most worth seeing exactly when the catalog itself came back empty.
  it('still draws the card when the engine reported NO tools at all', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: [], settings: CATALOG.settings, codeMode: false, problems: [BROKEN] });
    await tick();

    expect(container.querySelectorAll('.tp-card')).toHaveLength(1);
    expect(container.querySelectorAll('.tool-card')).toHaveLength(0);
    expect(container.querySelector('.tl-empty')!.textContent).toContain('no tools');
  });

  it('renders one card per failed file, each naming its own reason', async () => {
    const second = { file: 'C:/ws/.origami/tool/deploy.ts', message: 'boom at module init' };
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN, second] });
    await tick();

    const cards = Array.from(container.querySelectorAll('.tp-card'));
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.querySelector('.tp-name')!.textContent)).toEqual(['ticket.ts', 'deploy.ts']);
    expect(cards[1]!.querySelector('.tp-reason')!.textContent).toBe('boom at module init');
  });

  // The whole point of containing the failure: the healthy tools are still
  // there. A problems list that replaced the grid would be the same outage
  // with better wording.
  it('shows the healthy tools alongside the problem, not instead of it', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN] });
    await tick();

    expect(container.querySelectorAll('.tp-card')).toHaveLength(1);
    expect(container.querySelectorAll('.tool-card').length).toBeGreaterThan(0);
  });

  it('renders no problem card when every tool loaded', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [] });
    await tick();

    expect(container.querySelectorAll('.tp-card')).toHaveLength(0);
  });

  it('Open posts the file the card is showing', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN] });
    await tick();

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('.tp-open') as HTMLButtonElement);

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'toolsOpenProblem',
      file: BROKEN.file,
    });
  });

  // Delete is the one control on this pane that removes a file, so the first
  // click must be inert. A confirm that posts on the way to asking would be no
  // confirm at all.
  it('Delete asks first and posts NOTHING until the confirm is clicked', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN] });
    await tick();

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('.tp-delete') as HTMLButtonElement);
    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
    expect(container.querySelector('.tp-confirm'), 'confirm button never appeared').not.toBeNull();

    await fireEvent.click(container.querySelector('.tp-confirm') as HTMLButtonElement);
    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'toolsDeleteProblem',
      file: BROKEN.file,
    });
  });

  it('Cancel abandons the delete and posts nothing', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN] });
    await tick();

    await fireEvent.click(container.querySelector('.tp-delete') as HTMLButtonElement);
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(container.querySelector('.tp-cancel') as HTMLButtonElement);

    expect(globalThis.__vscodeApiMock.postMessage).not.toHaveBeenCalled();
    // ...and the card is back to offering Delete, not stuck mid-confirm.
    expect(container.querySelector('.tp-delete')).not.toBeNull();
    expect(container.querySelector('.tp-confirm')).toBeNull();
  });

  // Only ONE card can be mid-confirm (MCPPane's `confirming` is a single
  // name). Arming the second must disarm the first, or a stray click on a
  // still-armed card deletes a file the user stopped thinking about.
  it('arming a second card disarms the first', async () => {
    const second = { file: 'C:/ws/.origami/tool/deploy.ts', message: 'boom' };
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, problems: [BROKEN, second] });
    await tick();

    const deleteButtons = () => Array.from(container.querySelectorAll('.tp-delete')) as HTMLButtonElement[];
    await fireEvent.click(deleteButtons()[0]!);
    expect(container.querySelectorAll('.tp-confirm')).toHaveLength(1);
    await fireEvent.click(deleteButtons()[0]!); // the SECOND card's Delete — the first is now a confirm
    expect(container.querySelectorAll('.tp-confirm')).toHaveLength(1);
  });
});

// ── THE DELETE, HOST SIDE ──────────────────────────────────────────────────
// Every other write on this pane takes a tool ID and resolves the path itself,
// because a path from a webview is not a fact. These two cannot: a file that
// produced no tool has no id, so the PATH is the identity. The safety property
// that replaces the id lookup is asserted first and hardest — the host acts on
// a path only while the ENGINE is still naming it as a failed tool file.
describe('toolsPane host — opening and deleting a failed tool file', () => {
  const BROKEN = { file: 'C:/ws/.origami/tool/ticket.ts', message: "Cannot find module '@origami/plugin'" };
  const withProblems = { ...CATALOG, problems: [BROKEN] };
  const hostWithProblem = () => hostWith({ listTools: async () => withProblems as unknown as typeof CATALOG });

  it('opens the reported file in an editor tab', async () => {
    const { host } = hostWithProblem();

    await handleToolsPaneMessage(host, { type: 'toolsOpenProblem', file: BROKEN.file });

    expect(fake.opened).toEqual([BROKEN.file]);
    expect(fake.deleted).toEqual([]);
  });

  it('deletes exactly the reported file, recoverably', async () => {
    const { host } = hostWithProblem();

    await handleToolsPaneMessage(host, { type: 'toolsDeleteProblem', file: BROKEN.file });

    // useTrash, not a straight unlink: this is the user's own source file and
    // the pane offers no undo of its own.
    expect(fake.deleted).toEqual([{ path: BROKEN.file, useTrash: true }]);
    expect(fake.errors).toEqual([]);
  });

  // THE SAFETY PROPERTY. RED-PROVEN: with the `payloadProblems(...).some(...)`
  // guard short-circuited in toolProblemActions.ts, this test fails with
  //   AssertionError: the host deleted a path the engine never reported:
  //   expected [ { …(2) } ] to deeply equal []
  // — the host unlinked a file the engine had never mentioned, named only by
  // the webview. That is the whole bug this guard exists to stop. The OPEN
  // case below went red in the same run (expected [ 'C:/ws/.env' ] …), which
  // is why both directions are asserted and not just the destructive one.
  it('refuses a path the engine never reported — the webview cannot aim the delete', async () => {
    const { host, posted } = hostWithProblem();

    await handleToolsPaneMessage(host, { type: 'toolsDeleteProblem', file: 'C:/ws/src/extension.ts' });

    expect(fake.deleted, 'the host deleted a path the engine never reported').toEqual([]);
    expect(fake.errors.join(' ')).toContain('not a tool file the engine reported');
    // Refused out loud AND re-posted unchanged — a silent no-op here reads
    // exactly like a delete that worked.
    expect(posted.at(-1)!['problems']).toEqual([BROKEN]);
  });

  it('refuses to OPEN a path the engine never reported either', async () => {
    const { host } = hostWithProblem();

    await handleToolsPaneMessage(host, { type: 'toolsOpenProblem', file: 'C:/ws/.env' });

    expect(fake.opened).toEqual([]);
    expect(fake.errors.join(' ')).toContain('not a tool file the engine reported');
  });

  it('refuses a path that is not a string at all, and says nothing about it', async () => {
    const { host, posted } = hostWithProblem();

    for (const bad of [undefined, null, 42, {}, '']) {
      await handleToolsPaneMessage(host, { type: 'toolsDeleteProblem', file: bad });
    }

    expect(fake.deleted).toEqual([]);
    // A garbled message is dropped, not reported — there is no path to name.
    expect(fake.errors).toEqual([]);
    expect(posted).toEqual([]);
  });

  // The engine scans tool files once per instance and answers from that cache
  // (registry.ts's InstanceState, no file watcher), so the immediate re-read
  // still names the file just deleted and the card would spring back. Same
  // patch patchToolStatePayload applies after a state write.
  it('patches the confirmed delete onto the re-posted payload, and says a reload finishes it', async () => {
    const { host, posted } = hostWithProblem();

    await handleToolsPaneMessage(host, { type: 'toolsDeleteProblem', file: BROKEN.file });

    expect(posted.at(-1)!['problems'], 'the STALE engine list came straight back').toEqual([]);
    // The tools themselves are untouched — this patches one list, not the payload.
    expect(posted.at(-1)!['tools']).toEqual(expect.arrayContaining(CATALOG.tools));
    expect(fake.infos.join(' ')).toMatch(/reload the window|new session/i);
  });

  it('leaves the OTHER failed files on screen when one is deleted', async () => {
    const second = { file: 'C:/ws/.origami/tool/deploy.ts', message: 'boom' };
    const both = { ...CATALOG, problems: [BROKEN, second] };
    const { host, posted } = hostWith({ listTools: async () => both as unknown as typeof CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsDeleteProblem', file: BROKEN.file });

    expect(posted.at(-1)!['problems']).toEqual([second]);
  });

  it('a failed delete reports the reason and patches nothing', async () => {
    fake.deleteThrows = true;
    const { host, posted } = hostWithProblem();

    await handleToolsPaneMessage(host, { type: 'toolsDeleteProblem', file: BROKEN.file });

    expect(fake.errors.join(' ')).toContain('EPERM');
    // The file is still there, so the card must be too — patching on a failed
    // write would hide a problem the engine is still correctly reporting.
    expect(posted.at(-1)!['problems']).toEqual([BROKEN]);
    expect(fake.infos).toEqual([]);
  });

  it('does nothing at all when no chat is open — there is no engine list to check against', async () => {
    const { host, posted } = hostWith(); // no client

    await handleToolsPaneMessage(host, { type: 'toolsDeleteProblem', file: BROKEN.file });

    expect(fake.deleted).toEqual([]);
    expect(String(posted.at(-1)!['error'])).toContain('Open a chat first');
  });
});
