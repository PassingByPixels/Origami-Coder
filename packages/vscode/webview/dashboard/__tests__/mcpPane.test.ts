// mcpPane.test.ts — the MCP view, both halves.
//
// Host side (src/dashboard/mcpPane.ts): the nine messages the pane can send.
// The refusals matter most: a validation failure must NEVER reach the engine
// (an `mcp_add` with an empty command would write a server that can never
// start), and an engine rejection must reach the user UNCHANGED — it names the
// config file or the schema issue, and a rewrite here drops exactly the part
// they need.
//
// Webview side (panes/MCPPane.svelte): `source` and `shadowed` are the two
// things this view exists to say, so they are asserted per card rather than
// left implied. jsdom has no layout engine, so this asserts CLASS and text,
// never a computed colour.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

const { fake } = vi.hoisted(() => ({
  fake: { errors: [] as string[], infos: [] as string[], opened: [] as string[] },
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: (m: string) => void fake.errors.push(m),
    showInformationMessage: (m: string) => void fake.infos.push(m),
  },
  env: { openExternal: (u: { toString(): string }) => void fake.opened.push(String(u)) },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));

import { MCP_PANE_MESSAGE_TYPES, handleMcpPaneMessage } from '../../../src/dashboard/mcpPane';
import { commandFrom, serverFrom } from '../../../src/dashboard/mcpAddServer';
import { parsePairs } from '../components/mcpAddForm';
import MCPPane from '../panes/MCPPane.svelte';

const SERVERS = [
  {
    name: 'config-local',
    source: 'config',
    shadowed: false,
    type: 'local',
    enabled: true,
    command: ['npx', '-y', '@scope/server'],
    status: { status: 'connected' },
    supportsOAuth: false,
  },
  {
    name: 'plugin-brought',
    source: 'plugin',
    shadowed: false,
    type: 'local',
    enabled: true,
    command: ['plugin-cmd'],
    status: { status: 'failed', error: 'spawn plugin-cmd ENOENT' },
    supportsOAuth: false,
  },
  {
    name: 'shadowing-remote',
    source: 'config',
    shadowed: true,
    type: 'remote',
    enabled: true,
    url: 'https://example.test/mcp',
    status: { status: 'needs_auth' },
    supportsOAuth: true,
    auth: 'expired',
  },
  {
    name: 'bare-marker',
    source: 'config',
    shadowed: true,
    type: 'unknown',
    enabled: false,
    status: { status: 'disabled' },
    supportsOAuth: false,
  },
];

