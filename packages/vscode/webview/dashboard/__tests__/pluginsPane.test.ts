// pluginsPane.test.ts — the Plugins view, both halves (t-kgtolm round 3).
//
// Host side (src/dashboard/pluginsPane.ts): the three messages the pane can
// send, and both writes. The add-from-folder failure case is the one that
// matters most — the manifest parser's message has to reach the user
// UNCHANGED, the same rule toolsPane.test.ts enforces for its own errors.
//
// Webview side (panes/PluginsPane.svelte): cards render from a fixture
// loader state (the ticket's own acceptance line) — name/version/mode, root,
// skills, MCP servers with their status, warnings, and the enable/disable
// switch. jsdom has no layout engine, so this asserts CLASS and badge TEXT,
// never a computed colour.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

const { fake } = vi.hoisted(() => ({
  fake: {
    errors: [] as string[],
    infos: [] as string[],
  },
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: (m: string) => void fake.errors.push(m),
    showInformationMessage: (m: string) => void fake.infos.push(m),
  },
}));

import { PLUGINS_PANE_MESSAGE_TYPES, handlePluginsPaneMessage } from '../../../src/dashboard/pluginsPane';
import PluginsPane from '../panes/PluginsPane.svelte';

const PLUGINS = [
  {
    name: 'standard.fixture',
    version: '2.1.0',
    mode: 'strict',
    root: 'C:/plugins/standard',
    spec: 'C:/plugins/standard',
    enabled: true,
    skillFiles: ['C:/plugins/standard/skills/mapper/SKILL.md'],
    mcp: [
      { name: 'standard-local', type: 'local', status: { status: 'connected' } },
      { name: 'standard-remote', type: 'remote', status: { status: 'failed', error: 'timeout' } },
    ],
    warnings: [],
  },
  {
    name: 'qwen-shaped-blender',
    mode: 'lenient',
    root: 'C:/plugins/qwen-shaped',
    spec: 'C:/plugins/qwen-shaped',
    enabled: false,
    skillFiles: ['C:/plugins/qwen-shaped/skill/SKILL.md'],
    mcp: [{ name: 'qwen-shaped-blender', type: 'local', status: { status: 'disabled' } }],
    warnings: ['ignored unrecognized manifest key "foo"'],
  },
];
const PROBLEMS = [{ spec: 'C:/plugins/broken', message: 'no manifest at C:/plugins/broken (looked for plugin.json)' }];

const hostWith = (client?: { extMethod: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> }) => {
  const posted: Record<string, unknown>[] = [];
  return { host: { ...(client ? { client } : {}), post: (m: Record<string, unknown>) => void posted.push(m) }, posted };
};

const clientReturning = (byMethod: Record<string, unknown>) => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    extMethod: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      const result = byMethod[method];
      if (result instanceof Error) throw result;
      return result as Record<string, unknown>;
    },
  };
};

beforeEach(() => {
  fake.errors = [];
  fake.infos = [];
});
afterEach(() => cleanup());

describe('pluginsPane host — reading the list', () => {
  it('routes exactly the three messages the pane sends and nothing else', () => {
    expect([...PLUGINS_PANE_MESSAGE_TYPES].sort()).toEqual(['pluginsAddFolder', 'pluginsRequest', 'pluginsSetEnabled']);
  });

  it('posts the engine\u2019s plugin list and problems', async () => {
    const client = clientReturning({ list_agent_plugins: { plugins: PLUGINS, problems: PROBLEMS } });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsRequest' });

    expect(posted[0]).toEqual({ type: 'pluginsData', plugins: PLUGINS, problems: PROBLEMS });
    expect(client.calls[0]).toEqual({ method: 'list_agent_plugins', params: {} });
  });

  it('answers with a reason, not an empty pane, when no chat is open', async () => {
    const { host, posted } = hostWith();

    await handlePluginsPaneMessage(host, { type: 'pluginsRequest' });

    expect(posted[0]).toMatchObject({ type: 'pluginsData', plugins: [] });
    expect(String(posted[0]!['error'])).toContain('Open a chat first');
  });

  it('reports an engine failure as an error on the pane instead of throwing', async () => {
    const client = clientReturning({ list_agent_plugins: new Error('engine gone') });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsRequest' });

    expect(String(posted[0]!['error'])).toContain('engine gone');
  });
});

