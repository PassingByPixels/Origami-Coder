// browserBridge.test.ts — the client half of the engine's `browser` tool.
//
// These drive the REAL handler from src/browserBridge.ts against a faked
// `vscode` module (the harness pattern from sidebar-chat-view.test.ts), so the
// assertions are about what the engine would read back off the wire, not about
// how the file is written. Each case breaks on a specific regression:
//   1. an open-command id that this build does not register being used anyway;
//   2. a bare file path handed to the browser instead of a file:// url;
//   3. a missing browser tool degrading to a silent no-op instead of an
//      actionable refusal that says what WAS published;
//   4. image bytes from a screenshot arriving as anything but their base64;
//   5. a text-only screenshot reply reported as success.
//
// THE FIXTURE IS THE POINT. Every tool name below is a real id, copied out of
// the shipped VS Code bundle — 1.132.0, re-read on 1.133.0 when hover, drag,
// dialog and raw were mapped, and again on 1.135.0 when back/forward/reload
// were: the same eleven ids every time, and the `inputSchema`s those verbs
// send are quoted verbatim in browserDrive.ts. So are the page-list and
// open replies the fake returns. The first version of this suite invented names
// (`browser_read_page`, `browser_click`) and passed 38/38 while every page verb
// was dead on a real build — it only ever proved the bridge agreed with itself.
// A fixture that stops matching a shipped build makes these tests worthless
// again, so re-derive it from the bundle rather than editing it to fit.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const { fake } = vi.hoisted(() => ({
  fake: {
    commands: [] as string[],
    executed: [] as unknown[][],
    executeThrows: undefined as string | undefined,
    tools: [] as { name: string }[],
    invokeCalls: [] as { name: string; input: unknown }[],
    invokeResult: undefined as unknown,
    invokeThrows: undefined as string | undefined,
    /** Per-tool replies, so one call can answer the page lookup and the next the action. */
    invokeResults: {} as Record<string, unknown>,
    /** VS Code's global auto-approve, which gates the forced click. */
    autoApprove: false as boolean,
    /** What `vscode.window.activeTextEditor` answers, and what the focus
     *  restore did about it. */
    activeEditor: undefined as unknown,
    shown: [] as unknown[][],
    /** Lets a test model a command that MOVES the focus, which is the only
     *  thing the restore below is allowed to react to. */
    executeCallback: undefined as (() => void) | undefined,
  },
}));

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({
      toString: () => `file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`,
    }),
    // The browser page's editor resource — `oy.forId` builds it with URI.from,
    // and the reveal opens it.
    from: (c: { scheme: string; path: string }) => ({ toString: () => `${c.scheme}:${c.path}` }),
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string) => (key === 'chat.tools.global.autoApprove' ? fake.autoApprove : undefined) }),
  },
  commands: {
    getCommands: async () => fake.commands,
    executeCommand: async (...args: unknown[]) => {
      fake.executed.push(args);
      if (fake.executeThrows) throw new Error(fake.executeThrows);
      fake.executeCallback?.();
    },
  },
  // The open command cannot be told to preserve focus on every build, so
  // browserFocus.ts reads the active editor before the call and puts the cursor
  // back if it MOVED. The fake starts with none — which is the ordinary case
  // during an agent turn, the dashboard webview having focus — so nothing is
  // restored unless a test says there was an editor to restore to.
  window: {
    get activeTextEditor() {
      return fake.activeEditor;
    },
    showTextDocument: async (doc: unknown, column: unknown) => {
      fake.shown.push([doc, column]);
    },
  },
  lm: {
    get tools() {
      return fake.tools;
    },
    invokeTool: async (name: string, options: { input: unknown }) => {
      fake.invokeCalls.push({ name, input: options.input });
      if (fake.invokeThrows) throw new Error(fake.invokeThrows);
      return name in fake.invokeResults ? fake.invokeResults[name] : fake.invokeResult;
    },
  },
}));

import {
  handleBrowserRequest,
  handleBrowserExtMethod,
  isBrowserMethod,
  toBrowserUrl,
  parseRequest,
} from '../../../src/browserBridge';
import { resetRevealedPages } from '../../../src/browserReveal';
import { PAGE_TEXT_CAP } from '../../../src/browserSnapshot';
import { AcpClient, type AcpEventHandlers } from '../../../src/acpClient';

/** The ACP client member the engine's ext request actually lands on. */
function extMethodOf(client: AcpClient) {
  return (client as unknown as {
    buildClientImpl: () => { extMethod: (m: string, p: Record<string, unknown>) => Promise<Record<string, unknown>> };
  }).buildClientImpl().extMethod;
}

/** A LanguageModelToolResult-shaped reply: text parts carry `value`, image
 *  parts carry `data` + `mimeType`. */
