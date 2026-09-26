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
import {
  patchSubagentStatePayload,
  isAgentName,
  writeSubagentToolState,
  __resetPendingSubagentOverridesForTests,
} from '../../../src/dashboard/subagentToolConfig';
import { resetSubagentToolDefaults } from '../../../src/dashboard/subagentToolReset';
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
  // pendingOverrides is module state by design (see its comment) — it has to outlive one
  // catalogPayload() call so a second cell's write cannot cost the first its patch, which means it
  // also outlives one `it()` block unless cleared here.
  __resetPendingSubagentOverridesForTests();
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
  it('routes exactly the eleven messages the pane sends and nothing else', () => {
    expect([...TOOLS_PANE_MESSAGE_TYPES].sort()).toEqual([
      'toolsCopyPath',
      'toolsDeleteProblem',
      'toolsOpenProblem',
      'toolsRequest',
      'toolsResetSubagentDefaults',
      'toolsScaffold',
      'toolsSetCodeMode',
      'toolsSetState',
      'toolsSetSubagentColumn',
      'toolsSetSubagentRow',
      'toolsSetSubagentState',
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

  // t-fdv45j — the catalog read is a pure pass-through of whatever the engine
  // reports, so once ORIGAMI_EXPERIMENTAL_SIDE_QUESTS reaches the engine spawn
  // (engineEnv.test.ts) and a fresh chat registers the tool, this pane has to
  // show the row with no filtering of its own in the way.
  it('lists side_quest once the engine catalog reports it, with a fresh chat', async () => {
    const withSideQuest = {
      ...CATALOG,
      tools: [...CATALOG.tools, { id: 'side_quest', description: 'Raise a side quest', deferred: false, disabled: false, source: 'builtin', hardRequired: false }],
    };
    const { host, posted } = hostWith({ listTools: async () => withSideQuest });

    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    const row = (posted[0]!['tools'] as Array<{ id: string }>).find((t) => t.id === 'side_quest');
    expect(row, 'side_quest row missing from the Tools pane catalog').toBeDefined();
  });
});

// t-fisfs5 R14 — the whole-sheet reset against an EMPTY roster used to say
// "not reporting a sub-agent called undefined": there is no name to print when
// no column was named. A named column that is gone still names it.
describe('toolsPane host — resetting the sub-agent ledger with no roster', () => {
  it('the whole sheet against an empty roster says there are no sub-agents, not "undefined"', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await resetSubagentToolDefaults(host, undefined);

    expect(fake.errors).toHaveLength(1);
    expect(fake.errors[0]).not.toContain('undefined');
    expect(fake.errors[0]).toContain('not reporting any sub-agents');
  });

  it('a NAMED column the engine no longer reports still names that column', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await resetSubagentToolDefaults(host, 'reviewer');

    expect(fake.errors).toEqual(['The engine is not reporting a sub-agent called reviewer.']);
  });
});