const hostWith = (client?: { extMethod: (m: string, p?: Record<string, unknown>) => Promise<Record<string, unknown>> }) => {
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

const listing = (extra: Record<string, unknown> = {}) => ({ mcp_list: { servers: SERVERS }, ...extra });

beforeEach(() => {
  fake.errors = [];
  fake.infos = [];
  fake.opened = [];
});
afterEach(() => cleanup());

describe('mcpPane host — reading the list', () => {
  it('routes exactly the messages the pane sends and nothing else', () => {
    expect([...MCP_PANE_MESSAGE_TYPES].sort()).toEqual([
      'mcpAdd', 'mcpAuthRemove', 'mcpAuthenticate', 'mcpConnect', 'mcpDisconnect',
      'mcpOpenAuthUrl', 'mcpRemove', 'mcpRequest', 'mcpSetEnabled',
    ]);
  });

  it('posts the engine\u2019s server list verbatim', async () => {
    const client = clientReturning(listing());
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpRequest' });

    expect(posted[0]).toEqual({ type: 'mcpData', servers: SERVERS });
    expect(client.calls[0]).toEqual({ method: 'mcp_list', params: {} });
  });

  it('answers with a reason, not an empty pane, when no chat is open', async () => {
    const { host, posted } = hostWith();

    await handleMcpPaneMessage(host, { type: 'mcpRequest' });

    expect(posted[0]).toMatchObject({ type: 'mcpData', servers: [] });
    expect(String(posted[0]!['error'])).toContain('Open a chat first');
  });

  it('reports an engine failure as an error on the pane instead of throwing', async () => {
    const client = clientReturning({ mcp_list: new Error('engine gone') });
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpRequest' });

    expect(String(posted[0]!['error'])).toContain('engine gone');
  });
});

describe('mcpPane host — adding a server', () => {
  it('splits a local command on whitespace, the way the CLI wizard does', () => {
    // One text box, many argv entries. Collapsing runs of spaces matters: a
    // stray double space would otherwise become an empty argument.
    expect(commandFrom('  npx   -y  @scope/server ')).toEqual(['npx', '-y', '@scope/server']);
    expect(commandFrom('')).toEqual([]);
    expect(commandFrom(undefined)).toEqual([]);
    expect(commandFrom('   ')).toEqual([]);
  });

  // The owner's report: an interpreter installed under "Program Files" could
  // not be added. A plain whitespace split turned
  // `C:\Program Files\nodejs\node.exe` into TWO arguments, neither of which
  // exists, and the server failed to spawn with an ENOENT naming a path the
  // user never typed.
  it('groups a quoted argument, so a path with spaces survives as ONE argv entry', () => {
    expect(commandFrom('"C:\\Program Files\\nodejs\\node.exe" server.js')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'server.js',
    ]);
  });

  it('handles quoted, unquoted and mid-argument quoting in the same line', () => {
    // Quotes are a GROUPING device, not a wrapper: `--root="C:/My Files"` is
    // one argument, exactly as a shell would read it.
    expect(commandFrom('node server.js --root="C:/My Files" --port 9')).toEqual([
      'node', 'server.js', '--root=C:/My Files', '--port', '9',
    ]);
    // ...and a backslash stays LITERAL. Treating it as an escape would break
    // every Windows path this field exists to take.
    expect(commandFrom('"C:\\a b\\x.exe"')).toEqual(['C:\\a b\\x.exe']);
  });

  it('keeps the rest of the line as one argument when a quote is never closed', () => {
    // Half-typed input should read as a WRONG path, not vanish: dropping the
    // tail would send a command that looks plausible and is not what was typed.
    expect(commandFrom('node "C:/My Files/server.js')).toEqual(['node', 'C:/My Files/server.js']);
  });

  it('refuses a command whose EXECUTABLE is empty, not just an empty box', () => {
    // `""` is not blank, so the pane's own "is something typed" check passes
    // it. Without this the config would gain a server whose command spawns
    // nothing at all.
    expect(serverFrom({ serverType: 'local', command: '""' })).toContain('command is required');
    expect(serverFrom({ serverType: 'local', command: '"" --flag' })).toContain('command is required');
  });

  it('sends a local add as a `{ type: "local", command: [...] }` server, with the chosen scope', async () => {
    const client = clientReturning(listing({ mcp_add: { ok: true, path: 'C:/ws/origami.json' } }));
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, {
      type: 'mcpAdd', name: '  fs  ', serverType: 'local', command: 'npx -y fs-server', scope: 'global',
    });

    expect(client.calls[0]).toEqual({
      method: 'mcp_add',
      params: { name: 'fs', server: { type: 'local', command: ['npx', '-y', 'fs-server'] }, scope: 'global' },
    });
    expect(fake.infos.join(' ')).toContain('C:/ws/origami.json');
    // The list is re-read after the write, so the pane shows real state.
    expect(posted.at(-1)).toMatchObject({ type: 'mcpData' });
  });

  it('sends a remote add as a `{ type: "remote", url }` server, defaulting to project scope', async () => {
    const client = clientReturning(listing({ mcp_add: { ok: true } }));
    const { host } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpAdd', name: 'api', serverType: 'remote', url: ' https://x.test/mcp ' });

    expect(client.calls[0]!.params).toEqual({
      name: 'api', server: { type: 'remote', url: 'https://x.test/mcp' }, scope: 'project',
    });
  });

  it('refuses a blank name WITHOUT calling the engine, and posts nothing', async () => {
    const client = clientReturning(listing());
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpAdd', name: '   ', serverType: 'local', command: 'x' });

    expect(client.calls).toEqual([]);
    expect(posted).toEqual([]);
    expect(fake.errors.join(' ')).toContain('name is required');
  });

  it('refuses an empty command WITHOUT calling the engine — an unstartable server never reaches config', async () => {
    const client = clientReturning(listing());
    const { host } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpAdd', name: 'fs', serverType: 'local', command: '   ' });

    expect(client.calls).toEqual([]);
    expect(fake.errors.join(' ')).toContain('command is required');
  });

  it('refuses an empty URL for a remote server WITHOUT calling the engine', async () => {
    const client = clientReturning(listing());
    const { host } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpAdd', name: 'api', serverType: 'remote', url: '' });

    expect(client.calls).toEqual([]);
    expect(fake.errors.join(' ')).toContain('URL is required');
  });

  // The reason the form grew: the engine has validated ConfigMCPV1.Info's
  // cwd/environment/headers since it shipped, so a server added from the pane
  // could always have carried its API key \u2014 the form and this passthrough were
  // the missing halves. Without them a hosted server is written credential-less
  // and fails auth minutes later, nowhere near the form that caused it.
  it('carries cwd and environment into the LOCAL server object', async () => {
    const client = clientReturning(listing({ mcp_add: { ok: true } }));
    const { host } = hostWith(client);

    await handleMcpPaneMessage(host, {
      type: 'mcpAdd', name: 'fs', serverType: 'local', command: 'node s.js',
      cwd: '  C:/work  ', environment: { API_KEY: 'sk-1', DEBUG: '1' },
    });

    expect(client.calls[0]!.params).toEqual({
      name: 'fs',
      server: { type: 'local', command: ['node', 's.js'], cwd: 'C:/work', environment: { API_KEY: 'sk-1', DEBUG: '1' } },
      scope: 'project',
    });
  });

  it('carries headers into the REMOTE server object', async () => {
    const client = clientReturning(listing({ mcp_add: { ok: true } }));
    const { host } = hostWith(client);

    await handleMcpPaneMessage(host, {
      type: 'mcpAdd', name: 'api', serverType: 'remote', url: 'https://x.test/mcp',
      headers: { Authorization: 'Bearer sk-1' },
    });

    expect(client.calls[0]!.params).toEqual({
      name: 'api',
      server: { type: 'remote', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer sk-1' } },
      scope: 'project',
    });
  });

  it('OMITS an optional field that is empty instead of writing "" or {} into the config', () => {
    // The server object is written VERBATIM into the user's config file. An
    // `"environment": {}` sitting there reads as a setting someone made and
    // then emptied, not as one that was never used.
    expect(serverFrom({ serverType: 'local', command: 'node s.js', cwd: '   ', environment: {} }))
      .toEqual({ type: 'local', command: ['node', 's.js'] });
    expect(serverFrom({ serverType: 'remote', url: 'https://x.test', headers: {} }))
      .toEqual({ type: 'remote', url: 'https://x.test' });
    // ...and a field the pane never sent is the same case, not a crash.
    expect(serverFrom({ serverType: 'local', command: 'node s.js' }))
      .toEqual({ type: 'local', command: ['node', 's.js'] });
  });

  it('drops a non-string value off the wire rather than forwarding it into a schema error', () => {
    // The engine would refuse the WHOLE add on one bad value, with a schema
    // message about a field the user cannot see. The pane parses text into
    // strings, so anything else here is a bug on this side of the wire.
    expect(serverFrom({ serverType: 'local', command: 'node s.js', environment: { A: 1, B: 'ok' } }))
      .toEqual({ type: 'local', command: ['node', 's.js'], environment: { B: 'ok' } });
    expect(serverFrom({ serverType: 'local', command: 'node s.js', environment: ['A=1'] }))
      .toEqual({ type: 'local', command: ['node', 's.js'] });
    expect(serverFrom({ serverType: 'local', command: 'node s.js', cwd: 42 }))
      .toEqual({ type: 'local', command: ['node', 's.js'] });
  });

  it('surfaces the engine\u2019s rejection VERBATIM and still re-posts the list', async () => {
    const message = '"fs" is already configured (C:/ws/origami.json)';
    const client = clientReturning(listing({ mcp_add: { ok: false, message } }));
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpAdd', name: 'fs', serverType: 'local', command: 'npx fs' });

    expect(fake.errors).toEqual([message]);
    expect(posted.at(-1)).toMatchObject({ type: 'mcpData' });
  });
});

