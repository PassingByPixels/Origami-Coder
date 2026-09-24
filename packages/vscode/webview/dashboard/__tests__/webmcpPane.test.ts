// webmcpPane.test.ts — the Web MCP section, all three halves.
//
// Store (src/dashboard/webmcpFile.ts): the merge rule. This file is written by
// the ENGINE too (webmcp_launch stamps lastLaunched, webmcp_note writes notes),
// so the tests that matter most are the ones proving a rewrite here does not
// eat what the other writer put there.
//
// Host (src/dashboard/webmcpPane.ts): the four messages the section sends. A
// bad address must never reach the file — a stored row whose Open button cannot
// open anything looks registered and is not.
//
// Webview (components/WebMCPSection.svelte): that a site's purpose and its
// advisory notes are actually on screen, and that Remove needs a confirm.
// jsdom has no layout engine, so this asserts text and posted messages, never a
// computed style.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { fake } = vi.hoisted(() => ({ fake: { errors: [] as string[], opened: [] as string[] } }));

vi.mock('vscode', () => ({
  window: { showErrorMessage: (m: string) => void fake.errors.push(m) },
  env: { openExternal: (u: { toString(): string }) => void fake.opened.push(String(u)) },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));

import { WEBMCP_PANE_MESSAGE_TYPES, handleWebMcpPaneMessage } from '../../../src/dashboard/webmcpPane';
import {
  SITES_KEY,
  WEBMCP_FILE,
  dropSite,
  listSites,
  normalizeSiteUrl,
  sitesOf,
  upsertSite,
  webmcpFilePath,
} from '../../../src/dashboard/webmcpFile';
import WebMCPSection from '../components/WebMCPSection.svelte';
import WebMCPCard from '../components/WebMCPCard.svelte';
import MCPPane from '../panes/MCPPane.svelte';

// Every test that touches the filesystem points ORIGAMI_TEST_HOME at its own
// temp dir. The developer's real ~/.origami/webmcp.json is never read or
// written by this suite — the same rule repoCards.test.ts follows for repos.json.
let priorHome: string | undefined;
let home: string;

beforeEach(() => {
  priorHome = process.env.ORIGAMI_TEST_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-webmcp-vitest-'));
  process.env.ORIGAMI_TEST_HOME = home;
  fake.errors = [];
  fake.opened = [];
});

afterEach(() => {
  cleanup();
  if (priorHome === undefined) delete process.env.ORIGAMI_TEST_HOME;
  else process.env.ORIGAMI_TEST_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const seed = (doc: unknown) => {
  const file = webmcpFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
};

const readFile = () => JSON.parse(fs.readFileSync(webmcpFilePath(), 'utf8'));

const posts: Record<string, unknown>[] = [];
const host = { post: (m: Record<string, unknown>) => void posts.push(m) };
const lastPost = () => posts[posts.length - 1];

const FOLIO = { url: 'https://folio.example/mcp', name: 'folio', purpose: 'Origami Folio blocks', addedAt: 1 };

describe('normalizeSiteUrl — one address, one entry', () => {
  it('folds the ways of writing the same address, and refuses what a browser cannot join', () => {
    expect(normalizeSiteUrl('https://Example.com/')).toBe('https://example.com');
    expect(normalizeSiteUrl('  https://example.com  ')).toBe('https://example.com');
    expect(normalizeSiteUrl('https://example.com/#/mcp')).toBe('https://example.com/#/mcp');
    for (const bad of ['', '   ', undefined, 'folio', 'file:///c:/x.html', 'ftp://example.com'])
      expect(normalizeSiteUrl(bad)).toBeUndefined();
  });
});

describe('the merge rule — the engine writes this file too', () => {
  // THE LOAD-BEARING TEST. webmcp_note and webmcp_launch write fields this side
  // did not author; a rewrite that rebuilt entries from the shapes it knows
  // would delete them, which is the exact bug repos.json's merge rule exists for.
  it('preserves the engine-written fields and every unknown key on an upsert', () => {
    const doc = {
      version: 1,
      theme: 'dark',
      [SITES_KEY]: [{ ...FOLIO, notes: 'block_insert(text)', lastLaunched: 1756600000000, favourite: true }],
    };
    const after = upsertSite(doc, FOLIO.url, { purpose: 'renamed' });
    const entry = (after[SITES_KEY] as Record<string, unknown>[])[0];
    expect(entry.notes).toBe('block_insert(text)');
    expect(entry.lastLaunched).toBe(1756600000000);
    expect(entry.favourite).toBe(true);
    expect(entry.purpose).toBe('renamed');
    expect(after.theme).toBe('dark');
  });

  it('drops only the named entry, keeping the others and the unknown top-level keys', () => {
    const other = { url: 'https://notes.example/app', name: 'notes', purpose: '', addedAt: 2 };
    const after = dropSite({ version: 1, theme: 'dark', [SITES_KEY]: [FOLIO, other] }, FOLIO.url);
    expect((after[SITES_KEY] as { url: string }[]).map((s) => s.url)).toEqual([other.url]);
    expect(after.theme).toBe('dark');
  });

  it('matches an entry however its address was written, on either side of the compare', () => {
    const after = upsertSite({ version: 1, [SITES_KEY]: [{ url: 'https://Example.com/' }] }, 'https://example.com', {
      purpose: 'p',
    });
    expect(after[SITES_KEY]).toHaveLength(1);
    // The caller's url is normalised too, so a raw one cannot open a second row
    // for a site already listed — the engine's merge does the same.
    const raw = upsertSite({ version: 1, [SITES_KEY]: [{ url: 'https://example.com' }] }, 'https://Example.com/', {
      purpose: 'p',
    });
    expect(raw[SITES_KEY]).toHaveLength(1);
    // And a brand-new entry is STORED normalised, never as typed.
    const fresh = upsertSite(undefined, 'https://Example.com/', {});
    expect((fresh[SITES_KEY] as { url: string }[])[0].url).toBe('https://example.com');
  });

  it('leaves the document untouched for an address that cannot normalise', () => {
    const before = { version: 1, theme: 'dark', [SITES_KEY]: [FOLIO] };
    const after = upsertSite(before, 'not-a-url', { purpose: 'p' });
    expect(after[SITES_KEY]).toHaveLength(1);
    expect((after[SITES_KEY] as { url: string }[])[0].url).toBe(FOLIO.url);
    expect(after.theme).toBe('dark');
  });

  it('keeps a version it did not write, and stamps one when there is none', () => {
    expect(upsertSite({ version: 7, [SITES_KEY]: [] }, FOLIO.url, {}).version).toBe(7);
    expect(upsertSite(undefined, FOLIO.url, {}).version).toBe(1);
  });

  // A row no browser could open is worse than no row: it looks registered.
  it('hides an unopenable entry from the pane and names a nameless one by its host', () => {
    const sites = sitesOf({ [SITES_KEY]: [FOLIO, { url: 'file:///c:/x.html' }, { url: 'https://bare.example/' }] });
    expect(sites.map((s) => s.name)).toEqual(['folio', 'bare.example']);
  });

  it('reads a missing or corrupt file as no sites rather than throwing', () => {
    expect(listSites()).toEqual([]);
    seed('not-an-object');
    expect(listSites()).toEqual([]);
    fs.writeFileSync(webmcpFilePath(), '{ broken');
    expect(listSites()).toEqual([]);
  });
});

describe('the host — what reaches the file', () => {
  beforeEach(() => { posts.length = 0; });

  it('registers the five message types the section sends', () => {
    expect([...WEBMCP_PANE_MESSAGE_TYPES].sort()).toEqual([
      'webmcpAdd',
      'webmcpEdit',
      'webmcpOpen',
      'webmcpRemove',
      'webmcpRequest',
    ]);
  });

  it('answers a request with the list and the file path', () => {
    seed({ version: 1, [SITES_KEY]: [FOLIO] });
    handleWebMcpPaneMessage(host, { type: 'webmcpRequest' });
    expect(lastPost()).toMatchObject({ type: 'webmcpData', file: webmcpFilePath() });
    expect((lastPost().sites as { name: string }[]).map((s) => s.name)).toEqual(['folio']);
  });

  it('adds a site and re-reads afterwards, so the pane shows what the file holds', () => {
    handleWebMcpPaneMessage(host, {
      type: 'webmcpAdd',
      url: 'https://Folio.example/mcp',
      name: 'folio',
      purpose: 'blocks',
    });
    expect(fake.errors).toEqual([]);
    const entry = readFile()[SITES_KEY][0];
    // Stored NORMALISED, or the engine and this side would disagree on identity.
    expect(entry.url).toBe('https://folio.example/mcp');
    expect(entry).toMatchObject({ name: 'folio', purpose: 'blocks' });
    expect(typeof entry.addedAt).toBe('number');
    expect((lastPost().sites as unknown[]).length).toBe(1);
  });

  it('falls back to the host for a blank name', () => {
    handleWebMcpPaneMessage(host, { type: 'webmcpAdd', url: 'https://folio.example/mcp', name: '  ', purpose: '' });
    expect(readFile()[SITES_KEY][0].name).toBe('folio.example');
  });

  // The refusal that matters: an unopenable address must never be stored, and
  // the webview's own check is not trusted — a message is not a trusted input.
  it('refuses an address that is not http(s), and writes nothing', () => {
    for (const bad of ['folio', 'file:///c:/x.html', '', 'javascript:alert(1)'])
      handleWebMcpPaneMessage(host, { type: 'webmcpAdd', url: bad, name: 'x', purpose: 'y' });
    expect(fake.errors).toHaveLength(4);
    expect(fake.errors[0]).toContain('is not a web address');
    expect(fs.existsSync(webmcpFilePath())).toBe(false);
  });

  it('refuses a duplicate address, however it was written', () => {
    seed({ version: 1, [SITES_KEY]: [FOLIO] });
    handleWebMcpPaneMessage(host, { type: 'webmcpAdd', url: 'https://FOLIO.example/mcp', name: 'again', purpose: '' });
    expect(fake.errors[0]).toContain('already registered');
    expect(readFile()[SITES_KEY]).toHaveLength(1);
  });

  it('removes one site and leaves the rest', () => {
    const other = { url: 'https://notes.example/app', name: 'notes', purpose: '', addedAt: 2 };
    seed({ version: 1, [SITES_KEY]: [FOLIO, other] });
    handleWebMcpPaneMessage(host, { type: 'webmcpRemove', url: FOLIO.url });
    expect(readFile()[SITES_KEY].map((s: { url: string }) => s.url)).toEqual([other.url]);
    expect((lastPost().sites as unknown[]).length).toBe(1);
  });

  // EDIT WRITES `purpose`, WHICH IS WHAT THE MODEL READS. webmcp_list prints
  // every row as `- <name>  <url>` / `purpose: <text>` (engine, siteLines), so
  // these two fields ARE the site's description as far as an agent is concerned.
  it('rewrites the name and the purpose of the named site, and nothing else', () => {
    const other = { url: 'https://notes.example/app', name: 'notes', purpose: 'Scratch notes', addedAt: 2 };
    seed({ version: 1, [SITES_KEY]: [FOLIO, other] });
    handleWebMcpPaneMessage(host, {
      type: 'webmcpEdit',
      url: FOLIO.url,
      name: '  folio-deck  ',
      purpose: '  Build and save Origami decks from the browser  ',
    });
    const [edited, untouched] = readFile()[SITES_KEY];
    expect(edited.name).toBe('folio-deck');
    expect(edited.purpose).toBe('Build and save Origami decks from the browser');
    expect(edited.addedAt).toBe(FOLIO.addedAt);
    expect(untouched).toEqual(other);
    expect(fake.errors).toEqual([]);
    // The pane is re-rendered from the FILE, never from the message.
    expect((lastPost().sites as { purpose: string }[])[0].purpose).toBe(
      'Build and save Origami decks from the browser',
    );
  });

  // THE FIELD SPLIT. `notes` is the ENGINE's advisory memory (webmcp_note) and
  // `lastLaunched` its bookkeeping; a user rename that ate either would delete
  // what an earlier session learned on the page.
  it('leaves the engine-written notes, lastLaunched and every unknown key alone', () => {
    seed({
      version: 1,
      theme: 'dark',
      [SITES_KEY]: [{ ...FOLIO, notes: 'block_insert(text)', lastLaunched: 1756600000000, favourite: true }],
    });
    handleWebMcpPaneMessage(host, { type: 'webmcpEdit', url: FOLIO.url, name: 'folio', purpose: 'rewritten' });
    const after = readFile();
    expect(after[SITES_KEY][0]).toMatchObject({
      purpose: 'rewritten',
      notes: 'block_insert(text)',
      lastLaunched: 1756600000000,
      favourite: true,
    });
    expect(after.theme).toBe('dark');
  });

  // ORDER IS THE USER'S MENTAL INDEX of a fifty-site list. upsertSite replaces
  // in place; a rewrite that pushed the edited row to the end would shuffle the
  // grid under the cursor on every save.
  it('keeps the site order — an edited middle row stays where it was', () => {
    const mid = { url: 'https://notes.example/app', name: 'notes', purpose: 'b', addedAt: 2 };
    const last = { url: 'https://tickets.example/board', name: 'board', purpose: 'c', addedAt: 3 };
    seed({ version: 1, [SITES_KEY]: [FOLIO, mid, last] });
    handleWebMcpPaneMessage(host, { type: 'webmcpEdit', url: mid.url, name: 'notes', purpose: 'renamed' });
    expect(readFile()[SITES_KEY].map((x: { url: string }) => x.url)).toEqual([FOLIO.url, mid.url, last.url]);
    expect((lastPost().sites as { name: string }[]).map((x) => x.name)).toEqual(['folio', 'notes', 'board']);
  });

  // upsertSite CREATES what it cannot find — right for Add, wrong here. The
  // engine writes this file too, so a row can vanish between Edit and Save.
  it('refuses to resurrect a site that is no longer registered', () => {
    seed({ version: 1, [SITES_KEY]: [FOLIO] });
    handleWebMcpPaneMessage(host, { type: 'webmcpEdit', url: 'https://gone.example/mcp', name: 'gone', purpose: 'x' });
    expect(readFile()[SITES_KEY].map((x: { url: string }) => x.url)).toEqual([FOLIO.url]);
    expect(fake.errors.join(' ')).toContain('No Web MCP site is registered at');
    // Still re-posts, so the pane cannot sit on the row it thought it was editing.
    expect(lastPost().type).toBe('webmcpData');
  });

  it('falls back to the host when the edited name is blanked, never storing a nameless row', () => {
    seed({ version: 1, [SITES_KEY]: [FOLIO] });
    handleWebMcpPaneMessage(host, { type: 'webmcpEdit', url: FOLIO.url, name: '   ', purpose: 'p' });
    expect(readFile()[SITES_KEY][0].name).toBe('folio.example');
  });

  it('opens a site in the real browser — joining a WebMCP server IS opening its page', () => {
    handleWebMcpPaneMessage(host, { type: 'webmcpOpen', url: 'https://Folio.example/mcp' });
    expect(fake.opened).toEqual(['https://folio.example/mcp']);
  });

  it('never hands the OS an address that is not http(s)', () => {
    for (const bad of ['javascript:alert(1)', 'file:///c:/x.html', ''])
      handleWebMcpPaneMessage(host, { type: 'webmcpOpen', url: bad });
    expect(fake.opened).toEqual([]);
  });
});

describe('the section — what the user sees', () => {
  const sent = () => globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]);
  const data = (sites: unknown[]) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'webmcpData', sites, file: 'C:/h/webmcp.json' } }));

  it('shows each site with its purpose, address and the agent notes marked advisory', async () => {
    render(WebMCPSection);
    data([{ ...FOLIO, notes: 'block_insert(text)', lastLaunched: 1756600000000 }]);
    await tick();

    expect(document.body.textContent).toContain('folio');
    expect(document.body.textContent).toContain('Origami Folio blocks');
    expect(document.body.textContent).toContain('https://folio.example/mcp');
    expect(document.body.textContent).toContain('block_insert(text)');
    // The notes must never read as a contract — the page re-publishes its tools
    // on every join, so a stale note is normal, not a bug.
    expect(document.body.textContent).toContain('advisory');
  });

  it('says what a Web MCP site IS, so it is not read as another server row', async () => {
    render(WebMCPSection);
    data([]);
    await tick();
    expect(document.body.textContent).toContain('the page itself is the server');
    expect(document.body.textContent).toContain('No Web MCP sites yet');
  });

  it('posts an open carrying the address of the row the button belongs to', async () => {
    const { getByText } = render(WebMCPSection);
    data([FOLIO]);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(getByText('Open'));
    expect(sent()).toEqual([{ type: 'webmcpOpen', url: FOLIO.url }]);
  });

  it('needs a confirm before it removes a site, and posts nothing on the first click', async () => {
    const { getByText, queryByText } = render(WebMCPSection);
    data([FOLIO]);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    expect(queryByText('Confirm remove')).toBeNull();
    await fireEvent.click(getByText('Remove'));
    // One click ARMS it. A single-click remove on a hand-curated list is a lost
    // bookmark with no undo, so nothing may reach the host yet.
    expect(getByText('Confirm remove')).toBeTruthy();
    expect(sent()).toEqual([]);

    await fireEvent.click(getByText('Confirm remove'));
    expect(sent()).toEqual([{ type: 'webmcpRemove', url: FOLIO.url }]);
  });

  it('cancels an armed remove without posting', async () => {
    const { getByText, queryByText } = render(WebMCPSection);
    data([FOLIO]);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(getByText('Remove'));
    await fireEvent.click(getByText('Cancel'));
    expect(queryByText('Confirm remove')).toBeNull();
    expect(sent()).toEqual([]);
  });

  // WHAT EDIT IS FOR: rewriting the line the MODEL reads about a site. The
  // fields are the card's own name and purpose; the address is not offered,
  // because a different address is a different site.
  it('opens an inline editor seeded with the row it belongs to, and posts the rewritten fields', async () => {
    const { getByText, getByLabelText } = render(WebMCPSection);
    data([{ ...FOLIO, notes: 'block_insert(text)' }]);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(getByText('Edit'));
    // Seeded from the card, not blank — an edit is a rewrite, not a re-entry.
    expect((getByLabelText('Edit site name') as HTMLInputElement).value).toBe('folio');
    expect((getByLabelText('Edit site description') as HTMLTextAreaElement).value).toBe('Origami Folio blocks');
    // Nothing is posted by opening the editor.
    expect(sent()).toEqual([]);

    await fireEvent.input(getByLabelText('Edit site name'), { target: { value: ' folio-deck ' } });
    await fireEvent.input(getByLabelText('Edit site description'), {
      target: { value: ' Build and save Origami decks ' },
    });
    await tick();
    await fireEvent.click(getByText('Save'));

    expect(sent()).toEqual([
      { type: 'webmcpEdit', url: FOLIO.url, name: 'folio-deck', purpose: 'Build and save Origami decks' },
    ]);
  });

  it('closes the editor on the data the host re-reads, not on an optimistic guess', async () => {
    const { getByText, queryByLabelText } = render(WebMCPSection);
    data([FOLIO]);
    await tick();
    await fireEvent.click(getByText('Edit'));
    await fireEvent.click(getByText('Save'));
    await tick();
    // STILL OPEN: the file has not answered yet, and showing the old row as if
    // saved is the lie this rule exists to prevent.
    expect(queryByLabelText('Edit site description')).not.toBeNull();

    data([{ ...FOLIO, purpose: 'Build and save Origami decks' }]);
    await tick();
    expect(queryByLabelText('Edit site description')).toBeNull();
    expect(document.body.textContent).toContain('Build and save Origami decks');
  });

  it('cancels an edit without posting, leaving the card as it was', async () => {
    const { getByText, getByLabelText, queryByLabelText } = render(WebMCPSection);
    data([FOLIO]);
    await tick();
    await fireEvent.click(getByText('Edit'));
    await fireEvent.input(getByLabelText('Edit site description'), { target: { value: 'thrown away' } });
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(getByText('Cancel edit'));
    await tick();
    expect(queryByLabelText('Edit site description')).toBeNull();
    expect(sent()).toEqual([]);
    expect(document.body.textContent).toContain('Origami Folio blocks');
    expect(document.body.textContent).not.toContain('thrown away');
  });

  it('does not offer the address for editing — a new address is a new site', async () => {
    const { getByText, queryByLabelText } = render(WebMCPSection);
    data([FOLIO]);
    await tick();
    await fireEvent.click(getByText('Edit'));
    expect(queryByLabelText('Edit site address')).toBeNull();
    // The add form's own address box is a different control and stays reachable.
    expect(queryByLabelText('Web MCP site address')).not.toBeNull();
  });

  it('disables Add until the address is one a browser could open, and says why', async () => {
    const { getByLabelText, getByText } = render(WebMCPSection);
    data([]);
    await tick();

    expect((getByText('Add') as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.input(getByLabelText('Web MCP site address'), { target: { value: 'folio' } });
    await tick();
    expect((getByText('Add') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('is not a web address');

    await fireEvent.input(getByLabelText('Web MCP site address'), { target: { value: 'https://folio.example/mcp' } });
    await tick();
    expect((getByText('Add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the three fields the host needs, and clears the form', async () => {
    const { getByLabelText, getByText } = render(WebMCPSection);
    data([]);
    await tick();
    await fireEvent.input(getByLabelText('Web MCP site address'), { target: { value: ' https://folio.example/mcp ' } });
    await fireEvent.input(getByLabelText('Site name'), { target: { value: ' folio ' } });
    await fireEvent.input(getByLabelText('Site purpose'), { target: { value: ' blocks ' } });
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();

    await fireEvent.click(getByText('Add'));
    expect(sent()).toEqual([
      { type: 'webmcpAdd', url: 'https://folio.example/mcp', name: 'folio', purpose: 'blocks' },
    ]);
    // Cleared, or the next add starts pre-filled with the last one and the
    // duplicate refusal is the first thing the user meets.
    expect((getByLabelText('Web MCP site address') as HTMLInputElement).value).toBe('');
    expect((getByLabelText('Site purpose') as HTMLInputElement).value).toBe('');
  });
});

// --- the agent notes block scrolls, not the card ---------------------------
// OWNER REPORT: a card whose notes ran 20+ lines pushed the whole card, and
// the row it sat in, down the page. Spiked: this harness injects no <style>
// tag into jsdom at all (vite-plugin-svelte's scoped CSS never reaches this
// DOM), so getComputedStyle on `.wmcp-notes` returns nothing to assert on.
// The rule is read from the SOURCE instead — the same move
// "pins the form with a sticky rule" above already makes against the same
// file's cousin — and the real geometry is the Playwright pixel check
// described in the lane report, not part of this suite.
describe('the agent notes block caps at 8 lines and scrolls', () => {
  const cardSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'WebMCPCard.svelte'), 'utf8');
  const notesRule = cardSource
    .split('}')
    .find((block) => /\.wmcp-notes\s*\{/.test(block) && !block.includes('.wmcp-notes-label'));

  it('caps the box at 8 lines of its own line-height and scrolls the rest', () => {
    expect(notesRule).toBeDefined();
    expect(notesRule).toContain('overflow-y: auto');
    // Off the real line-height (1.45), not a guessed px figure, so a future
    // line-height change cannot silently detune the 8-line cap.
    expect(notesRule).toMatch(/max-height:\s*calc\(1\.45em\s*\*\s*8\)/);
  });

  const renderNotes = (lines: number) => {
    const notes = Array.from({ length: lines }, (_, i) => `note line ${i + 1}`).join('\n');
    const { container } = render(WebMCPCard, {
      props: { site: { ...FOLIO, notes }, onArm: () => {}, onEdit: () => {} },
    });
    return container.querySelector('.wmcp-notes');
  };

  it('a 30-line note carries the scroll box, in full — the cap is CSS overflow, not a JS truncation', () => {
    const el = renderNotes(30);
    expect(el).not.toBeNull();
    expect(el!.classList.contains('wmcp-notes')).toBe(true);
    expect(el!.textContent).toContain('note line 1');
    expect(el!.textContent).toContain('note line 30');
  });

  it('a 3-line note gets the same box, with nothing cut and no separate no-scroll variant', () => {
    const el = renderNotes(3);
    expect(el).not.toBeNull();
    expect(el!.classList.contains('wmcp-notes')).toBe(true);
    expect(el!.textContent).toContain('note line 1');
    expect(el!.textContent).toContain('note line 3');
  });
});

// --- uniform card size, whatever the description is ------------------------
// OWNER REPORT (t-d94cti): cards grew with the purpose text, so a fifty-site
// grid read as a ragged column of mismatched boxes instead of a scannable
// list. The Origami Folio card — a short, one-line purpose, no notes — is the
// reference size. jsdom has no layout engine (Part 6 of
// WORKING_ON_ORIGAMI_CODER.md; the same gap the notes-cap suite above notes),
// so this reads the clamp and min-height rules from the SOURCE, then proves
// through render that a 600-character purpose and a one-word purpose produce
// the SAME class and the same title attribute — the uniform height comes from
// the CSS clamp, not from any JS branch on length. Whether the two actually
// render at the same pixel height is a human-eye check, not part of this
// suite.
describe('WebMCP cards render at one fixed size, regardless of description length', () => {
  const cardSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'WebMCPCard.svelte'), 'utf8');
  const sectionSource = fs.readFileSync(path.join(__dirname, '..', 'components', 'WebMCPSection.svelte'), 'utf8');
  const ruleFor = (source: string, selector: RegExp) =>
    source.split('}').find((block) => selector.test(block));

  it('clamps the purpose to 2 lines and the name to 1, off the real line-height', () => {
    const purposeRule = ruleFor(cardSource, /\.wmcp-purpose\s*\{/);
    expect(purposeRule).toBeDefined();
    expect(purposeRule).toContain('-webkit-line-clamp: 2');
    expect(purposeRule).toContain('overflow: hidden');

    const nameRule = ruleFor(cardSource, /\.wmcp-name\s*\{/);
    expect(nameRule).toBeDefined();
    expect(nameRule).toContain('white-space: nowrap');
    expect(nameRule).toContain('text-overflow: ellipsis');
  });

  it('fixes the card at one min-height, derived from the Folio reference size', () => {
    const cardRule = ruleFor(cardSource, /\.wmcp-card\s*\{/);
    expect(cardRule).toBeDefined();
    expect(cardRule).toMatch(/min-height:\s*130px/);
  });

  it('fixes the grid columns to one width, not a flexible fr track', () => {
    const gridRule = ruleFor(sectionSource, /\.wmcp-grid\s*\{/);
    expect(gridRule).toBeDefined();
    // The declaration itself, not the block (the comment above it still
    // explains the OLD minmax(280px, 1fr) track it replaced, in prose).
    const declaration = gridRule!.slice(gridRule!.indexOf('grid-template-columns'));
    expect(declaration).toContain('grid-template-columns: repeat(auto-fill, 280px)');
    expect(declaration).not.toContain('minmax');
  });

  const render600 = () =>
    render(WebMCPCard, {
      props: {
        site: { ...FOLIO, purpose: 'x'.repeat(600) },
        onArm: () => {},
        onEdit: () => {},
      },
    });
  const renderOneWord = () =>
    render(WebMCPCard, {
      props: { site: { ...FOLIO, purpose: 'Notes.' }, onArm: () => {}, onEdit: () => {} },
    });

  it('a 600-character purpose keeps the clamp class and carries the full text in title', () => {
    const { container } = render600();
    const el = container.querySelector('.wmcp-purpose')!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('title')).toBe('x'.repeat(600));
    expect(el.getAttribute('title')!.length).toBe(600);
  });

  it('a one-word purpose gets the SAME class and a title too — no length-based branch', () => {
    const long = render600().container.querySelector('.wmcp-purpose')!;
    const short = renderOneWord().container.querySelector('.wmcp-purpose')!;
    expect(short.className).toBe(long.className);
    expect(short.getAttribute('title')).toBe('Notes.');
  });

  it('the name is also given a title, so an ellipsised name still reads in full on hover', () => {
    const { container } = render(WebMCPCard, {
      props: { site: { ...FOLIO, name: 'A '.repeat(80).trim() }, onArm: () => {}, onEdit: () => {} },
    });
    const el = container.querySelector('.wmcp-name')!;
    expect(el.getAttribute('title')).toBe('A '.repeat(80).trim());
  });
});

describe('the pane — two halves behind selector cards', () => {
  // The reason the cards exist: a config-declared server and a browser-native
  // site are different things, and the two stacked headings that used to say
  // so drew both lists at once — the pane read as one long undivided list
  // (UAT). Each card names its half; only the picked one renders. The switch
  // itself is pinned in mcpPane.test.ts; what THIS suite owns is that the
  // section is reachable through the pane at all.
  it('names both halves on the selector cards, so neither list is read as the other', async () => {
    render(MCPPane);
    await tick();
    expect(document.body.textContent).toContain('MCP Servers');
    expect(document.body.textContent).toContain('Web MCP');
  });

  it('reaches the Web MCP section through its card', async () => {
    const { container } = render(MCPPane);
    await tick();

    const webCard = Array.from(container.querySelectorAll<HTMLButtonElement>('.mcp-pick-card')).find(
      (b) => b.querySelector('.mcp-pick-name')?.textContent === 'Web MCP',
    )!;
    await fireEvent.click(webCard);
    // Data lands AFTER the switch: the section mounts, asks, and hears this.
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'webmcpData', sites: [FOLIO], file: 'C:/h/webmcp.json' } }),
    );
    await tick();

    expect(document.body.textContent).toContain('the page itself is the server');
    expect(document.body.textContent).toContain('https://folio.example/mcp');
  });

  // The section prints its registry file path on screen, which invites a hand
  // edit. A refresh that reloaded only the server half would be a trap.
  it('refreshes BOTH lists from the one refresh button', async () => {
    const { getByTitle } = render(MCPPane);
    await tick();
    globalThis.__vscodeApiMock.postMessage.mockClear();
    await fireEvent.click(getByTitle(/Re-read both lists/));
    const types = globalThis.__vscodeApiMock.postMessage.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain('mcpRequest');
    expect(types).toContain('webmcpRequest');
  });

  it('still renders the server list it always did', async () => {
    render(MCPPane);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'mcpData',
          servers: [
            {
              name: 'config-local',
              source: 'config',
              shadowed: false,
              type: 'local',
              enabled: true,
              command: ['npx', 'server'],
              status: { status: 'connected' },
              supportsOAuth: false,
            },
          ],
        },
      }),
    );
    await tick();
    expect(document.body.textContent).toContain('config-local');
    expect(document.body.textContent).toContain('connected');
  });
});