describe('pluginsPane host — the enable/disable toggle', () => {
  it('writes through agent_plugin_set_enabled, says a restart is needed, and re-posts the list', async () => {
    const client = clientReturning({
      agent_plugin_set_enabled: { ok: true, path: 'C:/ws/origami.json' },
      list_agent_plugins: { plugins: PLUGINS, problems: [] },
    });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsSetEnabled', spec: 'C:/plugins/standard', enabled: false });

    expect(client.calls[0]).toEqual({
      method: 'agent_plugin_set_enabled',
      params: { spec: 'C:/plugins/standard', enabled: false },
    });
    expect(fake.infos.join(' ')).toMatch(/restart/i);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'pluginsData' });
  });

  it('surfaces a rejection message and still re-posts the list', async () => {
    const client = clientReturning({
      agent_plugin_set_enabled: { ok: false, message: '"C:/plugins/standard" is not in agentPlugins in any project or global origami.json' },
      list_agent_plugins: { plugins: [], problems: [] },
    });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsSetEnabled', spec: 'C:/plugins/standard', enabled: false });

    expect(fake.errors).toEqual(['"C:/plugins/standard" is not in agentPlugins in any project or global origami.json']);
    expect(posted).toHaveLength(1);
  });

  it('does nothing for an empty or missing spec', async () => {
    const client = clientReturning({});
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsSetEnabled', spec: '', enabled: false });

    expect(client.calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  // t-q41knp — the reported bug: the switch did not visibly move. The write
  // succeeds, but `list_agent_plugins` answers from the ENGINE's own
  // per-instance loader cache (no file watcher), so the immediate re-post
  // echoed the OLD enabled value straight back. PLUGINS below is exactly
  // that: a static reply that never itself changes, the same shape the real
  // cached engine takes.
  it('the switch VISIBLY flips in the re-posted list, not just on disk', async () => {
    const client = clientReturning({
      agent_plugin_set_enabled: { ok: true, path: 'C:/ws/origami.json' },
      list_agent_plugins: { plugins: PLUGINS, problems: [] },
    });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsSetEnabled', spec: 'C:/plugins/standard', enabled: false });

    const plugins = posted[0]!['plugins'] as Array<Record<string, unknown>>;
    const patched = plugins.find((p) => p['spec'] === 'C:/plugins/standard');
    expect(patched?.['enabled'], 'still the STALE engine value — the switch looks like it did nothing').toBe(false);
    // The other plugin is untouched — this patches only the one that changed.
    expect(plugins.find((p) => p['spec'] === 'C:/plugins/qwen-shaped')?.['enabled']).toBe(false);
  });

  it('a refused write re-posts the list UNCHANGED — no cosmetic flip on failure', async () => {
    const client = clientReturning({
      agent_plugin_set_enabled: { ok: false, message: 'nope' },
      list_agent_plugins: { plugins: PLUGINS, problems: [] },
    });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsSetEnabled', spec: 'C:/plugins/standard', enabled: false });

    const row = (posted[0]!['plugins'] as Array<Record<string, unknown>>).find((p) => p['spec'] === 'C:/plugins/standard');
    expect(row?.['enabled']).toBe(true); // PLUGINS' own original value
  });
});

describe('pluginsPane host — add from folder', () => {
  it('validates through agent_plugin_add, says a restart is needed to load it, and re-posts the list', async () => {
    const client = clientReturning({
      agent_plugin_add: { ok: true, path: 'C:/ws/origami.json', name: 'standard.fixture' },
      list_agent_plugins: { plugins: PLUGINS, problems: [] },
    });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsAddFolder', dir: '  C:/plugins/standard  ' });

    // Trimmed before it crosses to the engine.
    expect(client.calls[0]).toEqual({ method: 'agent_plugin_add', params: { dir: 'C:/plugins/standard' } });
    expect(fake.infos.join(' ')).toContain('standard.fixture');
    expect(fake.infos.join(' ')).toMatch(/restart/i);
    expect(posted).toHaveLength(1);
  });

  it('rejects an invalid manifest with the parser\u2019s error, verbatim and unmodified', async () => {
    const parserMessage = 'C:/plugins/broken/plugin.json: name: does not match the pattern ^[a-z0-9]';
    const client = clientReturning({
      agent_plugin_add: { ok: false, message: parserMessage },
      list_agent_plugins: { plugins: [], problems: [] },
    });
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsAddFolder', dir: 'C:/plugins/broken' });

    expect(fake.errors).toEqual([parserMessage]);
    expect(posted).toHaveLength(1);
  });

  it('does nothing for an empty or whitespace-only path', async () => {
    const client = clientReturning({});
    const { host, posted } = hostWith(client);

    await handlePluginsPaneMessage(host, { type: 'pluginsAddFolder', dir: '   ' });

    expect(client.calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('refuses with a reason, and calls nothing, when no chat is open', async () => {
    const { host, posted } = hostWith();

    await handlePluginsPaneMessage(host, { type: 'pluginsAddFolder', dir: 'C:/plugins/standard' });

    expect(fake.errors.join(' ')).toContain('Open a chat first');
    expect(posted).toEqual([]);
  });
});

describe('PluginsPane — cards render from a fixture loader state', () => {
  const deliver = (payload: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'pluginsData', ...payload } }));

  it('asks the host for the plugin list as soon as it mounts', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(PluginsPane);
    await tick();

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('pluginsRequest');
  });

  it('renders one card per plugin with name, version and mode', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: [] });
    await tick();

    const cards = Array.from(container.querySelectorAll('.pg-card'));
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('.pg-name')!.textContent).toBe('standard.fixture');
    expect(cards[0]!.querySelector('.pg-version')!.textContent).toBe('2.1.0');
    expect(cards[0]!.querySelector('.pg-mode')!.textContent).toBe('strict');
    // No version on the second fixture entry — no blank chip rendered for it.
    expect(cards[1]!.querySelector('.pg-version')).toBeNull();
  });

  it('shows the source path, discovered skills and MCP servers with their status', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: [] });
    await tick();

    const cards = Array.from(container.querySelectorAll('.pg-card'));
    expect(cards[0]!.querySelector('.pg-root')!.textContent).toBe('C:/plugins/standard');

    const skillItems = Array.from(cards[0]!.querySelectorAll('.pg-skill-list li'));
    expect(skillItems.map((n) => n.textContent)).toEqual(['C:/plugins/standard/skills/mapper/SKILL.md']);

    const mcpRows = Array.from(cards[0]!.querySelectorAll('.pg-mcp-row'));
    expect(mcpRows).toHaveLength(2);
    expect(mcpRows[0]!.querySelector('.pg-mcp-name')!.textContent).toBe('standard-local');
    expect(mcpRows[0]!.querySelector('.pg-mcp-status')!.textContent).toBe('connected');
    expect(mcpRows[0]!.querySelector('.pg-mcp-status')!.classList.contains('pg-status-ok')).toBe(true);
    expect(mcpRows[1]!.querySelector('.pg-mcp-status')!.textContent).toBe('failed');
    expect(mcpRows[1]!.querySelector('.pg-mcp-status')!.classList.contains('pg-status-error')).toBe(true);
  });

  it('marks a disabled plugin with the restart note, and shows its warnings', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: [] });
    await tick();

    const cards = Array.from(container.querySelectorAll('.pg-card'));
    const disabledCard = cards[1]!;
    expect(disabledCard.classList.contains('disabled')).toBe(true);
    expect(disabledCard.querySelector('.pg-disabled-note')!.textContent).toContain('restart');
    expect(disabledCard.querySelector('.pg-mcp-status')!.textContent).toBe('not connected');
    expect(disabledCard.querySelector('.pg-mcp-status')!.classList.contains('pg-status-off')).toBe(true);
    const warnings = Array.from(disabledCard.querySelectorAll('.pg-warning')).map((n) => n.textContent);
    expect(warnings).toEqual(['ignored unrecognized manifest key "foo"']);

    // The enabled card gets neither.
    expect(cards[0]!.classList.contains('disabled')).toBe(false);
    expect(cards[0]!.querySelector('.pg-disabled-note')).toBeNull();
  });

  it('shows configured-but-broken specs as problems, separately from the cards', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: PROBLEMS });
    await tick();

    const problems = Array.from(container.querySelectorAll('.pg-problem'));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.textContent).toContain('C:/plugins/broken');
    expect(problems[0]!.textContent).toContain('no manifest at');
    // A problem never becomes a card — it has no parsed name to key one on.
    expect(container.querySelectorAll('.pg-card')).toHaveLength(2);
  });

  it('filters cards by name or root path, narrowing the count', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: [] });
    await tick();
    expect(container.querySelectorAll('.pg-card')).toHaveLength(2);

    const search = container.querySelector('.pg-search') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'qwen' } });
    await tick();

    const cards = Array.from(container.querySelectorAll('.pg-card'));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.querySelector('.pg-name')!.textContent).toBe('qwen-shaped-blender');
    expect(container.querySelector('.pg-count')!.textContent).toBe('1/2');
  });

  it('toggling the switch posts the flipped enabled state for that plugin only', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: [] });
    await tick();

    const cards = Array.from(container.querySelectorAll('.pg-card'));
    const sw = cards[0]!.querySelector('.pg-switch') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true'); // standard.fixture is enabled

    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(sw);

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'pluginsSetEnabled',
      spec: 'C:/plugins/standard',
      enabled: false,
    });
    // No optimistic flip: nothing moves until the host's reply lands.
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('the switch moves once a fresh pluginsData reply lands, and stays put on one that still reports the old value', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: [] });
    await tick();
    const sw = container.querySelectorAll('.pg-card')[0]!.querySelector('.pg-switch') as HTMLButtonElement;
    await fireEvent.click(sw);

    // A reply that still says enabled (the stale-cache bug, pre-fix host):
    // the switch must not have moved.
    deliver({ plugins: PLUGINS, problems: [] });
    await tick();
    expect(sw.getAttribute('aria-checked')).toBe('true');

    // The real (patched) reply: the switch flips.
    const flipped = PLUGINS.map((p) => (p.spec === 'C:/plugins/standard' ? { ...p, enabled: false } : p));
    deliver({ plugins: flipped, problems: [] });
    await tick();
    const swNow = container.querySelectorAll('.pg-card')[0]!.querySelector('.pg-switch') as HTMLButtonElement;
    expect(swNow.getAttribute('aria-checked')).toBe('false');
  });

  // Owner ruling: the add-from-folder box is pinned above the plugin cards,
  // always at the top of the pane — never buried under a full card grid (or a
  // problems banner) the user has to scroll past to find it.
  it('pins the add-from-folder box above the problems banner and the card grid, at the top of the pane', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: PLUGINS, problems: PROBLEMS });
    await tick();

    const scroll = container.querySelector('.pg-scroll')!;
    const children = Array.from(scroll.children);
    expect(children[0]!.classList.contains('pg-new'), 'add-from-folder box is not the first element in the pane').toBe(true);
  });

  it('the add-from-folder box posts the typed path, trims nothing itself, and disables Add when empty', async () => {
    const { container } = render(PluginsPane);
    await tick();
    deliver({ plugins: [], problems: [] });
    await tick();

    const input = container.querySelector('.pg-new-input') as HTMLInputElement;
    const go = container.querySelector('.pg-new-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);

    await fireEvent.input(input, { target: { value: 'C:/plugins/new-one' } });
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(go);

    expect(globalThis.__vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'pluginsAddFolder',
      dir: 'C:/plugins/new-one',
    });
  });
});