describe('mcpAddForm — the env/header text blocks', () => {
  it('reads one pair per line and ignores blank ones', () => {
    expect(parsePairs('API_KEY=sk-1\n\nDEBUG=1\n', '=')).toEqual({ ok: true, pairs: { API_KEY: 'sk-1', DEBUG: '1' } });
    expect(parsePairs('', '=')).toEqual({ ok: true, pairs: {} });
    expect(parsePairs('   \n\n', ':')).toEqual({ ok: true, pairs: {} });
  });

  it('splits at the FIRST separator only, so the value keeps its own', () => {
    // The two cases this really protects: a base64 token full of `=`, and a
    // header whose value is a URL (`https://…` has a colon four characters in).
    expect(parsePairs('TOKEN=YWJj=abc==', '=')).toEqual({ ok: true, pairs: { TOKEN: 'YWJj=abc==' } });
    expect(parsePairs('Referer: https://x.test/a', ':')).toEqual({ ok: true, pairs: { Referer: 'https://x.test/a' } });
  });

  it('trims around the separator but keeps an intentionally empty value', () => {
    expect(parsePairs('  API_KEY  =  sk-1  ', '=')).toEqual({ ok: true, pairs: { API_KEY: 'sk-1' } });
    // `KEY=` is a real thing to write: the variable is set, to nothing.
    expect(parsePairs('EMPTY=', '=')).toEqual({ ok: true, pairs: { EMPTY: '' } });
  });

  it('NAMES the first unreadable line instead of dropping it', () => {
    // Silently skipping it is the dangerous behaviour: the server gets written
    // without the key, looks configured, and fails auth later with no clue
    // pointing back at this box.
    expect(parsePairs('A=1\nAPI_KEY sk-1\nB=2', '=')).toEqual({ ok: false, line: 'API_KEY sk-1' });
    expect(parsePairs('Authorization Bearer x', ':')).toEqual({ ok: false, line: 'Authorization Bearer x' });
    // A separator with NO key to its left is the same nothing.
    expect(parsePairs('=sk-1', '=')).toEqual({ ok: false, line: '=sk-1' });
    expect(parsePairs(': value', ':')).toEqual({ ok: false, line: ': value' });
  });

  it('lets the last of a repeated key win, the way a Record has to', () => {
    expect(parsePairs('A=1\nA=2', '=')).toEqual({ ok: true, pairs: { A: '2' } });
  });

  it('survives CRLF and non-ASCII values — this is a Windows-first surface', () => {
    // A stray \r left on the end of every value would be invisible here and
    // would break the receiving server's own parsing of its key.
    expect(parsePairs('A=1\r\nB=2\r\n', '=')).toEqual({ ok: true, pairs: { A: '1', B: '2' } });
    expect(parsePairs('PATH=C:\\Ünïcode\\naïve — dir\nEMOJI=🔑', '=')).toEqual({
      ok: true, pairs: { PATH: 'C:\\Ünïcode\\naïve — dir', EMOJI: '🔑' },
    });
  });
});