function toolResult(parts: unknown[]) {
  return { content: parts };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

/** The eleven tools VS Code 1.132.0 publishes once page sharing is available,
 *  verbatim. NOT ONE of the five that drive a page contains "browser". */
const SHIPPED_TOOLS = [
  'open_browser_page',
  'read_page',
  'screenshot_page',
  'navigate_page',
  'click_element',
  'drag_element',
  'hover_element',
  'type_in_page',
  'run_playwright_code',
  'handle_dialog',
  'list_browser_pages',
];

/** The reduced set VS Code registers when page sharing is unavailable — the
 *  ONE case the enableChatTools setting decides. */
const REDUCED_TOOLS = ['open_browser_page'];

/** `list_browser_pages` output, in VS Code's own wording and line format. */
function pageList(pages: { id: string; title: string; url: string; state: string }[], unshared = 0) {
  const head = pages.length
    ? 'The following browser pages are currently shared with you and can be interacted with using the browser tools:\n' +
      pages.map((p) => `- [${p.id}] ${p.title} (${p.url}) (${p.state})`).join('\n')
    : 'No browser pages are currently shared with you.';
  const tail = unshared ? `\n\n${unshared} ${unshared === 1 ? 'page is' : 'pages are'} open but not shared.` : '';
  return toolResult([{ value: head + tail }]);
}

/** One shared, active page — the ordinary case every page verb runs against. */
function oneSharedPage(id = 'page-1') {
  return pageList([{ id, title: 'Origami', url: 'https://a.test/', state: 'active' }]);
}

/** The whole happy path: the shipped tools, a page open and shared, and a reply. */
function withPage(actionResult: unknown, id = 'page-1') {
  fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
  fake.invokeResults = { list_browser_pages: oneSharedPage(id) };
  fake.invokeResult = actionResult;
}

/** What the driven tool was called with, ignoring the page lookup that precedes it. */
/** The VERB's call. Two invocations are bookkeeping rather than the verb: the
 *  page lookup, and — since t-ntmm93 — the `setViewportSize` snippet a viewport
 *  screenshot runs first, so the picture is the configured page viewport rather
 *  than whatever size the user left the tab. Both are skipped here. */
function drivenCall() {
  return fake.invokeCalls.find(
    (c) => c.name !== 'list_browser_pages' && !viewportSnippetOf(c.input),
  );
}

function viewportSnippetOf(input: unknown): string | undefined {
  const code = (input as { code?: unknown })?.code;
  return typeof code === 'string' && code.includes('setViewportSize') ? code : undefined;
}

beforeEach(() => {
  fake.commands = [];
  fake.executed = [];
  fake.executeThrows = undefined;
  fake.tools = [];
  fake.invokeCalls = [];
  fake.invokeResult = undefined;
  fake.invokeResults = {};
  fake.autoApprove = false;
  fake.invokeThrows = undefined;
  fake.activeEditor = undefined;
  fake.shown = [];
  fake.executeCallback = undefined;
  // Process-wide by design (browserReveal.ts), so it is cleared between cases.
  resetRevealedPages();
});

describe('the ext-method seam', () => {
  it('accepts both the plain and the `_`-prefixed method name', () => {
    expect(isBrowserMethod('origami/browser')).toBe(true);
    expect(isBrowserMethod('_origami/browser')).toBe(true);
    expect(isBrowserMethod('origami/browserish')).toBe(false);
  });

  it('refuses an action outside the contract by name instead of guessing', async () => {
    expect(parseRequest({ action: 'download' })).toBeUndefined();
    const res = await handleBrowserExtMethod({ action: 'download' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('download');
  });

  it('is reachable on the ACP client the engine calls, under either spelling', async () => {
    const extMethod = extMethodOf(new AcpClient({} as AcpEventHandlers));
    fake.commands = ['workbench.browser.open'];
    expect(await extMethod('origami/browser', { action: 'open', url: 'https://a.test' })).toMatchObject({ ok: true });
    expect(await extMethod('_origami/browser', { action: 'probe' })).toMatchObject({ ok: true });
    expect(fake.executed).toEqual([['workbench.browser.open', 'https://a.test', { preserveFocus: true }]]);
  });

  it('still reports a method it does not implement as not found', async () => {
    const extMethod = extMethodOf(new AcpClient({} as AcpEventHandlers));
    await expect(extMethod('origami/somethingElse', {})).rejects.toThrow(/somethingElse/);
  });
});

describe('probe', () => {
  it('reports no open command and no tools on a build that has neither', async () => {
    const res = await handleBrowserRequest({ action: 'probe' });
    expect(res.ok).toBe(true);
    expect(res.tools).toEqual([]);
    expect(res.pageText).toContain('no integrated-browser open command found');
  });

  it('names the discovered open command and the browser tools', async () => {
    fake.commands = ['git.clone', 'workbench.browser.open'];
    fake.tools = [{ name: 'navigate_page' }, { name: 'copilot_search' }, { name: 'screenshot_page' }];
    const res = await handleBrowserRequest({ action: 'probe' });
    expect(res.ok).toBe(true);
    expect(res.pageText).toBe('open command: workbench.browser.open');
    expect(res.tools).toEqual(['navigate_page', 'screenshot_page']);
  });

  it('finds every shipped browser tool, and nothing that merely sits beside them', async () => {
    // The regression this kills outright: the old predicate matched the
    // substring "browser", which of the eleven shipped ids only two carry —
    // and neither of those two can drive a page. It reported exactly the
    // two-tool list the failing session saw.
    fake.tools = [
      ...SHIPPED_TOOLS.map((name) => ({ name })),
      { name: 'copilot_search' },
      { name: 'read_file' },
      { name: 'fetch_webpage' },
    ];
    const res = await handleBrowserRequest({ action: 'probe' });
    expect(res.tools).toEqual(SHIPPED_TOOLS);
    expect(res.tools).toContain('read_page');
    expect(res.tools).not.toContain('fetch_webpage');
    expect(res.tools).not.toContain('read_file');
  });
});

/** One well-formed request per driven verb, so a case that only needs "some
 *  valid call" does not have to restate the arguments each one owes. */
const DRIVEN: [Parameters<typeof handleBrowserRequest>[0], string][] = [
  [{ action: 'read' }, 'read_page'],
  [{ action: 'screenshot' }, 'screenshot_page'],
  [{ action: 'click', selector: '#go' }, 'click_element'],
  [{ action: 'type', selector: '#q', text: 'hi' }, 'type_in_page'],
  [{ action: 'hover', selector: '#menu' }, 'hover_element'],
  [{ action: 'drag', selector: '#card', toSelector: '#bin' }, 'drag_element'],
  [{ action: 'dialog', accept: true }, 'handle_dialog'],
  [{ action: 'raw', code: 'return page.title()' }, 'run_playwright_code'],
];

describe('tool discovery against the REAL shipped ids', () => {
  for (const [request, tool] of DRIVEN) {
    it(`drives ${tool} for "${request.action}" on a stock tool list`, async () => {
      // raw is the one verb with a gate of its own; every other verb ignores it.
      fake.autoApprove = true;
      withPage(toolResult([{ value: 'ok' }, { data: PNG_BYTES, mimeType: 'image/png' }]));
      await handleBrowserRequest(request);
      expect(drivenCall()?.name).toBe(tool);
    });
  }

  it('drives navigate_page for "navigate", without touching the open command', async () => {
    fake.commands = ['workbench.browser.open'];
    withPage(toolResult([{ value: 'navigated' }]));
    const res = await handleBrowserRequest({ action: 'navigate', url: 'https://b.test/page' });
    expect(res.ok).toBe(true);
    expect(drivenCall()?.name).toBe('navigate_page');
    expect(fake.executed).toEqual([]);
  });

  it('falls back to a renamed sibling only when the exact id is gone', async () => {
    fake.tools = [{ name: 'read_page_v2' }, { name: 'list_browser_pages' }];
    fake.invokeResults = { list_browser_pages: oneSharedPage() };
    fake.invokeResult = toolResult([{ value: 'Heading' }]);
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(true);
    expect(drivenCall()?.name).toBe('read_page_v2');
  });
});

describe('open', () => {
  it('turns a local file path into a file:// url for the integrated browser', async () => {
    fake.commands = ['workbench.browser.open'];
    const res = await handleBrowserRequest({ action: 'open', url: 'C:\\tmp\\page.html' });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('file:///C:/tmp/page.html');
    expect(fake.executed).toEqual([['workbench.browser.open', 'file:///C:/tmp/page.html', { preserveFocus: true }]]);
  });

  it('leaves an http(s) address alone', () => {
    expect(toBrowserUrl('https://origami.gratis/x?y=1')).toBe('https://origami.gratis/x?y=1');
    expect(toBrowserUrl('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('prefers the current command id over the phased-out one', async () => {
    fake.commands = ['simpleBrowser.show', 'workbench.action.browser.open'];
    await handleBrowserRequest({ action: 'open', url: 'https://a.test' });
    expect(fake.executed[0][0]).toBe('workbench.action.browser.open');
  });

  it('refuses honestly when the build registers no open command at all', async () => {
    fake.commands = ['git.clone'];
    const res = await handleBrowserRequest({ action: 'open', url: 'https://a.test' });
    expect(res.ok).toBe(false);
    expect(fake.executed).toEqual([]);
    expect(String(res.error)).toContain('workbench.browser.open');
    expect(String(res.error)).toContain('simpleBrowser.show');
  });

  it('prefers open_browser_page over the command, because only the tool SHARES the page', async () => {
    // A page opened by the command is `notShared`, and every page verb after
    // it then fails with "open but not shared" — a browser that opens pages it
    // cannot read. The tool opens it shared and answers with its id.
    fake.commands = ['workbench.browser.open'];
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      open_browser_page: toolResult([{ value: 'Page ID: page-7\n\nSummary:\n' }, { value: 'heading' }]),
    };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://a.test' });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls).toEqual([{ name: 'open_browser_page', input: { url: 'https://a.test' } }]);
    expect(fake.executed).toEqual([]);
    expect(String(res.pageText)).toContain('page-7');
  });

  it('passes VS Code’s own note through when the reduced open cannot share the page', async () => {
    // The reduced open still SHOWS the page and explains, in VS Code's words,
    // why nothing can read it. That sentence is the warning before read fails,
    // so it is forwarded verbatim rather than replaced.
    const note =
      'Page opened successfully. Note that you do not have access to the page contents unless the user ' +
      'enables agentic tools via the `workbench.browser.enableChatTools` setting.';
    fake.commands = ['workbench.browser.open'];
    fake.tools = REDUCED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { open_browser_page: toolResult([{ value: note }]) };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://a.test' });
    expect(res.ok).toBe(true);
    expect(res.pageText).toBe(note);
  });

  it('still opens through the command when the open tool throws', async () => {
    fake.commands = ['workbench.browser.open'];
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeThrows = 'tool invocation requires a chat request';
    const res = await handleBrowserRequest({ action: 'open', url: 'https://a.test' });
    expect(res.ok).toBe(true);
    expect(fake.executed).toEqual([['workbench.browser.open', 'https://a.test', { preserveFocus: true }]]);
  });

  it('reports a throwing open command instead of claiming the page opened', async () => {
    fake.commands = ['workbench.browser.open'];
    fake.executeThrows = 'browser view disposed';
    const res = await handleBrowserRequest({ action: 'open', url: 'https://a.test' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('browser view disposed');
  });

  it('needs a url', async () => {
    const res = await handleBrowserRequest({ action: 'open' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('needs a url');
  });
});

describe('navigate', () => {
  it('falls back to opening when no navigate tool is published', async () => {
    fake.commands = ['workbench.browser.open'];
    const res = await handleBrowserRequest({ action: 'navigate', url: 'https://b.test/page' });
    expect(res.ok).toBe(true);
    expect(fake.executed).toEqual([['workbench.browser.open', 'https://b.test/page', { preserveFocus: true }]]);
  });

  it('opens instead of navigating when the tool exists but no page is open', async () => {
    // There is nothing to move. Opening is what the request meant, and it is
    // what makes the page shared so the next verb can reach it.
    fake.commands = ['workbench.browser.open'];
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      list_browser_pages: pageList([]),
      open_browser_page: toolResult([{ value: 'Page ID: page-9\n\nSummary:\n' }, { value: 'heading' }]),
    };
    const res = await handleBrowserRequest({ action: 'navigate', url: 'https://b.test/page' });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.some((c) => c.name === 'navigate_page')).toBe(false);
    expect(fake.invokeCalls.some((c) => c.name === 'open_browser_page')).toBe(true);
  });
});

describe('back / forward / reload — navigate_page without a url', () => {
  // `navigate_page`'s inputSchema (1.135.0 bundle) is
  // `{ pageId, type: "url"|"back"|"forward"|"reload", url }`, required
  // `["pageId"]`, and its `switch (t.type)` reaches goBack/goForward/reload
  // WITHOUT reading `url` — only the "url" default throws when it is missing.
  // So `toEqual` here is the assertion: a url smuggled onto a history call is
  // a field VS Code drops in silence, which is this bridge's quietest failure.
  for (const type of ['back', 'forward', 'reload'] as const) {
    it(`sends navigate_page { pageId, type: "${type}" } and no url`, async () => {
      withPage(toolResult([{ value: 'navigated' }]));
      const res = await handleBrowserRequest({ action: type });
      expect(res.ok).toBe(true);
      expect(drivenCall()).toEqual({ name: 'navigate_page', input: { pageId: 'page-1', type } });
    });
  }

  it('refuses when no page is shared, instead of opening one like navigate does', async () => {
    // The behaviour that separates these three from `navigate`: navigate can
    // answer an empty browser by OPENING the url it was given, and these name
    // no url at all. Falling through to the open path would put a blank or a
    // stale tab on screen and report it as a history move.
    fake.commands = ['workbench.browser.open'];
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: pageList([]) };
    const res = await handleBrowserRequest({ action: 'back' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('No page is open');
    expect(fake.invokeCalls.some((c) => c.name === 'navigate_page')).toBe(false);
    expect(fake.invokeCalls.some((c) => c.name === 'open_browser_page')).toBe(false);
    expect(fake.executed).toEqual([]);
  });

  it('carries the three verbs across the wire, so engine and client cannot drift', () => {
    for (const action of ['back', 'forward', 'reload']) {
      expect(parseRequest({ action })).toEqual(expect.objectContaining({ action }));
    }
  });
});

describe('the input each tool actually requires', () => {
  // Asserted against the verbatim inputSchemas in the shipped bundle. Every
  // one of these tools requires `pageId`; without it VS Code returns "No page
  // ID provided" and the page is never touched — which is what every one of
  // these verbs did before, on every machine, at every setting.

  it('sends read_page nothing but the pageId it requires', async () => {
    withPage(toolResult([{ value: 'Heading' }]));
    await handleBrowserRequest({ action: 'read' });
    expect(drivenCall()).toEqual({ name: 'read_page', input: { pageId: 'page-1' } });
  });

  it('sends screenshot_page a pageId and NO fullPage — it has no such property', async () => {
    withPage(toolResult([{ data: PNG_BYTES, mimeType: 'image/png' }]));
    await handleBrowserRequest({ action: 'screenshot' });
    const input = drivenCall()?.input as Record<string, unknown>;
    expect(input).toEqual({ pageId: 'page-1' });
    expect(input).not.toHaveProperty('fullPage');
  });

  it('sends screenshot_page the SELECTOR when the model named one element', async () => {
    // The bridge used to send `{pageId}` and nothing else, so every element
    // screenshot silently came back as the whole viewport — a picture of the
    // wrong thing, reported as the picture that was asked for. The schema
    // carries ref/selector/element and scrollIntoViewIfNeeded; the crop is
    // `locator(sel).boundingBox()`, which is viewport-relative, so an element
    // below the fold needs the scroll or the box lands outside the shot.
    withPage(toolResult([{ data: PNG_BYTES, mimeType: 'image/png' }]));
    await handleBrowserRequest({ action: 'screenshot', selector: '#chart' });
    expect(drivenCall()).toEqual({
      name: 'screenshot_page',
      input: {
        pageId: 'page-1',
        selector: '#chart',
        element: 'the element matching #chart',
        scrollIntoViewIfNeeded: true,
      },
    });
  });

  it('sends click_element the element description its schema REQUIRES, beside the selector', async () => {
    // required: ["pageId","element"], $comment: one of "ref" or "selector".
    // Omitting `element` is a schema violation, and it is the field the user's
    // own confirmation sentence is built from.
    withPage(toolResult([]));
    await handleBrowserRequest({ action: 'click', selector: '#go' });
    const input = drivenCall()?.input as Record<string, unknown>;
    expect(drivenCall()?.name).toBe('click_element');
    expect(input.pageId).toBe('page-1');
    expect(input.element).toBeTruthy();
    expect(String(input.element)).toContain('#go');
    expect(input.selector ?? input.ref).toBeTruthy();
  });

  it('sends type_in_page a pageId and text, plus the element a selector obliges', async () => {
    withPage(toolResult([]));
    await handleBrowserRequest({ action: 'type', selector: '#q', text: 'origami' });
    const input = drivenCall()?.input as Record<string, unknown>;
    expect(drivenCall()?.name).toBe('type_in_page');
    expect(input.pageId).toBe('page-1');
    expect(input.text).toBe('origami');
    expect(input.selector).toBe('#q');
    expect(String(input.element)).toContain('#q');
  });

  it('sends type_in_page the KEY, on the element the selector names', async () => {
    // `key` and `text` are alternatives in the schema, and `key` wins when both
    // are set: with a selector it is `locator(sel).press(key)`.
    withPage(toolResult([]));
    await handleBrowserRequest({ action: 'type', selector: '#q', key: 'Enter' });
    expect(drivenCall()).toEqual({
      name: 'type_in_page',
      input: { pageId: 'page-1', selector: '#q', element: 'the element matching #q', key: 'Enter' },
    });
  });

  it('sends a bare keypress with no selector and no element', async () => {
    // With no selector the tool uses `page.keyboard.press`, which reaches
    // whatever the PAGE focused. `element` is owed only when a selector is sent,
    // so including it here would describe an element nobody named.
    withPage(toolResult([]));
    await handleBrowserRequest({ action: 'type', key: 'Escape' });
    expect(drivenCall()).toEqual({ name: 'type_in_page', input: { pageId: 'page-1', key: 'Escape' } });
  });

  it('sends hover_element the same selector/element pair its schema requires', async () => {
    // inputSchema: { pageId, ref, selector, element }, required [pageId, element].
    withPage(toolResult([]));
    await handleBrowserRequest({ action: 'hover', selector: '#menu' });
    expect(drivenCall()).toEqual({
      name: 'hover_element',
      input: { pageId: 'page-1', selector: '#menu', element: 'the element matching #menu' },
    });
  });

  it('sends drag_element its two ENDS, not one selector and a partner', async () => {
    // inputSchema: { pageId, fromRef, fromSelector, fromElement, toRef,
    // toSelector, toElement }, required [pageId, fromElement, toElement]. A
    // `selector`/`target` guess would have been dropped whole and reported as a
    // drag that happened.
    withPage(toolResult([]));
    await handleBrowserRequest({ action: 'drag', selector: '#card', toSelector: '#bin' });
    expect(drivenCall()).toEqual({
      name: 'drag_element',
      input: {
        pageId: 'page-1',
        fromSelector: '#card',
        fromElement: 'the element matching #card',
        toSelector: '#bin',
        toElement: 'the element matching #bin',
      },
    });
  });

  it('sends handle_dialog acceptModal, and the prompt answer only when there is one', async () => {
    // inputSchema: { pageId, acceptModal, promptText, selectFiles }. The tool
    // refuses a call carrying neither acceptModal nor selectFiles, and refuses
    // the two together — so acceptModal is always sent and selectFiles never is.
    withPage(toolResult([{ value: 'Dialog accepted.' }]));
    await handleBrowserRequest({ action: 'dialog', accept: true });
    expect(drivenCall()).toEqual({ name: 'handle_dialog', input: { pageId: 'page-1', acceptModal: true } });

    fake.invokeCalls = [];
    withPage(toolResult([{ value: 'Dialog dismissed.' }]));
    await handleBrowserRequest({ action: 'dialog', accept: false, text: 'Origami' });
    expect(drivenCall()).toEqual({
      name: 'handle_dialog',
      input: { pageId: 'page-1', acceptModal: false, promptText: 'Origami' },
    });
  });

  it('sends run_playwright_code the snippet under `code`, with its own timeout', async () => {
    // inputSchema: { pageId, code, deferredResultId, timeoutMs }. The snippet is
    // the BODY of `async (page) => { … }` and is passed through untouched.
    fake.autoApprove = true;
    withPage(toolResult([{ value: 'Result: "Origami"' }, { value: 'Ran Playwright code.' }]));
    await handleBrowserRequest({ action: 'raw', code: 'return page.title()' });
    expect(drivenCall()).toEqual({
      name: 'run_playwright_code',
      input: { pageId: 'page-1', code: 'return page.title()', timeoutMs: 10_000 },
    });
  });

  it('sends navigate_page the pageId and the url under type "url"', async () => {
    withPage(toolResult([{ value: 'navigated' }]));
    await handleBrowserRequest({ action: 'navigate', url: 'https://b.test/page' });
    expect(drivenCall()).toEqual({
      name: 'navigate_page',
      input: { pageId: 'page-1', type: 'url', url: 'https://b.test/page' },
    });
  });

  it('acts on the ACTIVE page when several are shared', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      list_browser_pages: pageList([
        { id: 'bg-1', title: 'Docs', url: 'https://docs.test/', state: 'not visible' },
        { id: 'front', title: 'App', url: 'https://app.test/', state: 'active' },
        { id: 'bg-2', title: 'Other', url: 'https://o.test/', state: 'visible' },
      ]),
    };
    fake.invokeResult = toolResult([{ value: 'Heading' }]);
    await handleBrowserRequest({ action: 'read' });
    expect((drivenCall()?.input as { pageId: string }).pageId).toBe('front');
  });

  it('refuses an empty type instead of sending text VS Code rejects', async () => {
    // type_in_page guards `!text && !key`, so "" comes back as a complaint
    // about a `key` parameter this bridge never offers. Said plainly here.
    withPage(toolResult([]));
    const res = await handleBrowserRequest({ action: 'type', selector: '#q', text: '' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('empty');
    expect(drivenCall()).toBeUndefined();
  });
});

describe('screenshot', () => {
  it('returns the image bytes as base64 with their mime type', async () => {
    withPage(toolResult([{ data: PNG_BYTES, mimeType: 'image/png' }]));
    const res = await handleBrowserRequest({ action: 'screenshot' });
    expect(res.ok).toBe(true);
    expect(res.imageMime).toBe('image/png');
    expect([...Buffer.from(String(res.imageBase64), 'base64')]).toEqual([...PNG_BYTES]);
  });

  it('reports a text-only reply as a failure, quoting what came back', async () => {
    withPage(toolResult([{ value: 'No page is open.' }]));
    const res = await handleBrowserRequest({ action: 'screenshot' });
    expect(res.ok).toBe(false);
    expect(res.imageBase64).toBeUndefined();
    expect(String(res.error)).toContain('No page is open.');
  });

  it('does not take a non-image data part for the capture', async () => {
    // A mimeType + data part is not automatically a picture. Treating a JSON
    // snapshot as one produces a screenshot that renders as a broken image.
    withPage(
      toolResult([
        { data: Buffer.from('{"role":"page"}'), mimeType: 'application/json' },
        { data: PNG_BYTES, mimeType: 'image/png' },
      ]),
    );
    const res = await handleBrowserRequest({ action: 'screenshot' });
    expect(res.ok).toBe(true);
    expect(res.imageMime).toBe('image/png');
    expect([...Buffer.from(String(res.imageBase64), 'base64')]).toEqual([...PNG_BYTES]);
  });

  it('reports a throwing tool instead of an empty screenshot', async () => {
    withPage(toolResult([{ data: PNG_BYTES, mimeType: 'image/png' }]));
    fake.invokeThrows = 'no active page';
    const res = await handleBrowserRequest({ action: 'screenshot' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('no active page');
  });
});

describe('why it could not act — three causes, three answers', () => {
  const SETTING = 'workbench.browser.enableChatTools';

  it('blames nothing but the build when no browser tool is published at all', async () => {
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(false);
    expect(res.tools).toEqual([]);
    expect(String(res.error)).toContain('no integrated-browser tools');
    expect(String(res.error)).not.toContain(SETTING);
  });

  it('still says a page can be SHOWN when the build has the command but no tools', async () => {
    // The commands and the tools are different surfaces, so "cannot read it"
    // and "cannot open it" are different answers. Reporting only the first
    // sends the model away from a page the user could still have been shown.
    fake.commands = ['workbench.browser.open'];
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('workbench.browser.open');
    expect(String(res.error)).toContain('cannot be read');
    expect(String(res.error)).not.toContain(SETTING);
  });

  it('names the setting ONLY for the reduced registration that the setting causes', async () => {
    // open_browser_page alone IS the sharing-unavailable branch: VS Code
    // registers that one tool and returns. This is the one honest mention.
    fake.tools = REDUCED_TOOLS.map((name) => ({ name }));
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(SETTING);
    expect(String(res.error)).toContain('open_browser_page');
  });

  it('reports what WAS published, and does not blame the setting, when only one verb is missing', async () => {
    // list_browser_pages present proves the full branch ran, so the setting is
    // already on. Naming it here is what sent the last session to change a
    // setting that had been true the whole time.
    fake.tools = SHIPPED_TOOLS.filter((name) => name !== 'read_page').map((name) => ({ name }));
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('read_page');
    expect(String(res.error)).toContain('click_element');
    expect(String(res.error)).not.toContain(SETTING);
  });

  it('says NO PAGE IS OPEN rather than blaming a tool that is right there', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: pageList([]) };
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('No page is open');
    expect(String(res.error)).not.toContain(SETTING);
    expect(drivenCall()).toBeUndefined();
  });

  it('distinguishes a page that is open but not shared from no page at all', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: pageList([], 2) };
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('not shared');
    expect(String(res.error)).toContain('2');
    expect(String(res.error)).not.toContain(SETTING);
  });

  it('gives a tool-absent and a no-page failure DIFFERENT prose', async () => {
    fake.tools = SHIPPED_TOOLS.filter((name) => name !== 'read_page').map((name) => ({ name }));
    const absent = await handleBrowserRequest({ action: 'read' });

    fake.invokeCalls = [];
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: pageList([]) };
    const noPage = await handleBrowserRequest({ action: 'read' });

    expect(absent.error).not.toBe(noPage.error);
    expect(String(absent.error)).toContain('no "read_page"');
    expect(String(noPage.error)).toContain('No page is open');
  });
});

describe('a page verb VS Code reported as FAILED', () => {
  // The suite that shipped these verbs asserted only that nothing THREW, and a
  // failing page verb does not throw. Both fixtures below are the shipped
  // shapes, read off out/vs/workbench/workbench.desktop.main.js:
  //   1. PlaywrightSession.invokeFunction CATCHES the Playwright throw into
  //      {result, error, summary}; `xmi` then emits [text(error), text(summary)]
  //      with NO toolResultError and NO image, because its own
  //      toolResultDetails.isError is the field MainThreadLanguageModelTools
  //      .$invokeTool drops ({content, toolMetadata, toolResultError} only).
  //   2. every `Nm(msg)` refusal sets toolResultError, which the ext-host
  //      converter turns into `hasError` on the result the extension receives.
  const CLICK_TIMEOUT =
    "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('#does-not-exist')";
  const SUMMARY = '- Page URL: https://x.test/\n- Page Title: X';

  /** A `Nm(msg)` reply as the extension host hands it over. */
  function refusal(message: string) {
    return { content: [{ value: message }], hasError: true };
  }

  it('reports a click whose error came back as the part AHEAD of the summary', async () => {
    // The ordinary failure mode of clicking. Before this, the bridge answered
    // ok:true and the card painted "Clicked #does-not-exist on https://x." GREEN.
    withPage(toolResult([{ value: CLICK_TIMEOUT }, { value: SUMMARY }]));
    const res = await handleBrowserRequest({ action: 'click', selector: '#does-not-exist' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('Timeout 30000ms exceeded');
    // and it reaches the user as an ERROR, not folded into the page text.
    expect(res.pageText ?? '').not.toContain('Timeout');
  });

  it('reports the same failure for type and for navigate', async () => {
    for (const request of [
      { action: 'type' as const, selector: '#q', text: 'origami' },
      { action: 'navigate' as const, url: 'https://x.test/' },
    ]) {
      fake.invokeCalls = [];
      withPage(toolResult([{ value: CLICK_TIMEOUT }, { value: SUMMARY }]));
      const res = await handleBrowserRequest(request);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('Timeout 30000ms exceeded');
    }
  });

  it('reports a toolResultError refusal as a failure for every verb that can get one', async () => {
    const cases: [Parameters<typeof handleBrowserRequest>[0], string][] = [
      [{ action: 'read' }, 'No page summary available.'],
      [{ action: 'screenshot' }, 'No browser page found with ID page-1'],
      [{ action: 'click', selector: '#go' }, 'Either a "ref" or "selector" parameter is required.'],
      [{ action: 'type', selector: '#q', text: 'hi' }, 'No page ID provided. Use \'open_browser_page\' first.'],
      [{ action: 'navigate', url: 'https://x.test/' }, 'No page ID provided. Use \'open_browser_page\' first.'],
    ];
    for (const [request, message] of cases) {
      fake.invokeCalls = [];
      withPage(refusal(message));
      const res = await handleBrowserRequest(request);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain(message);
      expect(res.pageText ?? '').not.toContain(message);
    }
  });

  it('does not mistake navigate_page’s port-rewrite note for a failure', async () => {
    // `Emi` prepends this on a remote workspace with a forwarded port, so a
    // leading part is not automatically an error — a rule that fired on it
    // would fail every remote navigate.
    const note =
      'Note: `http://localhost:3000/` was rewritten to `http://127.0.0.1:41234/` because this is a remote ' +
      'workspace and the remote port is forwarded to a local address.';
    withPage(toolResult([{ value: note }, { value: SUMMARY }]));
    const res = await handleBrowserRequest({ action: 'navigate', url: 'http://localhost:3000/' });
    expect(res.ok).toBe(true);
    expect(String(res.pageText)).toContain('rewritten');
  });
});

describe('an open VS Code DECLINED', () => {
  // `open_browser_page` opens NOTHING when a shared page is "similar" to the
  // url — `IPo` matches equal hosts, OR both file: scheme, OR either host a
  // subdomain of the other, blanks included — and answers with this instead.
  // Verbatim from `_mi`, ids and all (only the REDUCED open passes excludeIds).
  const DECLINED =
    'At least one similar page is already open:\n' +
    '  - [8f1c-aaa] Origami (https://origami.gratis/) (visible)\n' +
    '\n' +
    'Use an existing page or pass `forceNew: true` to open a new one.';

  it('serves the request by reusing the page VS Code named, and reports that url', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      open_browser_page: toolResult([{ value: DECLINED }]),
      navigate_page: toolResult([{ value: '- Page URL: https://origami.gratis/docs' }]),
    };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://origami.gratis/docs' });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.find((c) => c.name === 'navigate_page')?.input).toEqual({
      pageId: '8f1c-aaa',
      type: 'url',
      url: 'https://origami.gratis/docs',
    });
    expect(res.url).toBe('https://origami.gratis/docs');
  });

  it('refuses in VS Code’s own words when the decline cannot be served', async () => {
    // No navigate_page to reuse the listed page with. Before this, the bridge
    // fell through to the reduced-open branch and returned {ok:true, url} —
    // metadata.ok AND metadata.url both asserting an open that never happened.
    fake.commands = ['workbench.browser.open'];
    fake.tools = [{ name: 'open_browser_page' }, { name: 'list_browser_pages' }];
    fake.invokeResults = { open_browser_page: toolResult([{ value: DECLINED }]) };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://origami.gratis/docs' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('At least one similar page is already open');
    expect(res.url).toBeUndefined();
  });

  it('reports a reuse that itself failed instead of inheriting the open’s optimism', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      open_browser_page: toolResult([{ value: DECLINED }]),
      navigate_page: { content: [{ value: 'No browser page found with ID 8f1c-aaa' }], hasError: true },
    };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://origami.gratis/docs' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('No browser page found with ID 8f1c-aaa');
  });
});