describe('the sites filter box — each view owns its box', () => {
  // The box is the pane's (toolbar idiom, own query state); the narrowing is
  // the section's; both call the ONE predicate in webmcpFilter.ts. These tests
  // drive the real surface end-to-end: type in the box, watch the cards.
  const BOARD = { url: 'https://tickets.example/board', name: 'board', purpose: 'ticket triage', addedAt: 2 };

  const pickCard = (container: HTMLElement, name: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('.mcp-pick-card')).find(
      (b) => b.querySelector('.mcp-pick-name')?.textContent === name,
    )!;
  const onWeb = async () => {
    const { container } = render(MCPPane);
    await tick();
    await fireEvent.click(pickCard(container, 'Web MCP'));
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'webmcpData', sites: [FOLIO, BOARD], file: 'C:/h/webmcp.json' } }),
    );
    await tick();
    return container;
  };
  const box = (c: HTMLElement) => c.querySelector('.wmcp-search') as HTMLInputElement;
  const names = (c: HTMLElement) => Array.from(c.querySelectorAll('.wmcp-name')).map((el) => el.textContent);
  const type = async (c: HTMLElement, value: string) => {
    await fireEvent.input(box(c), { target: { value } });
    await tick();
  };

  it('the Web MCP view gets its OWN box with an n/m count — not the servers box', async () => {
    const container = await onWeb();
    expect(box(container)).not.toBeNull();
    // mcpPane.test.ts pins `.mcp-search` to the servers view; the split holds.
    expect(container.querySelector('.mcp-search')).toBeNull();
    expect(container.querySelector('.mcp-count')!.textContent).toBe('2/2');
  });

  it('narrows by NAME — the non-matching card leaves the DOM, and the count says so', async () => {
    const container = await onWeb();
    await type(container, 'folio');
    expect(names(container)).toEqual(['folio']);
    expect(container.querySelector('.mcp-count')!.textContent).toBe('1/2');
  });

  it('narrows by PURPOSE', async () => {
    const container = await onWeb();
    await type(container, 'triage');
    expect(names(container)).toEqual(['board']);
  });

  it('narrows by URL, case-insensitively', async () => {
    const container = await onWeb();
    await type(container, 'TICKETS.example');
    expect(names(container)).toEqual(['board']);
  });

  it('quotes the query that matched nothing, instead of a silently empty grid', async () => {
    const container = await onWeb();
    await type(container, 'zzz');
    expect(names(container)).toEqual([]);
    expect(document.body.textContent).toContain('No sites match "zzz"');
  });

  it('keeps the two query states apart — the sites text never lands in the servers box', async () => {
    const container = await onWeb();
    await type(container, 'folio');
    await fireEvent.click(pickCard(container, 'MCP Servers'));
    await tick();
    expect((container.querySelector('.mcp-search') as HTMLInputElement).value).toBe('');
    // ...and coming back, the sites box still holds what was typed.
    await fireEvent.click(pickCard(container, 'Web MCP'));
    await tick();
    expect(box(container).value).toBe('folio');
  });
});