describe('mcpPane host — the per-server actions', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['mcpRemove', 'mcp_remove', {}],
    ['mcpConnect', 'mcp_connect', {}],
    ['mcpDisconnect', 'mcp_disconnect', {}],
    ['mcpAuthenticate', 'mcp_authenticate', {}],
    ['mcpAuthRemove', 'mcp_auth_remove', {}],
  ];

  it.each(cases)('%s calls %s with the server name and re-posts the list', async (type, method) => {
    const client = clientReturning(listing({ [method]: { ok: true } }));
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, { type, name: 'config-local' });

    expect(client.calls[0]).toEqual({ method, params: { name: 'config-local' } });
    expect(posted.at(-1)).toMatchObject({ type: 'mcpData' });
  });

  it('mcpSetEnabled carries the boolean, and a missing one is read as false, never as true', async () => {
    const client = clientReturning(listing({ mcp_set_enabled: { ok: true } }));
    const { host } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpSetEnabled', name: 'config-local', enabled: 'yes' });

    // Coercing a truthy non-boolean would silently ENABLE a server the user
    // was trying to turn off.
    expect(client.calls[0]!.params).toEqual({ name: 'config-local', enabled: false });
  });

  it('drops an action with a blank name instead of sending it', async () => {
    const client = clientReturning(listing());
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpConnect', name: '  ' });

    expect(client.calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('reports a failed action with the engine\u2019s own message and still re-reads', async () => {
    const client = clientReturning(listing({ mcp_connect: { ok: false, message: 'MCP server not found: ghost' } }));
    const { host, posted } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpConnect', name: 'ghost' });

    expect(fake.errors).toEqual(['MCP server not found: ghost']);
    expect(posted.at(-1)).toMatchObject({ type: 'mcpData' });
  });

  it('refuses every write with no chat open, and never posts a stale list for it', async () => {
    const { host, posted } = hostWith();

    await handleMcpPaneMessage(host, { type: 'mcpConnect', name: 'config-local' });

    expect(fake.errors.join(' ')).toContain('Open a chat first');
    expect(posted).toEqual([]);
  });
});

describe('mcpPane host — the sign-in link', () => {
  it('opens the URL externally only when the USER asks', async () => {
    const { host } = hostWith(clientReturning(listing()));

    await handleMcpPaneMessage(host, { type: 'mcpOpenAuthUrl', url: 'https://auth.test/authorize?x=1' });

    expect(fake.opened).toEqual(['https://auth.test/authorize?x=1']);
  });

  it('never opens anything for a missing or non-string URL', async () => {
    const { host } = hostWith(clientReturning(listing()));

    await handleMcpPaneMessage(host, { type: 'mcpOpenAuthUrl' });
    await handleMcpPaneMessage(host, { type: 'mcpOpenAuthUrl', url: 42 });

    expect(fake.opened).toEqual([]);
  });

  it('does NOT open a browser as a side effect of mcpAuthenticate — the engine already did', async () => {
    // Two browser windows for one sign-in is the bug this pins.
    const client = clientReturning(listing({ mcp_authenticate: { ok: true, status: { status: 'connected' } } }));
    const { host } = hostWith(client);

    await handleMcpPaneMessage(host, { type: 'mcpAuthenticate', name: 'shadowing-remote' });

    expect(fake.opened).toEqual([]);
  });
});

describe('MCPPane — the list', () => {
  const deliver = (payload: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcpData', ...payload } }));

  const cardFor = (container: HTMLElement, name: string) =>
    Array.from(container.querySelectorAll('.mcp-card')).find(
      (c) => c.querySelector('.mcp-name')?.textContent === name,
    ) as HTMLElement;

  const buttons = (card: HTMLElement) =>
    Array.from(card.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim());

  const mounted = async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: SERVERS });
    await tick();
    return container;
  };

  it('asks the host for the server list as soon as it mounts', async () => {
    globalThis.__vscodeApiMock.postMessage.mockClear();
    render(MCPPane);
    await tick();

    expect(globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type)).toContain('mcpRequest');
  });

  it('renders one card per server, with its source and type', async () => {
    const container = await mounted();

    expect(container.querySelectorAll('.mcp-card')).toHaveLength(4);
    expect(cardFor(container, 'config-local').querySelector('.mcp-source')!.textContent).toBe('config');
    expect(cardFor(container, 'plugin-brought').querySelector('.mcp-source')!.textContent).toBe('plugin');
    expect(cardFor(container, 'shadowing-remote').querySelector('.mcp-type')!.textContent).toBe('remote');
  });

  // The whole reason the view exists: `{ ...pluginServers, ...cfg.mcp }` means
  // a config entry silently overrides a plugin's server of the same name.
  it('marks a SHADOWING config entry, and does not mark one that shadows nothing', async () => {
    const container = await mounted();

    expect(cardFor(container, 'shadowing-remote').querySelector('.mcp-shadow')!.textContent)
      .toContain('Overrides a plugin server');
    expect(cardFor(container, 'config-local').querySelector('.mcp-shadow')).toBeNull();
    // ...and a REAL server that shadows one gets the override note, not the bare-marker note.
    expect(cardFor(container, 'shadowing-remote').querySelector('.mcp-bare')).toBeNull();
  });

  it('explains the bare `enabled` entry rather than showing a typeless mystery row', async () => {
    const container = await mounted();
    const card = cardFor(container, 'bare-marker');

    expect(card.querySelector('.mcp-bare')!.textContent).toContain('only turns a plugin');
    expect(card.classList.contains('disabled')).toBe(true);
  });

  it('shows the status pill with the class its state maps to', async () => {
    const container = await mounted();
    const pill = (name: string) => cardFor(container, name).querySelector('.mcp-status')!;

    expect(pill('config-local').textContent).toBe('connected');
    expect(pill('config-local').classList.contains('mcp-status-ok')).toBe(true);
    expect(pill('plugin-brought').classList.contains('mcp-status-error')).toBe(true);
    expect(pill('shadowing-remote').textContent).toBe('needs auth');
    expect(pill('shadowing-remote').classList.contains('mcp-status-warn')).toBe(true);
    expect(pill('bare-marker').classList.contains('mcp-status-off')).toBe(true);
  });

  it('shows a failed server\u2019s error text VERBATIM, not a summary', async () => {
    const container = await mounted();

    expect(cardFor(container, 'plugin-brought').querySelector('.mcp-fail')!.textContent)
      .toBe('spawn plugin-cmd ENOENT');
    expect(cardFor(container, 'config-local').querySelector('.mcp-fail')).toBeNull();
  });
});