describe('an open VS Code REFUSED, or could not finish', () => {
  // Neither of these is a page, and neither THROWS: both resolve, with the
  // reason carried in the failure signals rather than in the reply text. Both
  // used to leave `open` on its second return path — a hand-written
  // `{ ok: true, url, tools }` on a result nothing had inspected — so the model
  // was told the url was on screen, with no message at all.
  //
  // Read off the shipped VS Code 1.132.0 workbench bundle:
  //   1. `_handlePreToolUseDenial` answers a DECLINED confirmation with
  //      { content: [{ kind: 'text', value: 'Tool execution denied: …' }],
  //        toolResultError: reason }. `open_browser_page` carries
  //      confirmationMessages, so the ordinary "the user says no" lands here.
  //   2. a throw out of `playwrightService.openPage` is caught into
  //      `v ??= { content: [] }; v.toolResultError = …` — no text part at all,
  //      so the reason exists ONLY in the signal.
  const DENIED = 'Tool execution denied: The user cancelled the request.';
  const TIMEOUT = 'Navigation to https://x.test/ timed out after 30000 ms';

  /** As the extension receives it: the converter turns `toolResultError` into `hasError`. */
  function refused(message: string, parts: unknown[] = [{ kind: 'text', value: message }]) {
    return { content: parts, toolResultError: message, hasError: true };
  }

  beforeEach(() => {
    fake.commands = ['workbench.browser.open'];
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
  });

  it('reports a declined open as the failure it is, in VS Code’s own words', async () => {
    fake.invokeResults = { open_browser_page: refused(DENIED) };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://x.test/' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(DENIED);
    // and it does NOT reach past the decline for the open COMMAND: the user
    // refused THIS url, and the command would put it on screen anyway.
    expect(fake.executed).toEqual([]);
    expect(res.url).toBeUndefined();
  });

  it('reports a navigation timeout whose reason exists only in the failure signal', async () => {
    fake.invokeResults = { open_browser_page: refused(TIMEOUT, []) };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://x.test/' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(TIMEOUT);
    expect(fake.executed).toEqual([]);
    expect(res.url).toBeUndefined();
  });

  it('still refuses when only the FLAG survived the ext-host hop', async () => {
    // `$invokeTool` forwards { content, toolMetadata, toolResultError } and
    // nothing else; a build that hands the extension the flag without the
    // message leaves this bridge unable to quote a reason. Losing the WORDS may
    // be out of its hands. Calling it a success is not.
    fake.invokeResults = { open_browser_page: { content: [], hasError: true } };
    const res = await handleBrowserRequest({ action: 'open', url: 'https://x.test/' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('open_browser_page');
    expect(res.url).toBeUndefined();
  });

  it('reports a page LOOKUP that failed instead of inventing "no page is open"', async () => {
    // The same shape one call down. The message is synthetic — no shipped path
    // was identified that makes `list_browser_pages` answer with hasError — but
    // the SHAPE is the bundle's own refusal shape (`Nm(msg)` sets
    // toolResultError, the converter turns it into hasError), and reading it
    // here is what stops a second hand-rolled path existing to rot.
    const reason = 'Browser page sharing was turned off while the request was in flight.';
    fake.invokeResults = { list_browser_pages: refused(reason, [{ value: reason }]) };
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(reason);
    expect(String(res.error)).not.toContain('No page is open');
  });
});

describe('ONE place computes ok', () => {
  it('has no hand-written ok:true or ok:false anywhere in the bridge or the drive', () => {
    // Two false greens have shipped out of browserBridge.ts, and both were the
    // same shape: a SECOND return path that asserted a verdict on a tool result
    // whose failure signals nobody had read. Prose did not stop the second, so
    // the verdict is now a value only browserTools.ts can mint — `succeeded`
    // takes a `Checked`, and `check` is the only source of one.
    //
    // The type system enforces that at `npm run typecheck`. This enforces it in
    // the suite that gates a build, because a green suite is what shipped the
    // first two.
    // cwd, not import.meta.url: these tests run under the jsdom environment,
    // where import.meta.url is not a file: URL and readFileSync refuses it.
    //
    // browserDrive.ts is read too, and that is the whole point of reading a FILE
    // rather than trusting a reviewer: the eight driven verbs moved out of
    // browserBridge.ts, so a guard that still named only that file would have
    // gone green over the code it was written to watch.
    for (const rel of ['src/browserBridge.ts', 'src/browserDrive.ts']) {
      const src = readFileSync(`${process.cwd()}/${rel}`, 'utf8');
      expect([...src.matchAll(/\bok:\s*(?:true|false)/g)].map((m) => m[0]), rel).toEqual([]);
    }
  });

  it('turns a hand-cast Checked that carries a failure back into one', async () => {
    // `as Checked` is the one way around the type gate, and it is exactly what
    // a hurried edit reaches for. So the proof is re-read at run time too, and
    // the parts win over the caller's intent.
    const { succeeded } = await import('../../../src/browserTools');
    const forged = { text: 'summary', error: 'No browser page found with ID page-1' } as never;
    const res = succeeded(forged, { url: 'https://x.test/', tools: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('No browser page found with ID page-1');
    expect(res.url).toBeUndefined();
  });
});

describe('which of several shared pages gets driven', () => {
  it('drives the VISIBLE page when NONE is marked active', async () => {
    // The ordinary case, and the one the suite never exercised: while the agent
    // works the user is focused on a source file or the chat view, so VS Code
    // marks no browser page (active). `Lcn` prints THREE states; parsing only
    // (active) threw the tie-breaker away and fell to registration order,
    // driving the off-screen page over the one on screen.
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      list_browser_pages: pageList([
        { id: '8f1c-aaa', title: 'Origami', url: 'https://origami.gratis/', state: 'not visible' },
        { id: '8f1c-bbb', title: 'Docs', url: 'https://docs.test/', state: 'visible' },
      ]),
    };
    fake.invokeResult = toolResult([{ value: 'Heading' }]);
    const res = await handleBrowserRequest({ action: 'read' });
    expect((drivenCall()?.input as { pageId: string }).pageId).toBe('8f1c-bbb');
    // and the model is told WHICH page it drove, because more than one was shared.
    expect(String(res.pageText)).toContain('8f1c-bbb');
  });

  it('still prefers an active page over a visible one', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      list_browser_pages: pageList([
        { id: '8f1c-aaa', title: 'Origami', url: 'https://origami.gratis/', state: 'visible' },
        { id: '8f1c-bbb', title: 'Docs', url: 'https://docs.test/', state: 'active' },
      ]),
    };
    fake.invokeResult = toolResult([{ value: 'Heading' }]);
    await handleBrowserRequest({ action: 'read' });
    expect((drivenCall()?.input as { pageId: string }).pageId).toBe('8f1c-bbb');
  });

  it('says nothing extra when only one page is shared', async () => {
    withPage(toolResult([{ value: 'Heading' }]));
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.pageText).toBe('Heading');
  });
});