describe('toolsPane host — the code-mode toggle', () => {
  // t-xtimx0, owner UAT of 0.4.178: the toast said "reload the window", and was cut at about 69
  // characters ("Code mode off — reload the window to start the engine with the new ..."). No reload
  // is needed: the warm spare is dropped at once and a new chat starts with the new value, while an
  // open chat keeps the env it was spawned with (acpClient.ts `spawnEnv ??=`).
  it('writes the setting, re-posts state, and says new chats get it and open chats keep the old value', async () => {
    const { host, posted } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetCodeMode', on: true });

    expect(fake.updates).toEqual([{ key: 'experimentalCodeMode', value: true }]);
    expect(posted[0]).toMatchObject({ type: 'toolsData', codeMode: true });
    expect(fake.infos).toEqual(['Code mode on for new chats. Open chats keep it off until closed.']);
  });

  it('says the same, the other way round, when code mode goes off', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });

    await handleToolsPaneMessage(host, { type: 'toolsSetCodeMode', on: false });

    expect(fake.infos).toEqual(['Code mode off for new chats. Open chats keep it on until closed.']);
  });

  it('fits the collapsed toast: no reload, and under the ~69 characters the owner saw before the cut', async () => {
    const { host } = hostWith({ listTools: async () => CATALOG });
    for (const on of [true, false]) await handleToolsPaneMessage(host, { type: 'toolsSetCodeMode', on });
    for (const line of fake.infos) {
      expect(line).not.toMatch(/reload/i);
      expect(line.length).toBeLessThanOrEqual(64);
    }
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

// -- The SUB-AGENT matrix (t-di2u7z) ------------------------------------------
// The per-agent half of the same view. The host side is where the risk is: a
// cell names an AGENT as well as a tool, and the agent name becomes a KEY in
// the user's origami.json — so it is validated here, and the write is resolved
// against a fresh catalog read because whether "On" needs an explicit `allow`
// depends on the state the engine reports RIGHT NOW.
describe('toolsPane host — one cell of the sub-agent matrix', () => {
  const ROWS = [
    // `general`'s real default: todowrite denied by its own definition.
    { agent: 'general', native: true, states: { read: 'loaded', todowrite: 'off', browser: 'deferred' } },
    { agent: 'orchestrator', native: false, states: { read: 'loaded', todowrite: 'loaded', browser: 'deferred' } },
  ];
  const catalog = { ...CATALOG, problems: [], subagents: ROWS };
  const hostWithAgents = () => hostWith({ listTools: async () => catalog as unknown as typeof CATALOG });
  const CONFIG = 'C:/fakehome/.config/origami/origami.json';
  const written = () => JSON.parse(fake.globalConfig.get(CONFIG) ?? '{}');

  it('OFF writes a deny under that agent alone', async () => {
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'orchestrator', id: 'read', state: 'off' });

    expect(written().agent).toEqual({ orchestrator: { permission: { read: 'deny' } } });
    expect(fake.infos.join(' ')).toContain('orchestrator');
  });

  it('ON writes an explicit allow ONLY when the engine says the cell is off', async () => {
    const { host } = hostWithAgents();

    // todowrite is OFF for general (its definition denies it), so only an
    // explicit allow can reopen it...
    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'todowrite', state: 'loaded' });
    expect(written().agent.general.permission).toEqual({ todowrite: 'allow' });
    expect(written().agent.general.tool_search).toEqual({ always: ['todowrite'] });

    // ...while a tool that is merely DEFERRED needs no permission line at all:
    // writing `allow` there would also silence an ask nobody asked about.
    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'orchestrator', id: 'browser', state: 'loaded' });
    expect(written().agent.orchestrator).toEqual({ tool_search: { always: ['browser'] } });
  });

  it('DEFERRED lands in that agent own defer list', async () => {
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'read', state: 'deferred' });

    expect(written().agent.general).toEqual({ tool_search: { defer: ['read'] } });
  });

  it('never leaves the block saying two things about one tool', () => {
    // Driven through the writer rather than the host, because each step has to
    // carry the state the PREVIOUS one produced — the faked catalog above is
    // static, and this is exactly the walk (defer -> load -> off) where a
    // write that only ADDED would leave two claims standing.
    writeSubagentToolState('general', 'read', 'deferred', 'loaded');
    expect(written().agent.general).toEqual({ tool_search: { defer: ['read'] } });

    writeSubagentToolState('general', 'read', 'loaded', 'deferred');
    expect(written().agent.general).toEqual({ tool_search: { always: ['read'] } });

    // OFF clears both lists: a stale `always` would pick the next state the day
    // the tool is switched back on.
    writeSubagentToolState('general', 'read', 'off', 'loaded');
    expect(written().agent.general).toEqual({ permission: { read: 'deny' } });

    // ...and back on from OFF needs the explicit allow, with the list beside it.
    writeSubagentToolState('general', 'read', 'loaded', 'off');
    expect(written().agent.general).toEqual({ permission: { read: 'allow' }, tool_search: { always: ['read'] } });
  });

  it('leaves another agent’s block, and the user’s own keys, untouched', () => {
    fake.globalConfig.set(CONFIG, JSON.stringify({
      agent: { general: { model: 'anthropic/x', permission: { bash: 'deny' } }, explore: { permission: { read: 'deny' } } },
    }));

    writeSubagentToolState('general', 'read', 'off', 'loaded');

    expect(written().agent).toEqual({
      general: { model: 'anthropic/x', permission: { bash: 'deny', read: 'deny' } },
      explore: { permission: { read: 'deny' } },
    });
  });

  it('cleans the block away again when every toggle is back at its default', async () => {
    const { host } = hostWithAgents();
    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'orchestrator', id: 'read', state: 'off' });
    expect(written().agent).toBeTruthy();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'orchestrator', id: 'read', state: 'loaded' });

    // The engine's rows still say `read` is Loaded for that agent, so clicking Loaded
    // needs no override at all — and a block with nothing left in it is removed
    // rather than left as an empty object.
    expect(written().agent).toBeUndefined();
  });

  it('refuses an agent the engine is not reporting, and writes nothing', async () => {
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'ghost', id: 'read', state: 'off' });

    expect(fake.globalConfig.size).toBe(0);
    expect(fake.errors.join(' ')).toContain('ghost');
  });

  it('refuses a name that could never be an agent, before it becomes a config key', async () => {
    const { host } = hostWithAgents();

    for (const agent of ['../../etc/passwd', '__proto__.x', '', 'a b']) {
      await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent, id: 'read', state: 'off' });
    }

    expect(fake.globalConfig.size).toBe(0);
    expect(isAgentName('general')).toBe(true);
    expect(isAgentName('deep-plan')).toBe(true);
    expect(isAgentName('__proto__')).toBe(false);
  });

  it('refuses a state the webview invented', async () => {
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'read', state: 'ON' });

    expect(fake.globalConfig.size).toBe(0);
  });

  it('patches the confirmed cell into the re-read payload — the engine is still cached', async () => {
    const { host, posted } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'read', state: 'off' });

    const rows = posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>;
    expect(rows.find((r) => r.agent === 'general')!.states['read']).toBe('off');
    // ...and nobody else's row moved.
    expect(rows.find((r) => r.agent === 'orchestrator')!.states['read']).toBe('loaded');
  });

  it('patchSubagentStatePayload leaves a payload with no rows alone', () => {
    expect(patchSubagentStatePayload({ type: 'toolsData' }, 'general', 'read', 'off')).toEqual({ type: 'toolsData' });
  });

  // t-dkk5jd — the OWNER's own repro: turn cell A on, click cell B, and A reverts. Each click
  // re-reads the catalog fresh, and the faked engine below always answers with the same static
  // ROWS (never picking up a config write, exactly like the real engine before a reload) — so a
  // fix that patches only the CURRENT click's cell into that stale read drops every earlier one
  // the moment a second click posts a new payload.
  it('keeps every cell change after a second, unrelated click — same agent, different tool', async () => {
    const { host, posted } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'read', state: 'off' });
    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'browser', state: 'loaded' });

    const rows = posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>;
    const general = rows.find((r) => r.agent === 'general')!;
    expect(general.states['read']).toBe('off');
    expect(general.states['browser']).toBe('loaded');
  });

  it('keeps every cell change after a second click on a DIFFERENT agent', async () => {
    const { host, posted } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'read', state: 'off' });
    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'orchestrator', id: 'browser', state: 'loaded' });

    const rows = posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>;
    expect(rows.find((r) => r.agent === 'general')!.states['read']).toBe('off');
    expect(rows.find((r) => r.agent === 'orchestrator')!.states['browser']).toBe('loaded');
  });

  it('a plain refresh (toolsRequest) after two clicks still shows both, with no reload', async () => {
    const { host, posted } = hostWithAgents();

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'read', state: 'off' });
    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'orchestrator', id: 'browser', state: 'loaded' });
    await handleToolsPaneMessage(host, { type: 'toolsRequest' });

    const rows = posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>;
    expect(rows.find((r) => r.agent === 'general')!.states['read']).toBe('off');
    expect(rows.find((r) => r.agent === 'orchestrator')!.states['browser']).toBe('loaded');
  });
});

