// artifactsOpen.test.ts — Open, then Open again, on the same artifact.
//
// THE FIXTURES ARE VS CODE'S OWN, taken from the same 1.132.0 bundle reading
// that browserPage.test.ts documents:
//
//   `open_browser_page` answers `Page ID: <id>` and then the page summary;
//   `list_browser_pages` prints `- [<id>] <title> (<url>) (active|visible|not visible)`;
//   the reveal target is `URI.from({scheme: 'vscode-browser', path: '/' + id})`,
//   and the browser editor is registered `exclusive` + `singlePerResource`, so
//   `vscode.open` on that uri reveals the tab it already has.
//
// The bug this file exists to catch is a SECOND TAB: every artifact url shares
// the host `127.0.0.1:<port>`, so VS Code's own "a similar page is already
// shared" logic would happily hand back the tab of a different artifact, and a
// second `open_browser_page` call would stack a second tab of the same one.
// The assertions are therefore on WHICH tool ran, and on the uri revealed.

import { describe, expect, it, beforeEach, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({
  fake: {
    invoked: [] as { name: string; input: unknown }[],
    executed: [] as unknown[][],
    commands: [] as string[],
    tools: [] as string[],
    /** name -> the tool result, or a thrown error. */
    results: {} as Record<string, unknown>,
    throws: {} as Record<string, Error | undefined>,
  },
}));

vi.mock('vscode', () => ({
  Uri: {
    from: (c: { scheme: string; path: string }) => ({
      scheme: c.scheme,
      path: c.path,
      toString: () => `${c.scheme}:${c.path}`,
    }),
    file: (p: string) => ({ toString: () => `file://${p}` }),
  },
  commands: {
    getCommands: async () => fake.commands,
    executeCommand: async (...args: unknown[]) => {
      fake.executed.push(args);
    },
  },
  window: { activeTextEditor: undefined, showTextDocument: async () => undefined },
  workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined, update: async () => undefined }) },
  lm: {
    get tools() {
      return fake.tools.map((name) => ({ name }));
    },
    invokeTool: async (name: string, options: { input: unknown }) => {
      fake.invoked.push({ name, input: options.input });
      const thrown = fake.throws[name];
      if (thrown) throw thrown;
      return fake.results[name];
    },
  },
}));

import { openArtifactUrl, resetOpenedArtifacts } from '../../../src/artifactsOpen';

const URL_ONE = 'http://127.0.0.1:4096/artifact/tok-one/index.html';
const URL_TWO = 'http://127.0.0.1:4096/artifact/tok-two/index.html';

/** A tool answer in the shape `readToolResult` reads. */
const said = (text: string) => ({ content: [{ value: text }] });

/** `open_browser_page`'s answer, verbatim in shape. */
const opened = (pageId: string) => said(`Page ID: ${pageId}\nThe page loaded.`);

/** `list_browser_pages`' answer, in VS Code's line format. */
const listed = (pages: { id: string; url: string; state: string }[]) =>
  said(
    ['The following browser pages are currently shared with you:']
      .concat(pages.map((page) => `  - [${page.id}] A page (${page.url}) (${page.state})`))
      .join('\n'),
  );

const FULL_TOOLS = ['open_browser_page', 'list_browser_pages', 'read_page'];

beforeEach(() => {
  fake.invoked = [];
  fake.executed = [];
  fake.commands = ['_workbench.open', 'workbench.browser.open'];
  fake.tools = [...FULL_TOOLS];
  fake.results = {};
  fake.throws = {};
  resetOpenedArtifacts();
});

const toolNames = () => fake.invoked.map((call) => call.name);