describe('read / click / type', () => {
  it('joins the text parts of a read into pageText', async () => {
    withPage(toolResult([{ value: 'Heading' }, { value: 'Body copy' }]));
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(true);
    expect(drivenCall()?.name).toBe('read_page');
    expect(res.pageText).toBe('Heading\nBody copy');
  });

  it('reads a non-image data part as text instead of losing the page', async () => {
    // The lie this kills: a build that answers `read` with an application/json
    // snapshot used to have it swallowed as "the screenshot", leaving pageText
    // empty — and the engine then told the model the page had no readable text.
    withPage(toolResult([{ data: Buffer.from('{"heading":"Origami"}'), mimeType: 'application/json' }]));
    const res = await handleBrowserRequest({ action: 'read' });
    expect(res.ok).toBe(true);
    expect(res.pageText).toBe('{"heading":"Origami"}');
    expect(res.imageBase64).toBeUndefined();
  });

  it('refuses a click with no selector and a type with no text before touching the tool', async () => {
    withPage(toolResult([]));
    expect((await handleBrowserRequest({ action: 'click' })).error).toContain('needs a selector');
    expect((await handleBrowserRequest({ action: 'type', selector: '#q' })).error).toContain('needs text');
    expect(fake.invokeCalls).toEqual([]);
  });
});