describe('MCPPane — the actions each card offers', () => {
  const deliver = (payload: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcpData', ...payload } }));
  const cardFor = (container: HTMLElement, name: string) =>
    Array.from(container.querySelectorAll('.mcp-card')).find(
      (c) => c.querySelector('.mcp-name')?.textContent === name,
    ) as HTMLElement;
  const button = (card: HTMLElement, label: string) =>
    Array.from(card.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === label);
  const sent = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]);

  const mounted = async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: SERVERS });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    return container;
  };

  it('offers Authenticate only where the engine says OAuth applies', async () => {
    const container = await mounted();

    expect(button(cardFor(container, 'shadowing-remote'), 'Authenticate')).toBeDefined();
    expect(button(cardFor(container, 'config-local'), 'Authenticate')).toBeUndefined();
  });

  it('offers "Forget login" only where a credential is actually stored', async () => {
    const container = await mounted();

    expect(button(cardFor(container, 'shadowing-remote'), 'Forget login')).toBeDefined();
    expect(button(cardFor(container, 'config-local'), 'Forget login')).toBeUndefined();
  });

  it('offers Disconnect for a connected server and Connect for one that is not', async () => {
    const container = await mounted();

    expect(button(cardFor(container, 'config-local'), 'Disconnect')).toBeDefined();
    expect(button(cardFor(container, 'config-local'), 'Connect')).toBeUndefined();
    expect(button(cardFor(container, 'plugin-brought'), 'Connect')).toBeDefined();
  });

  // A plugin's server is not the config file's to delete: removing the entry
  // would do nothing and the row would come straight back.
  it('offers Remove for a config server and, for a plugin one, says to disable it instead', async () => {
    const container = await mounted();

    expect(button(cardFor(container, 'config-local'), 'Remove')).toBeDefined();
    expect(button(cardFor(container, 'plugin-brought'), 'Remove')).toBeUndefined();
    expect(cardFor(container, 'plugin-brought').querySelector('.mcp-note')!.textContent)
      .toContain('disable it rather than removing it');
  });

  it('Remove takes TWO clicks — the first only arms the confirm', async () => {
    const container = await mounted();
    const card = cardFor(container, 'config-local');

    await fireEvent.click(button(card, 'Remove')!);
    await tick();
    expect(sent().some((m) => m?.type === 'mcpRemove')).toBe(false);

    await fireEvent.click(button(cardFor(container, 'config-local'), 'Confirm remove')!);
    await tick();
    expect(sent()).toContainEqual({ type: 'mcpRemove', name: 'config-local' });
  });

  it('Cancel disarms the confirm without removing anything', async () => {
    const container = await mounted();

    await fireEvent.click(button(cardFor(container, 'config-local'), 'Remove')!);
    await tick();
    await fireEvent.click(button(cardFor(container, 'config-local'), 'Cancel')!);
    await tick();

    expect(sent().some((m) => m?.type === 'mcpRemove')).toBe(false);
    expect(button(cardFor(container, 'config-local'), 'Remove')).toBeDefined();
  });

  it('the enable/disable button sends the OPPOSITE of the current state', async () => {
    const container = await mounted();

    await fireEvent.click(button(cardFor(container, 'config-local'), 'Disable')!);
    await fireEvent.click(button(cardFor(container, 'bare-marker'), 'Enable')!);

    expect(sent()).toContainEqual({ type: 'mcpSetEnabled', name: 'config-local', enabled: false });
    expect(sent()).toContainEqual({ type: 'mcpSetEnabled', name: 'bare-marker', enabled: true });
  });

  it('shows the sign-in link only after the engine pushes one, and posts the URL back on click', async () => {
    const container = await mounted();
    expect(container.querySelector('.mcp-link')).toBeNull();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'mcpAuthUrl', name: 'shadowing-remote', url: 'https://auth.test/go' },
    }));
    await tick();

    const link = cardFor(container, 'shadowing-remote').querySelector('.mcp-link') as HTMLButtonElement;
    expect(link).not.toBeNull();
    // ...and only on the server it was pushed for.
    expect(cardFor(container, 'config-local').querySelector('.mcp-link')).toBeNull();

    await fireEvent.click(link);
    expect(sent()).toContainEqual({
      type: 'mcpOpenAuthUrl', name: 'shadowing-remote', url: 'https://auth.test/go',
    });
  });
});