// --- the pinned add form ---------------------------------------------------
// THE OWNER REPORT: with fifty sites registered the add form was pushed off the
// bottom of the pane and could not be reached. Two things fix it and both are
// asserted here — DOM ORDER (the form is drawn before the grid, so it is at the
// top of the scroll box) and the STICKY RULE (so it stays there once the list is
// scrolled). jsdom has no layout engine, so the geometry itself is proven in a
// real browser instead — the pane mounted in headless Chromium with 50 sites in
// a 600px box, scrolled to the bottom, the form still inside the scroll viewport.
// That run is a lane artifact (screenshot in the report), not part of this suite.
describe('the add form is pinned above the cards', () => {
  // `.wmcp-new` itself, not `.wmcp-new-input` and friends.
  const RE_WMCP_NEW = /\.wmcp-new[.\s{]/;
  const data = (sites: unknown[]) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'webmcpData', sites, file: 'C:/h/webmcp.json' } }));

  const fifty = () =>
    Array.from({ length: 50 }, (_, i) => ({
      url: `https://site${i}.example/mcp`,
      name: `site-${i}`,
      purpose: `purpose ${i}`,
      addedAt: i,
    }));

  it('draws the form BEFORE the card grid, whatever the list length', async () => {
    const { container } = render(WebMCPSection);
    data(fifty());
    await tick();

    const form = container.querySelector('.wmcp-new')!;
    const grid = container.querySelector('.wmcp-grid')!;
    expect(form).not.toBeNull();
    expect(grid.querySelectorAll('.wmcp-card').length).toBe(50);
    // DOCUMENT_POSITION_FOLLOWING = 4: the grid comes after the form.
    expect(form.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Vitest does not process a component's <style>, so there is no computed rule
  // to read in jsdom. The rule is asserted from the SOURCE instead — the move
  // this suite already makes against the engine's store below — and the real
  // geometry was proven in the browser run described above.
  it('pins the form with a sticky rule, so a long list cannot scroll it away', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'WebMCPSection.svelte'), 'utf8');
    const rule = source
      .split('}')
      .find((block) => RE_WMCP_NEW.test(block) && block.includes('position:'));
    expect(rule).toBeDefined();
    expect(rule).toContain('position: sticky');
    expect(rule).toContain('top: 0');
    // Opaque, or fifty cards scroll visibly through it.
    expect(rule).toContain('background: var(--og-bg)');
  });
});