describe('a refused open is an answer, not an obstacle', () => {
  // On 1.132.0 `open_browser_page` carries confirmationMessages, and the
  // no-chat-context branch of invokeTool raises the modal itself and THROWS
  // when it is declined. The bridge used to swallow that and run the open
  // COMMAND, putting the very url the user had just refused on screen while
  // answering ok:true. The consent surface is worth more than the convenience.
  it('does not open the url by command when the tool call is refused', async () => {
    fake.tools = [{ name: 'open_browser_page' }];
    fake.commands = ['workbench.browser.open'];
    fake.invokeThrows = 'Canceled';
    const res = await handleBrowserRequest({ action: 'open', url: 'https://refused.test/' });
    expect(res.ok).toBe(false);
    expect(fake.executed).toEqual([]);
  });

  it('falls through to the open command when the tool throws a timeout (not a cancellation)', async () => {
    fake.tools = [{ name: 'open_browser_page' }];
    fake.commands = ['workbench.browser.open'];
    fake.invokeThrows = 'Navigation to https://slow.test/ timed out after 30000 ms';
    const res = await handleBrowserRequest({ action: 'open', url: 'https://slow.test/' });
    expect(res.ok).toBe(true);
    expect(fake.executed).toEqual([['workbench.browser.open', 'https://slow.test/', { preserveFocus: true }]]);
  });

  it('still uses the open command on a build that publishes no open tool', async () => {
    fake.tools = [];
    fake.commands = ['workbench.browser.open'];
    const res = await handleBrowserRequest({ action: 'open', url: 'https://ok.test/' });
    expect(res.ok).toBe(true);
    expect(fake.executed).toEqual([['workbench.browser.open', 'https://ok.test/', { preserveFocus: true }]]);
  });
});