// -- The ledger's BULK writes (t-f1j2y3) --------------------------------------
// A column and a "-> all agents" row are one message each, not a loop of cell
// messages, so the loop is here. Two things are worth a test and neither is
// visible on screen: the host resolves WHICH tools exist and what each cell is
// in RIGHT NOW from its own fresh catalog read, and it refuses to write a cell
// the nesting rule has locked even though the webview drew that cell disabled.
describe('toolsPane host — a whole column and a whole row', () => {
  const CONFIG = 'C:/fakehome/.config/origami/origami.json';
  const written = () => JSON.parse(fake.globalConfig.get(CONFIG) ?? '{}');
  const catalogOf = (tools: unknown[], subagents: unknown[]) =>
    ({ tools, settings: CATALOG.settings, problems: [], subagents }) as unknown as typeof CATALOG;
  const hostFor = (tools: unknown[], subagents: unknown[]) =>
    hostWith({ listTools: async () => catalogOf(tools, subagents) });

  const READ = CATALOG.tools[0]!;
  const TICKETS = CATALOG.tools[1]!;
  const TASK = { id: 'task', description: 'Launch a new agent', deferred: false, disabled: false, source: 'builtin', hardRequired: false };

  it('a column writes every settable tool for that agent and says so ONCE', async () => {
    const rows = [{ agent: 'orchestrator', native: false, states: { read: 'loaded', board_board_tickets: 'deferred' } }];
    const { host } = hostFor([READ, TICKETS], rows);

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentColumn', agent: 'orchestrator', state: 'off' });

    expect(written().agent).toEqual({
      orchestrator: { permission: { read: 'deny', board_board_tickets: 'deny' } },
    });
    // One notice for the whole click — the reason the loop is host-side at all.
    expect(fake.infos).toHaveLength(1);
    expect(fake.infos[0]).toContain('2 cells');
  });

  it('a column SKIPS a cell the nesting rule locked, even though the click named it', async () => {
    // `task` reported off for an agent is an agent whose own definition does not
    // name it, and an allow written here would be a control that looks live and
    // is not. The webview draws that cell disabled; this is the host refusing it
    // on its own, from its own read.
    const rows = [{ agent: 'general', native: true, states: { read: 'loaded', task: 'off' } }];
    const { host } = hostFor([READ, TASK], rows);

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentColumn', agent: 'general', state: 'off' });

    expect(written().agent).toEqual({ general: { permission: { read: 'deny' } } });
  });

  it('a column that changes nothing writes nothing and says nothing was written', async () => {
    const rows = [{ agent: 'general', native: true, states: { read: 'loaded', board_board_tickets: 'loaded' } }];
    const { host } = hostFor([READ, TICKETS], rows);

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentColumn', agent: 'general', state: 'loaded' });

    expect(fake.globalConfig.get(CONFIG)).toBeUndefined();
    expect(fake.infos[0]).toContain('nothing was written');
  });

  it('the row action copies the tool OWN workspace state, read here and not sent', async () => {
    // The message carries an id and nothing else. board_board_tickets is
    // DEFERRED in the catalog, so every agent not already deferred gets it —
    // and `general`, which already is, is left alone rather than given a
    // redundant override.
    const rows = [
      { agent: 'general', native: true, states: { board_board_tickets: 'deferred' } },
      { agent: 'orchestrator', native: false, states: { board_board_tickets: 'loaded' } },
    ];
    const { host } = hostFor([READ, TICKETS], rows);

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentRow', id: 'board_board_tickets' });

    expect(written().agent).toEqual({
      orchestrator: { tool_search: { defer: ['board_board_tickets'] } },
    });
    expect(fake.infos[0]).toContain('deferred');
  });

  it('refuses a tool the fresh catalog is not reporting', async () => {
    const { host } = hostFor([READ], [{ agent: 'general', native: true, states: { read: 'loaded' } }]);

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentRow', id: 'not_a_tool' });

    expect(fake.globalConfig.get(CONFIG)).toBeUndefined();
    expect(fake.errors.join(' ')).toContain('not_a_tool');
  });

  it('refuses a single cell the nesting rule locked', async () => {
    const rows = [{ agent: 'general', native: true, states: { task: 'off' } }];
    const { host } = hostFor([TASK], rows);

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'general', id: 'task', state: 'loaded' });

    expect(fake.globalConfig.get(CONFIG)).toBeUndefined();
    expect(fake.errors.join(' ')).toContain('task');
  });
});