// --- the mirror's drift guard ---------------------------------------------
// normalizeSiteUrl and the document shape are MIRRORED from the engine
// (packages/engine is not resolvable from this package). If the two disagree on
// what one address is, or on what the array is called, the two writers stop
// seeing the same registry — and nothing else in the build would say so.
describe('the mirror still agrees with the engine', () => {
  const engineStore = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'engine', 'src', 'tool', 'webmcp-store.ts'),
    'utf8',
  );

  it('names the same file and the same document key', () => {
    expect(engineStore).toContain(`export const WEBMCP_FILE = "${WEBMCP_FILE}"`);
    // The engine writes `doc.sites`; this side writes doc[SITES_KEY]. A rename
    // on one side alone would split the registry in two.
    expect(engineStore).toContain(`doc.${SITES_KEY} = list`);
    expect(SITES_KEY).toBe('sites');
  });

  it('normalises an address the same way the engine does', () => {
    // Derived from the engine's own source, not from an assumption about it:
    // the rules it states are the rules asserted here.
    expect(engineStore).toContain('url.protocol !== "http:" && url.protocol !== "https:"');
    expect(engineStore).toContain('const bare = url.pathname === "/" && !url.search && !url.hash');
    for (const [input, expected] of [
      ['https://Example.com/', 'https://example.com'],
      ['https://example.com/mcp/', 'https://example.com/mcp/'],
      ['https://example.com:443/mcp', 'https://example.com/mcp'],
      ['https://example.com/#/mcp', 'https://example.com/#/mcp'],
    ] as const) {
      expect(normalizeSiteUrl(input)).toBe(expected);
    }
  });
});