// t-kgswmj round 3 — the two rungs added below the retry, end to end through
// the real handler. Round 2 shipped the retry and the live UAT still failed:
// the narrowed retry RESOLVED an element and it still never became actionable,
// which ruled the selector out and left the page's own editor tab. These cover
// the reveal that answers that, and the forced click that answers what a reveal
// cannot.
describe('a click against a page that is not on screen', () => {
  /** The round-2 live failure, verbatim. */
  const UNACTIONABLE = `locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('#submit')
  -   locator resolved to <input checked type="checkbox" id="submit">
  - attempting click action
  -   waiting for element to be visible, enabled and stable`;

  /** The `xmi` shape: the error is a text part AHEAD of the summary. */
  const clickFailed = { content: [{ value: UNACTIONABLE }, { value: 'Clicked the element matching #submit.' }] };

  function hiddenPage(extra: Record<string, unknown> = {}) {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      list_browser_pages: pageList([{ id: 'bg-1', title: 'App', url: 'https://app.test/', state: 'not visible' }]),
      click_element: clickFailed,
      ...extra,
    };
  }

  it('brings the page forward first, on its own editor resource', async () => {
    hiddenPage();
    await handleBrowserRequest({ action: 'click', selector: '#submit' });
    expect(fake.executed).toHaveLength(1);
    expect(fake.executed[0][0]).toBe('vscode.open');
    expect((fake.executed[0][1] as { toString(): string }).toString()).toBe('vscode-browser:/bg-1');
  });

  it('and the failure says where the page WAS, which is what two rounds did not know', async () => {
    hiddenPage();
    const res = await handleBrowserRequest({ action: 'click', selector: '#submit' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('was listed as "not visible", so it was brought to the front');
  });

  it('with global auto-approve ON, the last attempt is a forced click', async () => {
    fake.autoApprove = true;
    hiddenPage({
      run_playwright_code: {
        content: [{ value: 'Result: "forced click dispatched"' }, { value: 'Ran Playwright code.' }],
      },
    });
    const res = await handleBrowserRequest({ action: 'click', selector: '#submit' });
    const forced = fake.invokeCalls.find((c) => c.name === 'run_playwright_code');
    expect(String((forced?.input as { code: string })?.code)).toContain('force: true');
    expect(res.ok).toBe(true);
    // and it never passes a forced click off as an ordinary one
    expect(String(res.pageText)).toContain('force option');
    expect(String(res.pageText)).toContain('SKIPPED');
  });

  it('with it OFF, no Playwright code runs at all and the failure says why', async () => {
    hiddenPage({
      run_playwright_code: {
        content: [{ value: 'Result: "forced click dispatched"' }, { value: 'Ran Playwright code.' }],
      },
    });
    const res = await handleBrowserRequest({ action: 'click', selector: '#submit' });
    expect(fake.invokeCalls.some((c) => c.name === 'run_playwright_code')).toBe(false);
    expect(String(res.error)).toContain('chat.tools.global.autoApprove');
  });

  it('a page already on screen is not revealed, and its failure rules the container out', async () => {
    withPage(clickFailed);
    const res = await handleBrowserRequest({ action: 'click', selector: '#submit' });
    expect(fake.executed).toEqual([]);
    expect(String(res.error)).toContain('already on screen (VS Code listed it as "active")');
  });
});

// The four verbs mapped against the 1.133.0 schemas. Each is asserted on the
// four things that can happen to ANY driven verb, because the last time verbs
// shipped here only the happy path was covered and every one of them was dead.
describe('every driven verb answers the same four ways', () => {
  /** The `IT`/`cfi` shape hover, drag and raw share with click: Playwright's
   *  throw arrives as a text part AHEAD of the summary, with no error flag. */
  const PLAYWRIGHT_FAILED = (message: string) =>
    toolResult([{ value: message }, { value: '- Page URL: https://x.test/' }]);

  for (const [request, tool] of DRIVEN) {
    const action = request.action;

    it(`"${action}" succeeds only after ${tool} answered without a failure`, async () => {
      fake.autoApprove = true;
      withPage(toolResult([{ value: 'done' }, { data: PNG_BYTES, mimeType: 'image/png' }]));
      const res = await handleBrowserRequest(request);
      expect(res.ok).toBe(true);
    });

    it(`"${action}" reports VS Code's own failure text instead of painting it green`, async () => {
      fake.autoApprove = true;
      // A `Nm(msg)` refusal: every one of these tools can answer with one, and
      // it arrives as toolResultError -> hasError across the ext-host hop.
      const message = `No browser page found with ID page-1 (${action})`;
      withPage({ content: [{ value: message }], hasError: true });
      const res = await handleBrowserRequest(request);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain(message);
      expect(res.pageText ?? '').not.toContain(message);
    });

    it(`"${action}" says NO PAGE rather than driving a tool with no page id`, async () => {
      fake.autoApprove = true;
      fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
      fake.invokeResults = { list_browser_pages: pageList([]) };
      const res = await handleBrowserRequest(request);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('No page is open');
      expect(drivenCall()).toBeUndefined();
    });

    it(`"${action}" blames the reduced registration, and names the setting, when the tool is absent`, async () => {
      fake.autoApprove = true;
      fake.tools = REDUCED_TOOLS.map((name) => ({ name }));
      const res = await handleBrowserRequest(request);
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain(tool);
      expect(String(res.error)).toContain('workbench.browser.enableChatTools');
      expect(fake.invokeCalls).toEqual([]);
    });
  }

  it('reads a Playwright throw inside hover, drag and raw as the failure it is', async () => {
    // hover_element and drag_element go through the same `IT` helper as click,
    // and run_playwright_code builds its reply with the same `cfi` — so all
    // three can fail with NEITHER the error flag nor a place in the summary.
    // Reading only the structured signal would have called each of them a
    // success, which is the exact defect that shipped the first time.
    const cases: [Parameters<typeof handleBrowserRequest>[0], string][] = [
      [{ action: 'hover', selector: '#gone' }, "locator.hover: Timeout 10000ms exceeded."],
      [{ action: 'drag', selector: '#a', toSelector: '#gone' }, 'locator.dragTo: Timeout 10000ms exceeded.'],
      [{ action: 'raw', code: 'return page.title()' }, 'page.title: Target page closed'],
    ];
    for (const [request, message] of cases) {
      fake.autoApprove = true;
      fake.invokeCalls = [];
      withPage(PLAYWRIGHT_FAILED(message));
      const res = await handleBrowserRequest(request);
      expect(res.ok, request.action).toBe(false);
      expect(String(res.error)).toContain(message);
    }
  });

  it('refuses each verb that is missing an argument before touching a tool', async () => {
    withPage(toolResult([]));
    const cases: [Parameters<typeof handleBrowserRequest>[0], string][] = [
      [{ action: 'hover' }, 'needs a selector'],
      [{ action: 'drag', toSelector: '#bin' }, 'needs a selector'],
      [{ action: 'drag', selector: '#card' }, 'needs a toSelector'],
      [{ action: 'dialog' }, 'needs accept'],
      [{ action: 'raw' }, 'needs code'],
      [{ action: 'type' }, 'needs a selector'],
    ];
    for (const [request, said] of cases) {
      const res = await handleBrowserRequest(request);
      expect(res.ok, request.action).toBe(false);
      expect(String(res.error), request.action).toContain(said);
    }
    expect(fake.invokeCalls).toEqual([]);
  });

  it('lets a key stand in for the text a type would otherwise owe', async () => {
    // The one argument rule the new field changes: `text` is owed by typing, not
    // by pressing, and an EMPTY text with a key is a keypress rather than the
    // clear-the-field that VS Code refuses.
    withPage(toolResult([]));
    expect((await handleBrowserRequest({ action: 'type', key: 'Enter' })).ok).toBe(true);
    fake.invokeCalls = [];
    withPage(toolResult([]));
    expect((await handleBrowserRequest({ action: 'type', selector: '#q', text: '', key: 'Enter' })).ok).toBe(true);
  });
});

describe('raw is code execution, and is gated as code execution', () => {
  it('runs NOTHING when global auto-approve is off, and names the setting', async () => {
    // Same gate as the forced click, for the same reason: with the setting off
    // VS Code raises a modal of its own, and nobody is necessarily there to
    // answer it — the turn would sit behind the dialog until it timed out.
    withPage(toolResult([{ value: 'Result: "Origami"' }]));
    const res = await handleBrowserRequest({ action: 'raw', code: 'return page.title()' });
    expect(res.ok).toBe(false);
    expect(fake.invokeCalls).toEqual([]);
    expect(String(res.error)).toContain('chat.tools.global.autoApprove');
  });

  it('reports a DISMISSED confirmation as a snippet that did not run', async () => {
    // The residual the setting cannot suppress: VS Code raises its one-time
    // opt-in warning, and declining it throws a cancellation. Reported as the
    // refusal it is — the alternative was "the browser failed to raw: Canceled".
    fake.autoApprove = true;
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: oneSharedPage() };
    fake.invokeThrows = 'Canceled';
    const res = await handleBrowserRequest({ action: 'raw', code: 'return 1' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('dismissed');
    expect(String(res.error)).toContain('did not run');
  });

  it('brings the value the snippet RETURNED back as page text', async () => {
    fake.autoApprove = true;
    withPage(toolResult([{ value: 'Result: "Origami"' }, { value: 'Ran Playwright code.' }]));
    const res = await handleBrowserRequest({ action: 'raw', code: 'return page.title()' });
    expect(res.ok).toBe(true);
    expect(String(res.pageText)).toContain('Result: "Origami"');
  });
});

// ---------------------------------------------------------------------------
// The browser page stops STEALING THE CURSOR, and starts sending pictures back.
//
// Both halves answer the same complaint: the agent's page has to be laid out to
// be driven at all (browserPage.ts), the reveal that lays it out used to take
// the user's focus with it, and a page that is laid out but never looked at is
// a page the user cannot follow. So the reveal goes quiet and the frames come
// to the chat instead.
// ---------------------------------------------------------------------------

describe('the reveal lays the page out without taking the cursor', () => {
  /** A page VS Code lists as backgrounded, which is the only state that reveals. */
  function hidden(extra: Record<string, unknown> = {}) {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      list_browser_pages: pageList([{ id: 'bg-1', title: 'App', url: 'https://app.test/', state: 'not visible' }]),
      read_page: toolResult([{ value: 'Page summary.' }]),
      ...extra,
    };
  }

  it('reveals through _workbench.open with preserveFocus when the build has it', async () => {
    // `vscode.open`'s own handler on 1.136.1 is `(accessor, e) => execute(
    // "_workbench.open", e)` — one argument in, one forwarded — so options
    // handed to the PUBLIC command are dropped before an editor ever sees them.
    // The internal one takes `[column, options]`; an undefined column is the
    // active group, which is where the page already is.
    fake.commands = ['_workbench.open'];
    hidden();
    await handleBrowserRequest({ action: 'read' });
    expect(fake.executed).toHaveLength(1);
    expect(fake.executed[0][0]).toBe('_workbench.open');
    expect((fake.executed[0][1] as { toString(): string }).toString()).toBe('vscode-browser:/bg-1');
    expect(fake.executed[0][2]).toEqual([undefined, { preserveFocus: true }]);
  });

  it('still reveals on a build without it — the page must be laid out either way', async () => {
    // The documented gap: `vscode.open` reveals, and the focus moves. A page
    // that is not revealed cannot be clicked at all, so the reveal wins.
    fake.commands = ['git.clone'];
    hidden();
    await handleBrowserRequest({ action: 'read' });
    expect(fake.executed[0][0]).toBe('vscode.open');
    expect((fake.executed[0][1] as { toString(): string }).toString()).toBe('vscode-browser:/bg-1');
  });

  it('does not reveal a page that is already on screen', async () => {
    fake.commands = ['_workbench.open'];
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: oneSharedPage(), read_page: toolResult([{ value: 'Summary.' }]) };
    await handleBrowserRequest({ action: 'read' });
    expect(fake.executed).toEqual([]);
  });
});