describe('MCPPane — the add box', () => {
  const deliver = (payload: Record<string, unknown>) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'mcpData', ...payload } }));
  const sent = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]);

  // The add box is MCPAddForm.svelte now, mounted by the pane. Driven THROUGH
  // the pane rather than in isolation, because "the pane still hands it the
  // taken names and its message still reaches the host" is the part an
  // extraction breaks.
  const field = (c: HTMLElement, label: string) =>
    c.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement;
  const type = async (c: HTMLElement, label: string, value: string) => {
    await fireEvent.input(field(c, label), { target: { value } });
    await tick();
  };

  it('posts an mcpAdd carrying the name, type, command and scope', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await type(container, 'MCP server name', 'fs');
    await type(container, 'Local server command', 'npx -y fs-server');
    await fireEvent.click(container.querySelector('.mcp-new-go') as HTMLButtonElement);

    expect(sent()).toContainEqual({
      type: 'mcpAdd', name: 'fs', serverType: 'local', command: 'npx -y fs-server', url: '', scope: 'project',
      cwd: '', environment: {}, headers: {},
    });
  });

  it('carries the cwd and the parsed environment block in the message', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await type(container, 'MCP server name', 'fs');
    await type(container, 'Local server command', 'node C:/s.js');
    await type(container, 'Working directory', 'C:/work');
    await type(container, 'Environment variables, one per line', 'API_KEY=sk-1\nDEBUG=1');
    await fireEvent.click(container.querySelector('.mcp-new-go') as HTMLButtonElement);

    expect(sent()).toContainEqual({
      type: 'mcpAdd', name: 'fs', serverType: 'local', command: 'node C:/s.js', url: '', scope: 'project',
      cwd: 'C:/work', environment: { API_KEY: 'sk-1', DEBUG: '1' }, headers: {},
    });
  });

  it('carries the parsed headers block for a REMOTE server, and no local-only fields', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await type(container, 'MCP server name', 'api');
    await fireEvent.change(container.querySelector('[aria-label="Server type"]') as HTMLSelectElement,
      { target: { value: 'remote' } });
    await tick();
    await type(container, 'Remote server URL', 'https://x.test/mcp');
    await type(container, 'Request headers, one per line', 'Authorization: Bearer sk-1');
    await fireEvent.click(container.querySelector('.mcp-new-go') as HTMLButtonElement);

    expect(sent()).toContainEqual({
      type: 'mcpAdd', name: 'api', serverType: 'remote', command: '', url: 'https://x.test/mcp', scope: 'project',
      cwd: '', environment: {}, headers: { Authorization: 'Bearer sk-1' },
    });
  });

  // A malformed line must never reach the engine: it would take the empty
  // record, write a server WITHOUT the credential, and report success.
  it('refuses a malformed env line in the pane, NAMING it, and sends nothing', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await type(container, 'MCP server name', 'fs');
    await type(container, 'Local server command', 'node C:/s.js');
    await type(container, 'Environment variables, one per line', 'API_KEY=sk-1\nDEBUG 1');

    expect(container.querySelector('.mcp-new-warn')!.textContent).toContain('"DEBUG 1"');
    expect((container.querySelector('.mcp-new-go') as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(container.querySelector('.mcp-new-go') as HTMLButtonElement);
    expect(sent().some((m) => m?.type === 'mcpAdd')).toBe(false);

    // ...and fixing the line clears the refusal rather than latching it.
    await type(container, 'Environment variables, one per line', 'API_KEY=sk-1\nDEBUG=1');
    expect(container.querySelector('.mcp-new-warn')).toBeNull();
    expect((container.querySelector('.mcp-new-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('refuses a malformed header line for a remote server the same way', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await type(container, 'MCP server name', 'api');
    await fireEvent.change(container.querySelector('[aria-label="Server type"]') as HTMLSelectElement,
      { target: { value: 'remote' } });
    await tick();
    await type(container, 'Remote server URL', 'https://x.test/mcp');
    await type(container, 'Request headers, one per line', 'Authorization Bearer sk-1');

    expect(container.querySelector('.mcp-new-warn')!.textContent).toContain('"Authorization Bearer sk-1"');
    await fireEvent.click(container.querySelector('.mcp-new-go') as HTMLButtonElement);
    expect(sent().some((m) => m?.type === 'mcpAdd')).toBe(false);
  });

  // A block left behind by a switch of type is not sent, so it must not be
  // able to block the add either — the user cannot see the field to fix it.
  it('ignores a stale block belonging to the OTHER server type', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await type(container, 'MCP server name', 'api');
    await type(container, 'Environment variables, one per line', 'BROKEN LINE');
    await fireEvent.change(container.querySelector('[aria-label="Server type"]') as HTMLSelectElement,
      { target: { value: 'remote' } });
    await tick();
    await type(container, 'Remote server URL', 'https://x.test/mcp');

    expect(container.querySelector('.mcp-new-warn')).toBeNull();
    await fireEvent.click(container.querySelector('.mcp-new-go') as HTMLButtonElement);
    expect(sent().some((m) => m?.type === 'mcpAdd')).toBe(true);
  });

  // The extraction's own failure mode: the form is a CHILD of the pane now, so
  // a pane re-render on every mcpData (one lands after every write anywhere in
  // the view) must not throw away a half-typed add.
  it('keeps a half-typed add through a server-list refresh', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();

    await type(container, 'MCP server name', 'fs');
    await type(container, 'Environment variables, one per line', 'API_KEY=sk-1');
    deliver({ servers: SERVERS });
    await tick();

    expect(field(container, 'MCP server name').value).toBe('fs');
    expect(field(container, 'Environment variables, one per line').value).toBe('API_KEY=sk-1');
    // ...and the refreshed list is what the duplicate check now reads.
    await type(container, 'MCP server name', 'config-local');
    expect(container.querySelector('.mcp-new-warn')!.textContent).toContain('already listed');
  });

  // The owner read `npx -y @scope/server` as "npm packages only" and did not
  // try their own interpreter. The field always took any executable.
  it('says any executable works, and that quotes group an argument', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();

    const copy = Array.from(container.querySelectorAll('.mcp-new-hint')).map((h) => h.textContent).join(' ');
    expect(copy).toContain('Any executable');
    expect(copy).toMatch(/quotes group|Double quotes group/i);
    expect(field(container, 'Local server command').getAttribute('placeholder')).toBe('node C:/path/server.js');
    // ...and the old npm-flavoured placeholder is really gone.
    expect(container.innerHTML).not.toContain('npx -y @scope/server');
  });

  // The engine refuses a duplicate too. Catching it here is what stops the
  // user filling in a whole form for an add that cannot land.
  it('blocks Add for a name already in the list, and says why', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: SERVERS });
    await tick();

    const nameInput = container.querySelector('.mcp-new-input') as HTMLInputElement;
    await fireEvent.input(nameInput, { target: { value: 'config-local' } });
    await tick();

    expect((container.querySelector('.mcp-new-go') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.mcp-new-warn')!.textContent).toContain('already listed');
  });

  it('blocks Add until the command (or URL) is filled in', async () => {
    const { container } = render(MCPPane);
    await tick();
    deliver({ servers: [] });
    await tick();

    const nameInput = container.querySelector('.mcp-new-input') as HTMLInputElement;
    await fireEvent.input(nameInput, { target: { value: 'fs' } });
    await tick();

    expect((container.querySelector('.mcp-new-go') as HTMLButtonElement).disabled).toBe(true);
  });
});