describe('opening an artifact twice', () => {
  it('opens a tab the first time and REVEALS that same tab the second', async () => {
    fake.results['open_browser_page'] = opened('page-1');
    await openArtifactUrl(URL_ONE);
    expect(toolNames()).toEqual(['open_browser_page']);
    expect(fake.invoked[0].input).toEqual({ url: URL_ONE });
    // Nothing is revealed on the first open: VS Code's own open put it on screen.
    expect(fake.executed).toEqual([]);

    fake.results['list_browser_pages'] = listed([{ id: 'page-1', url: URL_ONE, state: 'not visible' }]);
    await openArtifactUrl(URL_ONE);
    // The list is consulted, and NO second open is made.
    expect(toolNames()).toEqual(['open_browser_page', 'list_browser_pages']);
    expect(fake.executed).toHaveLength(1);
    const [command, uri] = fake.executed[0] as [string, { toString(): string }];
    expect(command).toBe('_workbench.open');
    expect(String(uri)).toBe('vscode-browser:/page-1');
  });

  it('opens a SECOND tab for a different artifact rather than revealing the first', async () => {
    fake.results['open_browser_page'] = opened('page-1');
    await openArtifactUrl(URL_ONE);
    fake.results['open_browser_page'] = opened('page-2');
    fake.results['list_browser_pages'] = listed([{ id: 'page-1', url: URL_ONE, state: 'active' }]);
    await openArtifactUrl(URL_TWO);
    expect(toolNames()).toEqual(['open_browser_page', 'open_browser_page']);
    expect(fake.invoked[1].input).toEqual({ url: URL_TWO });
    expect(fake.executed).toEqual([]);
  });

  it('opens again when the user closed the tab, instead of revealing an id VS Code no longer has', async () => {
    fake.results['open_browser_page'] = opened('page-1');
    await openArtifactUrl(URL_ONE);
    // The tab is gone: the list no longer carries it. Revealing it would open
    // a BLANK page (getOrCreateLazy), which is the failure this guards.
    fake.results['list_browser_pages'] = listed([]);
    fake.results['open_browser_page'] = opened('page-9');
    await openArtifactUrl(URL_ONE);
    expect(toolNames()).toEqual(['open_browser_page', 'list_browser_pages', 'open_browser_page']);
    expect(fake.executed).toEqual([]);
  });
});

describe('the builds that publish less', () => {
  it('falls back to the open COMMAND when there is no open tool, and does not pretend to know the page', async () => {
    fake.tools = [];
    await openArtifactUrl(URL_ONE);
    expect(toolNames()).toEqual([]);
    expect(fake.executed[0]).toEqual(['workbench.browser.open', URL_ONE, { preserveFocus: true }]);
    // A command open answers with no page id, so the next click opens again
    // rather than revealing something it never learned.
    await openArtifactUrl(URL_ONE);
    expect(fake.executed).toHaveLength(2);
  });

  it('opens by command when the tool FAILED, and throws when neither exists', async () => {
    fake.throws['open_browser_page'] = new Error('tool exploded');
    await openArtifactUrl(URL_ONE);
    expect(fake.executed[0]?.[0]).toBe('workbench.browser.open');

    fake.tools = [];
    fake.commands = [];
    await expect(openArtifactUrl(URL_ONE)).rejects.toThrow(/no way to open a page/);
  });

  it('does NOT open by command after the user declined the share modal', async () => {
    const cancelled = new Error('Canceled');
    cancelled.name = 'Canceled';
    fake.throws['open_browser_page'] = cancelled;
    await expect(openArtifactUrl(URL_ONE)).rejects.toThrow('Canceled');
    // The url the user just refused must not appear on screen anyway.
    expect(fake.executed).toEqual([]);
  });

  it('reveals nothing it cannot verify: with no list tool a second open is a fresh open', async () => {
    fake.tools = ['open_browser_page'];
    fake.results['open_browser_page'] = opened('page-1');
    await openArtifactUrl(URL_ONE);
    await openArtifactUrl(URL_ONE);
    expect(toolNames()).toEqual(['open_browser_page', 'open_browser_page']);
    expect(fake.executed).toEqual([]);
  });
});