describe('the open command is asked to preserve focus, and the cursor is put back if it did not', () => {
  it('passes preserveFocus to whichever open command the build registered', async () => {
    fake.commands = ['simpleBrowser.show'];
    await handleBrowserRequest({ action: 'open', url: 'https://a.test/' });
    expect(fake.executed).toEqual([['simpleBrowser.show', 'https://a.test/', { preserveFocus: true }]]);
  });

  it('restores the editor the user was in when the command took focus anyway', async () => {
    // 1.136.1's `simpleBrowser.show` is `registerCommand(id, async e => …)` —
    // one parameter — so the option is dropped and its webview panel is built
    // with a preserveFocus it was never given. This is the fallback for that.
    const editor = { document: { uri: 'file:///a.ts' }, viewColumn: 1 };
    fake.activeEditor = editor;
    fake.commands = ['simpleBrowser.show'];
    fake.executeCallback = () => {
      fake.activeEditor = { document: { uri: 'browser' }, viewColumn: 2 };
    };
    await handleBrowserRequest({ action: 'open', url: 'https://a.test/' });
    expect(fake.shown).toEqual([[editor.document, 1]]);
  });

  it('does NOT move the cursor when the command left it where it was', async () => {
    // A command that honoured preserveFocus must not be answered with a focus
    // move of our own — that would be the same theft, from the other side.
    fake.activeEditor = { document: { uri: 'file:///a.ts' }, viewColumn: 1 };
    fake.commands = ['simpleBrowser.show'];
    await handleBrowserRequest({ action: 'open', url: 'https://a.test/' });
    expect(fake.shown).toEqual([]);
  });
});