// -- The SUB-AGENT LEDGER as it renders (t-f1j2y3) ----------------------------
// The view the owner picked, replacing the bolted-on table. What is asserted is
// structure and text: which columns exist and in what order, that the legend is
// INSIDE the sticky header row rather than in a footer, that a description
// carries the clamp class and the full text in its title, and that a locked
// cell is really disabled. jsdom has no layout and no <style>, so the clamp
// itself — like the grid before it — needs a human eye; the class is what can
// honestly be asserted here.
describe('toolsPane host — Reset to defaults (t-f3a74m)', () => {
  const CONFIG = 'C:/fakehome/.config/origami/origami.json';
  const written = () => JSON.parse(fake.globalConfig.get(CONFIG) ?? '{}');
  const ROWS = [
    { agent: 'architect', native: false, states: { read: 'loaded' } },
    { agent: 'scout', native: false, states: { read: 'loaded' } },
  ];
  const catalog = { ...CATALOG, problems: [], subagents: ROWS } as unknown as typeof CATALOG;
  const hostWithAgents = () => hostWith({ listTools: async () => catalog });
  const reset = (agent?: string) => ({
    type: 'toolsResetSubagentDefaults',
    ...(agent === undefined ? {} : { agent }),
  });

  it('removes the keys the ledger wrote for ONE agent and leaves every other key standing', async () => {
    // The whole point of a reset: what the sheet put in goes, and what the user
    // put in by hand stays. A path-scoped OBJECT is never a shape this ledger
    // writes, so removing one would silently widen an agent they narrowed.
    fake.globalConfig.set(CONFIG, JSON.stringify({
      model: 'anthropic/x',
      agent: {
        architect: {
          model: 'anthropic/y',
          prompt: 'mine',
          permission: { read: 'deny', bash: 'allow', edit: { '*': 'deny', '*.md': 'allow' } },
          tool_search: { defer: ['skill'], always: ['browser'] },
        },
        scout: { permission: { read: 'deny' } },
      },
    }));
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, reset('architect'));

    expect(written().agent.architect).toEqual({
      model: 'anthropic/y',
      prompt: 'mine',
      permission: { edit: { '*': 'deny', '*.md': 'allow' } },
    });
    expect(written().agent.scout).toEqual({ permission: { read: 'deny' } }); // another column, untouched
    expect(written().model).toBe('anthropic/x'); // and nothing outside `agent`
    expect(fake.infos.join(' ')).toContain('architect');
  });

  it('removes the whole agent block when the ledger wrote everything in it', async () => {
    fake.globalConfig.set(CONFIG, JSON.stringify({
      agent: { architect: { permission: { read: 'deny' }, tool_search: { defer: ['lsp'] } } },
    }));
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, reset('architect'));

    // An `agent: {}` left behind is wreckage in a file people hand-edit — the
    // same pruning a single cell write does when it goes back to its default.
    expect(written().agent).toBeUndefined();
  });

  it('with no agent named, resets EVERY agent the engine reports, in one notice', async () => {
    fake.globalConfig.set(CONFIG, JSON.stringify({
      agent: {
        architect: { permission: { read: 'deny' } },
        scout: { tool_search: { defer: ['read'] } },
        // Not a row the engine reported, so the sheet has no column for it and
        // "reset the sheet" must not reach it.
        general: { permission: { todowrite: 'allow' } },
      },
    }));
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, reset());

    expect(written().agent).toEqual({ general: { permission: { todowrite: 'allow' } } });
    expect(fake.infos).toHaveLength(1);
    expect(fake.infos[0]).toContain('2 overrides removed');
  });

  it('says so out loud when there was nothing to remove, and writes no file', async () => {
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, reset('architect'));

    expect(fake.globalConfig.get(CONFIG)).toBeUndefined();
    expect(fake.infos[0]).toContain('already on the shipped defaults');
  });

  it('refuses an agent the engine is not reporting, and re-posts the catalog unchanged', async () => {
    fake.globalConfig.set(CONFIG, JSON.stringify({ agent: { architect: { permission: { read: 'deny' } } } }));
    const { host } = hostWithAgents();

    await handleToolsPaneMessage(host, reset('nonesuch'));

    expect(fake.errors.join(' ')).toContain('nonesuch');
    expect(written().agent.architect).toEqual({ permission: { read: 'deny' } }); // nothing was removed
  });

  it('puts a cell written this session back to where the ledger found it', async () => {
    // The t-dkk5jd cache exists to show a write the engine has not caught up
    // with. Once the write is gone from the file the cell must read as it did
    // before the sheet ever touched it — which for a write made THIS session is
    // exactly the state the engine is still reporting.
    const { host, posted } = hostWithAgents();
    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'architect', id: 'read', state: 'off' });
    const masked = (posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>);
    expect(masked.find((r) => r.agent === 'architect')!.states['read']).toBe('off');

    await handleToolsPaneMessage(host, reset('architect'));

    const after = (posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>);
    expect(after.find((r) => r.agent === 'architect')!.states['read']).toBe('loaded');
  });

  // t-h8s3xg. The engine's `unavailable` reasons are what the sheet greys a
  // cell with, and they have to survive the POST boundary - the pending-override
  // mask rebuilds each row, so a spread that dropped the key would leave the
  // cell looking like an ordinary `off` the user could click.
  it('carries the engine’s unavailable reasons through to the webview', async () => {
    const reason = 'nested sub-agents need subagent_depth ≥ 2';
    const rows = [
      { agent: 'architect', native: false, states: { read: 'loaded', task: 'off' }, unavailable: { task: reason } },
    ];
    const { host, posted } = hostWith({
      listTools: async () => ({ ...CATALOG, problems: [], subagents: rows }) as unknown as typeof CATALOG,
    });

    await handleToolsPaneMessage(host, { type: 'toolsSetSubagentState', agent: 'architect', id: 'read', state: 'off' });

    const sent = posted.at(-1)!['subagents'] as Array<{ agent: string; unavailable?: Record<string, string> }>;
    expect(sent.find((r) => r.agent === 'architect')!.unavailable).toEqual({ task: reason });
  });

  // t-fiszlv R13. THE CASE NO MASK COVERED: an override that was already in
  // origami.json when the engine started. Its agent registry is a snapshot, so
  // the `permission` half of its answer keeps voting for the rule the reset has
  // just deleted — and with the mask dropped the sheet redrew, as the engine's
  // own truth, the very override the click removed. The toast says reload; until
  // then the sheet must show the reset value.
  it('holds a reset cell at its new value while the engine still reports the old override', async () => {
    fake.globalConfig.set(CONFIG, JSON.stringify({
      agent: { architect: { permission: { read: 'deny' }, tool_search: { always: ['board_board_tickets'] } } },
    }));
    // The STALE engine: `read` reads off for architect before AND after the reset, because its
    // registry will not be rebuilt until the window reloads.
    const stale = {
      ...CATALOG,
      problems: [],
      subagents: [{ agent: 'architect', native: false, states: { read: 'off', board_board_tickets: 'loaded' } }],
    } as unknown as typeof CATALOG;
    const { host, posted } = hostWith({ listTools: async () => stale });

    await handleToolsPaneMessage(host, reset('architect'));

    const after = (posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>);
    // `read` is loaded at the workspace level, and with the deny gone that is what this agent
    // gets at the next spawn (subagentResetStates.ts).
    expect(after.find((r) => r.agent === 'architect')!.states['read']).toBe('loaded');
    // The `tool_search` half needs no mask at all: the engine reads that key live, so its answer
    // for a tool deferred at the workspace level is already the reset one.
    expect(after.find((r) => r.agent === 'architect')!.states['board_board_tickets']).toBe('loaded');
  });

  it('leaves a NATIVE archetype to the engine — its defaults are in its own ruleset, not the file', async () => {
    fake.globalConfig.set(CONFIG, JSON.stringify({ agent: { general: { permission: { read: 'deny' } } } }));
    const native = {
      ...CATALOG,
      problems: [],
      subagents: [{ agent: 'general', native: true, states: { read: 'off' } }],
    } as unknown as typeof CATALOG;
    const { host, posted } = hostWith({ listTools: async () => native });

    await handleToolsPaneMessage(host, reset('general'));

    const after = (posted.at(-1)!['subagents'] as Array<{ agent: string; states: Record<string, string> }>);
    // Answering 'loaded' here would be a guess: `general`'s own archetype can deny a tool with no
    // line of config anywhere, and nothing in this payload says whether it does.
    expect(after.find((r) => r.agent === 'general')!.states['read']).toBe('off');
  });
});