describe('every answered browser request sends the pane a picture', () => {
  /** The frames the host would post. */
  function sink() {
    const posted: Record<string, unknown>[] = [];
    return { posted, take: (s: Record<string, unknown>) => posted.push(s) };
  }

  const IMAGE = toolResult([{ data: PNG_BYTES, mimeType: 'image/png' }]);
  const B64 = Buffer.from(PNG_BYTES).toString('base64');

  function shared(extra: Record<string, unknown>) {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: oneSharedPage(), ...extra };
  }

  it('posts the frame straight away when the verb ITSELF answered with an image', async () => {
    shared({ screenshot_page: IMAGE });
    const s = sink();
    const res = await handleBrowserExtMethod({ action: 'screenshot', url: 'https://a.test/' }, s.take);
    expect(res.ok).toBe(true);
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0]).toMatchObject({
      action: 'screenshot',
      url: 'https://a.test/',
      imageDataUrl: `data:image/png;base64,${B64}`,
    });
    expect(typeof s.posted[0].ts).toBe('number');
    // No second tool call: there was already a picture to send.
    expect(fake.invokeCalls.filter((c) => c.name === 'screenshot_page')).toHaveLength(1);
  });

  it('chases a screenshot when the verb answered with TEXT, and posts it when it lands', async () => {
    // A click and a type answer in prose; only `screenshot` returns bytes. The
    // strip would otherwise stay on whatever the last screenshot verb produced.
    shared({ click_element: toolResult([{ value: 'Clicked the element matching #go.' }]), screenshot_page: IMAGE });
    const s = sink();
    const res = await handleBrowserExtMethod({ action: 'click', selector: '#go' }, s.take);
    expect(res.ok).toBe(true);
    // Fire and forget: the answer is back BEFORE the picture is.
    expect(s.posted).toEqual([]);
    await vi.waitFor(() => expect(s.posted).toHaveLength(1));
    expect(s.posted[0]).toMatchObject({
      // The ORIGINAL verb, not the screenshot that fetched the bytes — the
      // caption reads as what the agent just did.
      action: 'click',
      imageDataUrl: `data:image/png;base64,${B64}`,
    });
    expect(String(s.posted[0].pageText)).toContain('Clicked the element matching #go.');
  });

  it('a screenshot that FAILS posts nothing and leaves the answer alone', async () => {
    // Silence is the design: the pane keeps the frame it has, which is honest
    // for a strip whose claim is "the last page I could see".
    shared({
      click_element: toolResult([{ value: 'Clicked the element matching #go.' }]),
      screenshot_page: toolResult([{ value: 'No page is open.' }]),
    });
    const s = sink();
    const res = await handleBrowserExtMethod({ action: 'click', selector: '#go' }, s.take);
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(fake.invokeCalls.some((c) => c.name === 'screenshot_page')).toBe(true));
    expect(s.posted).toEqual([]);
  });

  it('a screenshot that THROWS does not reject the request that triggered it', async () => {
    shared({ click_element: toolResult([{ value: 'Clicked it.' }]) });
    const s = sink();
    // The list resolves from invokeResults; everything else throws.
    fake.invokeThrows = undefined;
    const res = await handleBrowserExtMethod({ action: 'click', selector: '#go' }, s.take);
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(fake.invokeCalls.some((c) => c.name === 'screenshot_page')).toBe(true));
    expect(s.posted).toEqual([]);
  });

  it('a FAILED verb sends no frame — there is no page state worth showing', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = { list_browser_pages: pageList([]), screenshot_page: IMAGE };
    const s = sink();
    const res = await handleBrowserExtMethod({ action: 'click', selector: '#gone' }, s.take);
    expect(res.ok).toBe(false);
    await Promise.resolve();
    expect(s.posted).toEqual([]);
  });

  it('`probe` sends no frame and chases no screenshot — it opens nothing', async () => {
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.commands = ['simpleBrowser.show'];
    const s = sink();
    const res = await handleBrowserExtMethod({ action: 'probe' }, s.take);
    expect(res.ok).toBe(true);
    await Promise.resolve();
    expect(s.posted).toEqual([]);
    expect(fake.invokeCalls).toEqual([]);
  });

  it('cuts the page text at 2 KB — the pane draws a caption, not a document', async () => {
    // A `read` answers with the whole accessibility snapshot, which runs to
    // tens of kilobytes. Every byte past the cap is postMessage traffic for
    // text nobody reads under a 96px thumbnail. Cut, never summarised.
    shared({ read_page: toolResult([{ value: 'x'.repeat(5000) }]), screenshot_page: IMAGE });
    const s = sink();
    await handleBrowserExtMethod({ action: 'read' }, s.take);
    await vi.waitFor(() => expect(s.posted).toHaveLength(1));
    const text = String(s.posted[0].pageText);
    expect(text.length).toBe(PAGE_TEXT_CAP + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('answers exactly as before when the host wants no frames at all', async () => {
    shared({ click_element: toolResult([{ value: 'Clicked it.' }]), screenshot_page: IMAGE });
    const res = await handleBrowserExtMethod({ action: 'click', selector: '#go' });
    expect(res.ok).toBe(true);
    expect(fake.invokeCalls.some((c) => c.name === 'screenshot_page')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// t-ntmm93 — the page viewport a capture is taken at.
//
// The embedded tab is whatever size the user left it, and `screenshot_page`'s
// inputSchema (VS Code 1.138.0: pageId, ref, selector, element,
// scrollIntoViewIfNeeded) carries no size, so the ONLY way a capture is not at
// tab size is to resize the page first. These pin that the resize happens, that
// it happens BEFORE the capture, and that the answer says which size was used —
// a picture that silently came back at 584x311 while the model believed it was
// 1920x1080 is the defect this exists to prevent.
describe('screenshot — the configured page viewport, not the tab size', () => {
  function shotWithViewport(measured: string) {
    fake.autoApprove = true;
    fake.tools = SHIPPED_TOOLS.map((name) => ({ name }));
    fake.invokeResults = {
      list_browser_pages: oneSharedPage(),
      run_playwright_code: toolResult([{ value: `Result: ${JSON.stringify(measured)}` }, { value: 'Ran.' }]),
      screenshot_page: toolResult([{ data: PNG_BYTES, mimeType: 'image/png' }]),
    };
    fake.invokeResult = toolResult([{ value: 'unused' }]);
  }

  it('resizes the page BEFORE it captures, through the one seam VS Code leaves open', async () => {
    shotWithViewport('1920x1080');
    await handleBrowserRequest({ action: 'screenshot' });
    const order = fake.invokeCalls.map((c) => c.name);
    expect(order.indexOf('run_playwright_code')).toBeLessThan(order.indexOf('screenshot_page'));
    expect(viewportSnippetOf(fake.invokeCalls.find((c) => c.name === 'run_playwright_code')?.input)).toContain(
      'width: 1920, height: 1080',
    );
  });

  it('returns the image AND a sentence naming the viewport it was taken at', async () => {
    shotWithViewport('1920x1080');
    const res = await handleBrowserRequest({ action: 'screenshot' });
    expect(res.ok).toBe(true);
    expect(res.imageBase64).toBeTruthy();
    expect(res.pageText).toContain('1920x1080');
  });

  it('says the capture is at TAB size when the page disagrees, rather than claiming the setting', async () => {
    shotWithViewport('584x311');
    const res = await handleBrowserRequest({ action: 'screenshot' });
    expect(res.ok).toBe(true);
    expect(res.pageText).toContain('584x311');
    expect(res.pageText).not.toContain('Captured at a 1920x1080');
  });

  it('never resizes for an ELEMENT capture — that crop is relative to the live viewport', async () => {
    shotWithViewport('1920x1080');
    await handleBrowserRequest({ action: 'screenshot', selector: '#chart' });
    expect(fake.invokeCalls.some((c) => c.name === 'run_playwright_code')).toBe(false);
  });

  it('still captures when the resize is barred, and says why', async () => {
    shotWithViewport('1920x1080');
    fake.autoApprove = false;
    const res = await handleBrowserRequest({ action: 'screenshot' });
    expect(res.ok).toBe(true);
    expect(res.imageBase64).toBeTruthy();
    expect(fake.invokeCalls.some((c) => c.name === 'run_playwright_code')).toBe(false);
    expect(res.pageText).toContain('chat.tools.global.autoApprove');
  });
});

describe('the reveal policy, end to end through the bridge (t-qcwpyy)', () => {
  it('an OPEN counts as the one reveal, so the next verb never moves the tab', async () => {
    // The whole point of the ticket, on the real handler: VS Code's own
    // `open_browser_page` puts the tab on screen and answers with the page id.
    // Under the default policy that id has now had its reveal, so the screenshot
    // that follows must issue no `vscode.open` even though the page has drifted
    // to "not visible" behind whatever the user opened next.
    fake.tools = [{ name: 'open_browser_page' }, { name: 'list_browser_pages' }, { name: 'screenshot_page' }];
    fake.invokeResults = {
      open_browser_page: toolResult([{ value: 'Page ID: page-7\n\nSummary:\n' }]),
    };
    const opened = await handleBrowserRequest({ action: 'open', url: 'https://a.test' });
    expect(opened.ok).toBe(true);

    fake.invokeResults = {
      list_browser_pages: pageList([
        { id: 'page-7', title: 'Origami', url: 'https://a.test/', state: 'not visible' },
      ]),
      screenshot_page: toolResult([{ value: 'shot' }, { mimeType: 'image/png', data: 'AAA' }]),
    };
    const shot = await handleBrowserRequest({ action: 'screenshot' });
    expect(shot.ok).toBe(true);
    // The strip is fed from this field (browserSnapshot.ts), so a background tab
    // must not cost the picture: 'AAA' arrives base64-encoded, as it always has.
    expect(shot.imageBase64, 'the screenshot still reaches the chat strip').toBe('QUFB');
    expect(fake.executed, 'the screenshot revealed the browser tab').toEqual([]);
  });
});