describe('ToolsPane — the sub-agent ledger', () => {
  const ROWS = [
    { agent: 'general', native: true, description: 'Multi-step work.', states: { read: 'off', board_board_tickets: 'deferred' } },
    { agent: 'orchestrator', native: false, states: { read: 'loaded', board_board_tickets: 'loaded' } },
  ];
  const deliver = (payload: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'toolsData', ...payload } }));
  // Svelte appends a per-component scope class to every styled element, so an
  // exact className never matches here — these read the class that carries the
  // meaning and ignore the rest.
  const STATES = ['loaded', 'deferred', 'off', 'locked'];
  const stateClass = (el: Element | null) => [...el!.classList].find((c) => STATES.includes(c)) ?? null;
  const kindClass = (el: Element) =>
    [...el.classList].find((c) => c.startsWith('lg-')) ?? null;
  /** Render, deliver a catalog, and switch to the Sub-agents half. */
  const show = async (payload: Record<string, unknown> = {}) => {
    const rendered = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, subagents: ROWS, ...payload });
    await tick();
    const sub = Array.from(rendered.container.querySelectorAll('.tl-seg-btn'))[1] as HTMLButtonElement;
    await fireEvent.click(sub);
    await tick();
    return rendered;
  };

  it('starts on Main agent — the ledger is not drawn until the switch is used', async () => {
    const { container } = render(ToolsPane);
    await tick();
    deliver({ tools: CATALOG.tools, settings: CATALOG.settings, codeMode: false, subagents: ROWS });
    await tick();

    const segs = Array.from(container.querySelectorAll('.tl-seg-btn'));
    expect(segs.map((s) => s.textContent!.trim().replace(/\s+/g, ' '))).toEqual(['Main agent', 'Sub-agents 2 types']);
    expect(segs[0]!.classList.contains('on')).toBe(true);
    expect(container.querySelector('.lg-table')).toBeNull();
    expect(container.querySelectorAll('.tool-card')).toHaveLength(2);

    await fireEvent.click(segs[1]!);
    await tick();
    // One pane, two halves: the cards go when the ledger comes.
    expect(container.querySelector('.lg-table')).not.toBeNull();
    expect(container.querySelectorAll('.tool-card')).toHaveLength(0);
  });

  it('runs the tools DOWN, grouped by source, with Workspace before the agents', async () => {
    const { container } = await show();

    expect(Array.from(container.querySelectorAll('thead th')).map(kindClass)).toEqual([
      'lg-tool-h',
      'lg-ws-h',
      'lg-agent-h',
      'lg-agent-h',
    ]);
    expect(Array.from(container.querySelectorAll('.lg-agent-name')).map((h) => h.textContent!.trim())).toEqual([
      'generalbuilt-in',
      'orchestrator',
    ]);
    // Group heading, then its tools — builtin before user file.
    expect(Array.from(container.querySelectorAll('tbody tr')).map((r) =>
      r.classList.contains('lg-group') ? `# ${r.textContent!.trim()}` : r.querySelector('.lg-id')!.textContent!.trim(),
    )).toEqual(['# builtin', 'read', '# user file', 'board_board_tickets']);
  });

  it('counts each agent column in its own header', async () => {
    const { container } = await show();

    expect(Array.from(container.querySelectorAll('.lg-cnt')).map((c) => c.textContent!.trim())).toEqual([
      '1 of 2 on', // general: read is off
      '2 of 2 on',
    ]);
  });

  it('pins the four-glyph legend in the header row beside Tool, not in a footer', async () => {
    const { container } = await show();

    const legend = container.querySelector('.lg-tool-h .lg-legend');
    expect(legend).not.toBeNull();
    expect(legend!.textContent!.replace(/\s+/g, ' ').trim()).toBe('Loaded Deferred Off Locked');
    // The header row is the sticky one, so the legend is sticky with it — and
    // there is exactly ONE legend on the pane, in the thead.
    expect(container.querySelectorAll('.lg-legend')).toHaveLength(1);
    expect(container.querySelector('.lg-note .lg-legend')).toBeNull();
  });

  it('cycles a cell loaded to deferred to off and names the next state first', async () => {
    const { container } = await show();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    // Row order: read (general, orchestrator) then board_board_tickets.
    const cells = Array.from(container.querySelectorAll('tbody .lg-cell:not(.lg-ws) .lg-cellbtn')) as HTMLButtonElement[];
    expect(cells[1]!.title).toContain('click for Deferred');
    await fireEvent.click(cells[1]!); // orchestrator - read, Loaded
    await fireEvent.click(cells[0]!); // general - read, Off
    await fireEvent.click(cells[2]!); // general - board_board_tickets, Deferred

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'toolsSetSubagentState', agent: 'orchestrator', id: 'read', state: 'deferred' },
      { type: 'toolsSetSubagentState', agent: 'general', id: 'read', state: 'loaded' },
      { type: 'toolsSetSubagentState', agent: 'general', id: 'board_board_tickets', state: 'off' },
    ]);
  });

  it('says each cell state in a glyph SHAPE, not a fill alone', async () => {
    const { container } = await show();

    const dots = Array.from(container.querySelectorAll('tbody .lg-cell:not(.lg-ws) .lg-dot'));
    // jsdom has no <style>, so this asserts the class the shape rules hang off.
    expect(dots.map(stateClass)).toEqual(['off', 'loaded', 'deferred', 'loaded']);
  });

  it('edits the SAME state the card pill edits from the Workspace column', async () => {
    const { container } = await show();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const ws = Array.from(container.querySelectorAll('tbody .lg-ws .lg-cellbtn')) as HTMLButtonElement[];
    // read is loaded in the catalog; board_board_tickets is deferred.
    expect(ws.map((b) => stateClass(b.querySelector('.lg-dot')))).toEqual(['loaded', 'deferred']);
    await fireEvent.click(ws[0]!);

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'toolsSetState', id: 'read', state: 'deferred' },
    ]);
  });

  it('disables a nesting-locked cell and says why in its title', async () => {
    const TASK = { id: 'task', description: 'Launch a new agent', deferred: false, disabled: false, source: 'builtin', hardRequired: false };
    const { container } = await show({
      tools: [TASK],
      subagents: [
        { agent: 'general', native: true, states: { task: 'off' } },
        { agent: 'orchestrator', native: false, states: { task: 'loaded' } },
      ],
    });
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const cells = Array.from(container.querySelectorAll('tbody .lg-cell:not(.lg-ws) .lg-cellbtn')) as HTMLButtonElement[];
    expect(cells[0]!.disabled).toBe(true);
    expect(cells[0]!.title).toContain('its own agent definition names it');
    expect(stateClass(cells[0]!.querySelector('.lg-dot'))).toBe('locked');
    // The agent that DOES name it is a live cell, not a locked one.
    expect(cells[1]!.disabled).toBe(false);
    await fireEvent.click(cells[0]!);
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls).toHaveLength(0);
  });

  it('sets a whole column from its header, as one message', async () => {
    const { container } = await show();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    // orchestrator's first settable cell is read, which is Loaded — so the
    // column goes to the state a click on that cell would have gone to.
    await fireEvent.click(Array.from(container.querySelectorAll('.lg-col'))[1]!);

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'toolsSetSubagentColumn', agent: 'orchestrator', state: 'deferred' },
    ]);
  });

  it('a column header menu resets THAT agent, and the cycle click still works beside it', async () => {
    // Reset is not a fourth state to cycle to — it removes overrides instead of
    // writing one — so it hangs off a menu rather than stealing the header click.
    const { container } = await show();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const menus = Array.from(container.querySelectorAll('.lg-menu-btn')) as HTMLButtonElement[];
    expect(menus).toHaveLength(2); // one per agent column
    expect(container.querySelector('.lg-menu')).toBeNull(); // closed until asked for

    await fireEvent.click(menus[1]!);
    const item = container.querySelector('.lg-menu-item') as HTMLButtonElement;
    expect(item.textContent!.trim()).toBe('Reset to defaults');
    await fireEvent.click(item);

    // t-fisfs5 R5: the column reset ASKS first, through the same ConfirmModal
    // the whole-sheet reset uses. Nothing goes to the host on the menu click.
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls).toHaveLength(0);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Reset orchestrator to defaults?');
    await fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Reset column')!,
    );

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'toolsResetSubagentDefaults', agent: 'orchestrator' },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.lg-menu')).toBeNull(); // and the menu closes behind itself
  });

  it('cancelling the column reset sends nothing at all', async () => {
    const { container } = await show();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click((Array.from(container.querySelectorAll('.lg-menu-btn')) as HTMLButtonElement[])[1]!);
    await fireEvent.click(container.querySelector('.lg-menu-item') as HTMLButtonElement);
    const dialog = document.querySelector('[role="dialog"]')!;
    await fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Cancel')!);

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('both reset dialogs warn that a hand-written plain rule goes too', async () => {
    // The removal cannot tell a plain `tool: action` the user typed from one
    // this sheet wrote (subagentToolReset.ts), and the dialogs used to imply
    // every hand-written key survived.
    const { container } = await show();

    await fireEvent.click(container.querySelector('.lg-reset-all') as HTMLButtonElement);
    const sheet = document.querySelector('[role="dialog"]')!.textContent ?? '';
    expect(sheet).toContain('you wrote by hand');
    expect(sheet).toContain('path-scoped rule');
    await fireEvent.click(
      Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll('button'))
        .find((b) => b.textContent!.trim() === 'Cancel')!,
    );

    await fireEvent.click((Array.from(container.querySelectorAll('.lg-menu-btn')) as HTMLButtonElement[])[0]!);
    await fireEvent.click(container.querySelector('.lg-menu-item') as HTMLButtonElement);
    const column = document.querySelector('[role="dialog"]')!.textContent ?? '';
    expect(column).toContain('you wrote by hand');
    expect(column).toContain('path-scoped rule');
  });

  it('the whole sheet ASKS first — the message goes only after the confirm', async () => {
    // It drops overrides across every column at once and nothing in the webview
    // can put them back, so a misclick must not be enough.
    const { container } = await show();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(container.querySelector('.lg-reset-all') as HTMLButtonElement);
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls).toHaveLength(0);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toContain('Reset every sub-agent');

    // Cancel leaves the sheet alone...
    await fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Cancel')!);
    expect(globalThis.__vscodeApiMock.postMessage.mock.calls).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // ...and confirming sends ONE message, with no agent in it: the host reads
    // which agents exist rather than trusting a list the sheet drew.
    await fireEvent.click(container.querySelector('.lg-reset-all') as HTMLButtonElement);
    const reopened = document.querySelector('[role="dialog"]')!;
    await fireEvent.click(Array.from(reopened.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Reset all')!);

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'toolsResetSubagentDefaults' },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('copies one tool to every agent from the row, as one message with no state in it', async () => {
    const { container } = await show();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    const all = Array.from(container.querySelectorAll('.lg-all')) as HTMLButtonElement[];
    expect(all[0]!.title).toContain('workspace state (Loaded)');
    await fireEvent.click(all[0]!);

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'toolsSetSubagentRow', id: 'read' },
    ]);
  });

  it('keeps a 300-character description INSIDE its cell — clamped, with the whole line in the title', async () => {
    const long = 'x'.repeat(300);
    const { container } = await show({ tools: [{ ...CATALOG.tools[0], description: long }] });

    const desc = container.querySelector('.lg-desc') as HTMLElement;
    expect(desc.classList.contains('lg-clamp')).toBe(true);
    expect(desc.title).toBe(long);
    // The text is all there — the clamp is CSS, which jsdom does not run, so
    // what this can honestly assert is that nothing was truncated in markup
    // and that the class carrying the clamp is on the element.
    expect(desc.textContent).toBe(long);
  });

  it('narrows its ROWS with the pane own search box', async () => {
    const { container } = await show();

    await fireEvent.input(container.querySelector('.tl-search') as HTMLInputElement, { target: { value: 'board' } });
    await tick();

    expect(Array.from(container.querySelectorAll('.lg-id')).map((h) => h.textContent!.trim())).toEqual([
      'board_board_tickets',
    ]);
    // The counts follow the filter: one tool in view, and both agents have it.
    expect(Array.from(container.querySelectorAll('.lg-cnt')).map((c) => c.textContent!.trim())).toEqual([
      '1 of 1 on',
      '1 of 1 on',
    ]);
  });

  it('says so, rather than drawing an empty sheet, when the engine reported no sub-agents', async () => {
    const { container } = await show({ subagents: [] });

    expect(container.querySelector('.lg-table')).toBeNull();
    expect(container.querySelector('.lg-empty')!.textContent).toContain('no sub-agent types');
  });
});

// The peer-tool list is stated TWICE — once in the webview's ledgerRows.ts and
// once in the host's subagentToolWrites.ts — because tsconfig.webview.json pins
// rootDir to `webview/`, so the webview cannot import the host's copy at all.
// The failure that guard catches is silent: add a fourth peer tool to the
// engine and patch only one copy, and the pane draws a live control over a cell
// the host then refuses, or the host refuses a cell the pane drew live.
describe('peer tools — drift guard across the ledger mirrors', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const listIn = (rel: string) => {
    const src = readFileSync(path.resolve(here, rel), 'utf8');
    const line = src.match(/NESTING_TOOLS = new Set\(\[[^\]]*\]/);
    if (!line) throw new Error(`${rel}: NESTING_TOOLS not found — it was renamed or moved`);
    return [...line[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
  };

  it('the webview and the host name the same peer tools, and the engine denies each', () => {
    const webview = listIn('../panes/ledgerRows.ts');
    const host = listIn('../../../src/dashboard/subagentToolWrites.ts');
    const engine = readFileSync(
      path.resolve(here, '../../../../engine/src/agent/subagent-permissions.ts'),
      'utf8',
    );

    expect(webview).toEqual(['list_agents', 'send_message', 'task']);
    expect(host, 'subagentToolWrites.ts drifted from ledgerRows.ts').toEqual(webview);
    // ...and each one is really a default deny in the engine's own derivation.
    for (const tool of webview) {
      expect(engine, `${tool} is not denied by deriveSubagentSessionPermission`).toContain(
        `{ permission: "${tool}" as const, pattern: "*" as const, action: "deny" as const }`,
      );
    }
  });
});
