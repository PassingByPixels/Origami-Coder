// InstructionsPane — the answer to "what is in my context and why is it so
// big". The bugs worth catching are the dishonest ones: presenting a chars/4
// heuristic as a measured token count, giving a URL a size it was never
// measured for, or a totals line that disagrees with the rows above it. Plus
// the one real interaction: a row opens the actual file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import InstructionsPane from '../panes/InstructionsPane.svelte';

const posts = () =>
  globalThis.__vscodeApiMock.postMessage.mock.calls.map((c: unknown[]) => c[0]) as Array<Record<string, unknown>>;
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ');

const entry = (path: string, source: string, chars: number) => ({
  path, source, chars, bytes: chars, tokensApprox: Math.ceil(chars / 4),
});
// One of each source, deliberately NOT in size order, plus a zero-size URL.
const ENTRIES = [
  entry('C:\\ws\\AGENTS.md', 'project', 4000),
  entry('C:\\Users\\p\\.config\\origami\\AGENTS.md', 'global', 12_000),
  entry('C:\\ws\\.origami\\memory.md', 'memory', 800),
  { path: 'https://example.com/house-style.md', source: 'url', chars: 0, bytes: 0, tokensApprox: 0 },
];
const SET = {
  type: 'instructionsData',
  entries: ENTRIES,
  totalChars: 16_800,
  totalBytes: 16_800,
  totalTokensApprox: 4200,
  tokensApproxMethod: 'chars/4',
};

async function withSet(over: Record<string, unknown> = {}) {
  const rendered = render(InstructionsPane);
  window.dispatchEvent(new MessageEvent('message', { data: { ...SET, ...over } }));
  await tick();
  return rendered;
}

beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });
afterEach(() => cleanup());

describe('InstructionsPane — asks the host for the inventory on mount', () => {
  it('posts listInstructions (the DashboardPanel wire)', () => {
    render(InstructionsPane);
    expect(posts()).toContainEqual({ type: 'listInstructions' });
  });
});

describe('InstructionsPane — every entry renders with its real size', () => {
  it('shows path, source badge, chars and approximate tokens for each file', async () => {
    const { container } = await withSet();
    const rows = container.querySelectorAll('.ins-row');
    expect(rows).toHaveLength(4);

    const text = flat(container.textContent);
    expect(text).toContain('C:\\ws\\AGENTS.md');
    expect(text).toContain('4,000 chars');
    expect(text).toContain('~1,000 tok');
    expect(text).toContain('12,000 chars');
    expect(text).toContain('~3,000 tok');

    const badges = Array.from(container.querySelectorAll('.ins-badge')).map((b) => b.textContent?.trim());
    expect(badges).toContain('project');
    expect(badges).toContain('global');
    expect(badges).toContain('memory');
    expect(badges).toContain('url');
  });

  it('sorts biggest contributor first — the whole point of the view', async () => {
    const { container } = await withSet();
    const names = Array.from(container.querySelectorAll('.ins-name')).map((n) => n.textContent?.trim());
    const sizes = Array.from(container.querySelectorAll('.ins-row')).map((r) =>
      Number(r.querySelector('.ins-bar')!.getAttribute('style')!.match(/([\d.]+)%/)![1]),
    );
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
    // The 12k global file dominates, so it must be the first row, not AGENTS.md.
    expect(names[0]).toBe('AGENTS.md');
    expect(Array.from(container.querySelectorAll('.ins-path'))[0]!.textContent).toContain('.config');
  });
});

describe('InstructionsPane — the token count is labelled as the estimate it is', () => {
  it('names the engine’s own method and never presents the number as measured', async () => {
    const { container } = await withSet();
    const text = flat(container.textContent);
    expect(text).toContain('chars/4');
    expect(text.toLowerCase()).toContain('estimate');
    expect(text).toContain('~4,200 tokens');
    // A bare "4,200 tokens" with no tilde anywhere would be the lie.
    expect(text).not.toMatch(/(^|[^~\d])4,200 tokens/);
  });

  it('surfaces whatever method the engine reports, rather than a hardcoded string', async () => {
    const { container } = await withSet({ tokensApproxMethod: 'chars/3.7' });
    expect(flat(container.textContent)).toContain('chars/3.7');
  });
});

describe('InstructionsPane — the totals agree with the rows', () => {
  it('the header total equals the sum of the entries it lists', async () => {
    const { container } = await withSet();
    const sumChars = ENTRIES.reduce((n, e) => n + e.chars, 0);
    const sumTokens = ENTRIES.reduce((n, e) => n + e.tokensApprox, 0);
    expect(sumChars).toBe(SET.totalChars);
    expect(sumTokens).toBe(SET.totalTokensApprox);

    const totals = flat(container.querySelector('.ins-totals')!.textContent);
    expect(totals).toContain('4 files');
    expect(totals).toContain(`${sumChars.toLocaleString()} chars`);
    expect(totals).toContain(`~${sumTokens.toLocaleString()} tokens`);
  });
});

describe('InstructionsPane — a URL is listed without a fabricated size', () => {
  it('says "not measured" instead of 0 chars / 0 tokens', async () => {
    const { container } = await withSet();
    const urlRow = Array.from(container.querySelectorAll('.ins-row')).find((r) =>
      r.querySelector('.ins-badge')?.textContent?.trim() === 'url',
    )!;
    const text = flat(urlRow.textContent);
    expect(text).toContain('https://example.com/house-style.md');
    expect(text).toContain('not measured');
    expect(text).not.toContain('0 chars');
    expect(text).not.toContain('~0 tok');
  });

  it('clicking a URL row opens nothing — there is no file behind it', async () => {
    const { container } = await withSet();
    const urlRow = Array.from(container.querySelectorAll('.ins-row')).find((r) =>
      r.querySelector('.ins-badge')?.textContent?.trim() === 'url',
    )!;
    await fireEvent.click(urlRow);
    expect(posts().filter((p) => p.type === 'openAbsoluteFile')).toEqual([]);
  });
});

describe('InstructionsPane — a row opens the real file', () => {
  it('posts openAbsoluteFile with that entry’s absolute path', async () => {
    const { container } = await withSet();
    const fileRow = Array.from(container.querySelectorAll('.ins-row')).find((r) =>
      r.querySelector('.ins-badge')?.textContent?.trim() === 'memory',
    )!;
    await fireEvent.click(fileRow);
    expect(posts()).toContainEqual({ type: 'openAbsoluteFile', path: 'C:\\ws\\.origami\\memory.md' });
  });
});

// --- The base agent prompt. It is the biggest thing in the context that the
// user never chose and, until now, could not see. The bugs worth catching are
// the ones that would hide it again: sorting it in among the files by size,
// presenting a built-in as a file that exists, or letting the webview name the
// path the extension is about to WRITE to.

const BASE = (over: Record<string, unknown> = {}) => ({
  path: 'C:\\Users\\p\\.config\\origami\\base-prompt.md',
  source: 'base-prompt',
  chars: 2000,
  bytes: 2000,
  tokensApprox: 500,
  overridden: false,
  ...over,
});
const baseRow = (container: Element) =>
  Array.from(container.querySelectorAll('.ins-row')).find((r) =>
    r.querySelector('.ins-name')?.textContent?.trim() === 'Base agent prompt',
  )!;

// Deliberately LAST in the payload and only 2k against the 12k global file, so
// neither wire order nor size can be what puts it on top.
const withBase = (over: Record<string, unknown> = {}) =>
  withSet({ entries: [...ENTRIES, BASE(over)], totalChars: 18_800, totalTokensApprox: 4700 });

describe('InstructionsPane — the base prompt is pinned above the files', () => {
  it('renders it FIRST even though a 12k instruction file outweighs it', async () => {
    const { container } = await withBase();
    const names = Array.from(container.querySelectorAll('.ins-name')).map((n) => n.textContent?.trim());

    expect(names[0]).toBe('Base agent prompt');
    // The files below it are still biggest-first — pinning is one exception,
    // not an abandoned sort.
    expect(names.slice(1)).toEqual(['AGENTS.md', 'AGENTS.md', 'memory.md', 'house-style.md']);
  });

  it('does not count a built-in as a file, but does count its chars', async () => {
    const { container } = await withBase();
    const totals = flat(container.querySelector('.ins-totals')!.textContent);

    // 5 rows, 4 of which are real files — a built-in prompt is not one.
    expect(container.querySelectorAll('.ins-row')).toHaveLength(5);
    expect(totals).toContain('4 files');
    // Its 2,000 chars ARE in the total: it is genuinely prepended to every prompt.
    expect(totals).toContain('18,800 chars');
  });

  it('labels it as the built-in, and says where an override WOULD go', async () => {
    const { container } = await withBase();
    const row = baseRow(container);

    expect(row.querySelector('.ins-badge')!.textContent!.trim()).toBe('built-in');
    const text = flat(row.textContent);
    expect(text).toContain('C:\\Users\\p\\.config\\origami\\base-prompt.md');
    // A built-in must not read as a file already sitting on disk.
    expect(text).toContain('Built in');
    expect(text).toContain('2,000 chars');
    expect(text).toContain('~500 tok');
  });

  it('says OVERRIDDEN once the user’s own file supplies the prompt', async () => {
    const { container } = await withBase({ overridden: true, chars: 300, tokensApprox: 75 });
    const row = baseRow(container);

    expect(row.querySelector('.ins-badge')!.textContent!.trim()).toBe('overridden');
    // No longer a hypothetical location — the file is real.
    expect(flat(row.textContent)).not.toContain('Built in');
    expect(flat(row.textContent)).toContain('300 chars');
  });
});

describe('InstructionsPane — clicking the base prompt asks the HOST to open it', () => {
  it('posts openBasePrompt and never a webview-supplied path', async () => {
    const { container } = await withBase();
    await fireEvent.click(baseRow(container));

    expect(posts()).toContainEqual({ type: 'openBasePrompt', kind: 'base-prompt' });
    // The path is the one thing that must NOT cross: the host seeds a file at
    // whatever it is told, so it resolves the target itself.
    expect(posts().filter((p) => p.type === 'openAbsoluteFile')).toEqual([]);
    expect(JSON.stringify(posts())).not.toContain('base-prompt.md');
  });

  it('still opens an ordinary instruction file by path — the pin changed one row', async () => {
    const { container } = await withBase();
    const memory = Array.from(container.querySelectorAll('.ins-row')).find((r) =>
      r.querySelector('.ins-badge')?.textContent?.trim() === 'memory',
    )!;
    await fireEvent.click(memory);

    expect(posts()).toContainEqual({ type: 'openAbsoluteFile', path: 'C:\\ws\\.origami\\memory.md' });
  });
});

// --- Restore default. Only two rows ever get it: the base prompt once
// overridden (a built-in has nothing to restore), and the project AGENTS.md
// (a global file, or a project CLAUDE.md/CONTEXT.md, has no known default).
// The bug worth catching: the button leaking onto a row it does not belong
// on, or its click also triggering the row's own open-file message.

describe('InstructionsPane — Restore default appears only where it belongs', () => {
  it('is absent from the built-in base prompt', async () => {
    const { container } = await withBase();
    expect(baseRow(container).querySelector('.ins-restore')).toBeNull();
  });

  it('appears on the base prompt row once it is overridden', async () => {
    const { container } = await withBase({ overridden: true });
    expect(baseRow(container).querySelector('.ins-restore')).not.toBeNull();
  });

  it('appears on the PROJECT AGENTS.md row but not the global one', async () => {
    const { container } = await withSet();
    const rows = Array.from(container.querySelectorAll('.ins-row'));
    const projectRow = rows.find((r) => r.querySelector('.ins-badge')?.textContent?.trim() === 'project')!;
    const globalRow = rows.find((r) => r.querySelector('.ins-badge')?.textContent?.trim() === 'global')!;
    expect(projectRow.querySelector('.ins-restore')).not.toBeNull();
    expect(globalRow.querySelector('.ins-restore')).toBeNull();
  });

  it('clicking it posts restoreInstructionDefault, never the row-open message', async () => {
    const { container } = await withBase({ overridden: true });
    const restoreBtn = baseRow(container).querySelector('.ins-restore') as HTMLElement;
    await fireEvent.click(restoreBtn);
    expect(posts()).toContainEqual({ type: 'restoreInstructionDefault', kind: 'base-prompt' });
    expect(posts().filter((p) => p.type === 'openBasePrompt')).toEqual([]);
  });

  it('clicking it on the AGENTS.md row posts kind agents-md, never opens the file', async () => {
    const { container } = await withSet();
    const projectRow = Array.from(container.querySelectorAll('.ins-row')).find(
      (r) => r.querySelector('.ins-badge')?.textContent?.trim() === 'project',
    )!;
    const restoreBtn = projectRow.querySelector('.ins-restore') as HTMLElement;
    await fireEvent.click(restoreBtn);
    expect(posts()).toContainEqual({ type: 'restoreInstructionDefault', kind: 'agents-md' });
    expect(posts().filter((p) => p.type === 'openAbsoluteFile')).toEqual([]);
  });
});

// --- The COLLAB row. Same kind of thing as the base prompt: shipped prompt
// text a user never chose. The bugs worth catching are the ones that would
// make it unreachable — a row that renders as a bare filename, a click that
// opens the wrong file, or a Restore button that names the base prompt.
//
// M4.1 merged the room manual into this ONE layer, so the tier holds a single
// row now; the retired `collab-manual` source is covered in instructionRows.

const COLLAB = (source: string, file: string, over: Record<string, unknown> = {}) => ({
  path: `C:\\Users\\p\\.config\\origami\\${file}`,
  source,
  chars: 900,
  bytes: 900,
  tokensApprox: 225,
  overridden: false,
  ...over,
});
const named = (container: Element, name: string) =>
  Array.from(container.querySelectorAll('.ins-row')).find((r) => r.querySelector('.ins-name')?.textContent?.trim() === name)!;
const withCollab = (over: Record<string, unknown> = {}) =>
  withSet({
    entries: [...ENTRIES, BASE(), COLLAB('collab-agent-base', 'collab-agent-base.md', over)],
    totalChars: 19_700,
    totalTokensApprox: 4925,
  });

describe('InstructionsPane — the collab prompt layer is visible and editable', () => {
  it('renders LAST, after every file, still under the base agent prompt', async () => {
    const { container } = await withCollab();
    const names = Array.from(container.querySelectorAll('.ins-name')).map((n) => n.textContent?.trim());

    expect(names[0]).toBe('Base agent prompt');
    // Files stay biggest-first between the base prompt and the collab layer.
    expect(names.slice(1, 5)).toEqual(['AGENTS.md', 'AGENTS.md', 'memory.md', 'house-style.md']);
    expect(names.slice(5)).toEqual(['Collab base prompt']);
  });

  it('counts it as no file, and says where an override WOULD go', async () => {
    const { container } = await withCollab();

    expect(flat(container.querySelector('.ins-totals')!.textContent)).toContain('4 files');
    const row = named(container, 'Collab base prompt');
    expect(row.querySelector('.ins-badge')!.textContent!.trim()).toBe('built-in');
    expect(flat(row.textContent)).toContain('Built in');
    expect(flat(row.textContent)).toContain('collab-agent-base.md');
  });

  it('clicking it asks the host to open THAT layer, by kind and never by path', async () => {
    const { container } = await withCollab();
    await fireEvent.click(named(container, 'Collab base prompt'));

    expect(posts()).toContainEqual({ type: 'openBasePrompt', kind: 'collab-agent-base' });
    // The host seeds a file at whatever it is told, so no path may cross.
    expect(JSON.stringify(posts())).not.toContain('.md');
  });

  it('offers Restore default only once the user has actually overridden it', async () => {
    const { container } = await withCollab();
    expect(named(container, 'Collab base prompt').querySelector('.ins-restore')).toBeNull();

    const over = await withCollab({ overridden: true, chars: 40, tokensApprox: 10 });
    const row = named(over.container, 'Collab base prompt');
    await fireEvent.click(row.querySelector('.ins-restore') as HTMLElement);
    expect(posts()).toContainEqual({ type: 'restoreInstructionDefault', kind: 'collab-agent-base' });
    // The row's own open message must not fire from the button.
    expect(posts().filter((p) => p.type === 'openBasePrompt')).toEqual([]);
  });

  it('says OVERRIDDEN and shows the user\u2019s own size once the file supplies it', async () => {
    const { container } = await withCollab({ overridden: true, chars: 42, tokensApprox: 11 });
    const row = named(container, 'Collab base prompt');

    expect(row.querySelector('.ins-badge')!.textContent!.trim()).toBe('overridden');
    expect(flat(row.textContent)).not.toContain('Built in');
    expect(flat(row.textContent)).toContain('42 chars');
  });
});

// --- The "Collab" subsection. Before this, the collab rows sat pinned
// directly under the base prompt with no heading before the files that
// followed them \u2014 indistinguishable from more pinned rows. The bug worth
// catching: the heading appearing with nothing under it, or in the wrong SLOT
// (above the base prompt, or mixed in among the files).
describe('InstructionsPane \u2014 the Collab subsection', () => {
  it('a "Collab" subheading sits between the files and the collab row', async () => {
    const { container } = await withCollab();
    const items = Array.from(container.querySelectorAll('.ins-list > *'));
    const labels = items.map((el) =>
      el.classList.contains('ins-subhead')
        ? `#${el.textContent?.trim()}`
        : el.classList.contains('ins-new')
          ? '+new'
          : el.querySelector('.ins-name')?.textContent?.trim(),
    );
    // The "+ New file" row closes the FILES tier — after the files it would
    // join, and before the collab layer, which is not a file you can add to.
    expect(labels).toEqual([
      'Base agent prompt', 'AGENTS.md', 'AGENTS.md', 'memory.md', 'house-style.md',
      '+new', '#Collab', 'Collab base prompt',
    ]);
  });

  it('is absent when the inventory has no collab layers yet', async () => {
    const { container } = await withBase();
    expect(container.querySelector('.ins-subhead')).toBeNull();
  });

  it('is absent from a plain file-only inventory too', async () => {
    const { container } = await withSet();
    expect(container.querySelector('.ins-subhead')).toBeNull();
  });
});

// --- The list as a STACK OF FULL-WIDTH ROWS, plus the "+ New file" affordance.
// Before that affordance the inventory could read every file feeding the prompt
// and add none of them.
//
// This list briefly shipped as a GRID OF CARDS and was reverted. The reason is
// the share bar: the list is a RANKING, and a bar's LENGTH is that ranking made
// visible, so a bar is only comparable to the one above it when both are drawn
// to the same width. Columns of unequal content cannot promise that.
//
// The bugs worth catching: a tier lost in the revert, a row folding back into
// the card's stacked shape, the grid returning, and — the serious one — the
// new-file row naming a path. Every other write this pane can trigger resolves
// its own target host-side precisely so a webview cannot choose where the
// extension writes; this must not be the exception.

describe('InstructionsPane — the list is a stack of rows, tiers intact', () => {
  it('every tier still renders, one row per entry', async () => {
    const { container } = await withCollab();
    // 4 files + the base prompt + the collab layer. The + row is not one.
    expect(container.querySelectorAll('.ins-row')).toHaveLength(6);
    expect(container.querySelectorAll('.ins-new')).toHaveLength(1);
  });

  it('a row keeps its size as a TAIL on the name line, not a line of its own', async () => {
    const { container } = await withCollab();
    const row = named(container, 'Collab base prompt');
    // The card put .ins-size in its own block under the name; the row hangs it
    // off the end of the name line, which is the shape full width buys. This is
    // markup, not styling — jsdom computes no layout and injects no stylesheet,
    // so the DOM tree is the only honest place to pin the difference.
    expect(row.querySelector('.ins-row-main > .ins-size')).not.toBeNull();
    expect(row.querySelector(':scope > .ins-size')).toBeNull();
  });

  it('the subheading divides the tiers rather than labelling one entry', async () => {
    const { container } = await withCollab();
    const sub = container.querySelector('.ins-subhead') as HTMLElement;
    expect(sub).not.toBeNull();
    expect(sub.textContent?.trim()).toBe('Collab');
  });

  it('lays the list out as a COLUMN — the grid does not come back', () => {
    // A source assertion on purpose. The regression this guards is a layout
    // one, and the harness cannot see layout: jsdom computes no grid, and the
    // Svelte styles are never injected into the test DOM (verified — the
    // document carries zero <style> elements after a render). The rule itself
    // is one line of CSS, so the file is where it can be read.
    const pane = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panes', 'InstructionsPane.svelte'),
      'utf8',
    );
    const listRule = pane.match(/\.ins-list\s*\{[^}]*\}/)![0];
    expect(listRule).toContain('flex-direction: column');
    expect(listRule).not.toContain('grid-template-columns');
  });
});

describe('InstructionsPane — "+ New file" asks the HOST to make one', () => {
  it('posts createInstructionFile, and never a path of its own choosing', async () => {
    const { container } = await withSet();
    await fireEvent.click(container.querySelector('.ins-new') as HTMLElement);

    expect(posts()).toContainEqual({ type: 'createInstructionFile' });
    // The host resolves AND seeds the target; no path may cross this wire.
    const post = posts().find((p) => p.type === 'createInstructionFile')!;
    expect(Object.keys(post)).toEqual(['type']);
  });

  it('says what it will make, so the click is not a guess', async () => {
    const { container } = await withSet();
    expect(flat(container.querySelector('.ins-new')!.textContent)).toContain('AGENTS.md');
  });

  it('does not fire the row-open wire — it is not an instruction row', async () => {
    const { container } = await withSet();
    await fireEvent.click(container.querySelector('.ins-new') as HTMLElement);
    expect(posts().filter((p) => p.type === 'openAbsoluteFile')).toEqual([]);
    expect(posts().filter((p) => p.type === 'openBasePrompt')).toEqual([]);
  });
});

describe('InstructionsPane — empty and failed are not the same as loading', () => {
  it('an empty inventory says nothing feeds the prompt, rather than spinning', async () => {
    const { container } = await withSet({ entries: [], totalChars: 0, totalBytes: 0, totalTokensApprox: 0 });
    expect(flat(container.querySelector('.ins-empty')!.textContent)).toContain('Nothing feeds the system prompt');
    expect(container.querySelector('.ins-row')).toBeNull();
  });

  it('a failed listing shows the engine error, not an empty list', async () => {
    const { container } = await withSet({ entries: [], error: 'Open a chat first' });
    expect(flat(container.querySelector('.ins-error')!.textContent)).toContain('Open a chat first');
    expect(container.querySelector('.ins-empty')).toBeNull();
  });

  it('before any reply arrives it says it is reading, and shows no rows', () => {
    const { container } = render(InstructionsPane);
    expect(flat(container.querySelector('.ins-empty')!.textContent)).toContain('Reading the instruction inventory');
    expect(container.querySelector('.ins-row')).toBeNull();
  });
});

// --- The capture section: what the engine ACTUALLY sent, under the inventory.
// The inventory is derived from disk; this is recorded at send time, so the
// bugs worth catching are the ones that would make it look derived — a missing
// request, an unsent session shown as a failure, or a plugin-reshaped final
// prompt quietly replaced by the parts the engine assembled.

const CAPTURE = {
  type: 'promptCaptureData',
  capture: {
    capturedAt: '2026-08-03T09:00:00.000Z',
    model: 'anthropic/claude-opus-4-6',
    labeledParts: [
      { label: 'base-or-agent-prompt', chars: 9000, tokensApprox: 2250, text: 'BUILT-IN PROMPT BODY' },
      { label: 'instructions', chars: 4000, tokensApprox: 1000, text: 'AGENTS.md BODY' },
      { label: 'env', chars: 1000, tokensApprox: 250, text: 'ENV BODY' },
    ],
    finalSystem: [{ chars: 14_000, tokensApprox: 3500, text: 'JOINED SYSTEM PROMPT' }],
    tools: [{ name: 'bash', descriptionChars: 620, schemaBytes: 310, description: 'RUN A SHELL COMMAND' }],
    tokensApproxMethod: 'chars/4',
  },
};

async function withCapture(over: Record<string, unknown> = {}) {
  const rendered = render(InstructionsPane);
  window.dispatchEvent(new MessageEvent('message', { data: { ...CAPTURE, ...over } }));
  await tick();
  return rendered;
}

describe('InstructionsPane — asks for the last turn as well as the inventory', () => {
  it('posts promptCapture alongside listInstructions, so both describe one moment', () => {
    render(InstructionsPane);
    expect(posts()).toContainEqual({ type: 'listInstructions' });
    expect(posts()).toContainEqual({ type: 'promptCapture' });
  });
});

describe('the capture section — every part of the real prompt, with its size', () => {
  it('renders one row per labelled part, with its share of the assembled total', async () => {
    const { container } = await withCapture();
    const rows = container.querySelectorAll('.pc-row');
    // 3 parts + 1 final block + 1 tool.
    expect(rows).toHaveLength(5);

    const badges = Array.from(container.querySelectorAll('.pc-badge')).map((b) => b.textContent?.trim());
    expect(badges).toContain('base-or-agent-prompt');
    expect(badges).toContain('instructions');
    expect(badges).toContain('env');

    const text = flat(container.textContent);
    expect(text).toContain('9,000 chars');
    expect(text).toContain('~2,250 tok');
    // 9000 of 14000 assembled chars — the number that answers "what is bloating it".
    expect(text).toContain('64.3%');
  });

  it('a part expands to its FULL text, which is the point of a capture', async () => {
    const { container } = await withCapture();
    expect(container.querySelector('.pc-text')).toBeNull();

    await fireEvent.click(container.querySelectorAll('.pc-row-head')[0]!);
    expect(container.querySelector('.pc-text')!.textContent).toBe('BUILT-IN PROMPT BODY');
  });

  it('shows the final assembled system SEPARATELY, because a plugin can reshape it', async () => {
    const { container } = await withCapture();
    const text = flat(container.textContent);
    expect(text).toContain('Final assembled system');
    expect(text).toContain('1 block');
    expect(text).toContain('14,000 chars');
  });

  it('lists each tool with its description size and schema bytes', async () => {
    const { container } = await withCapture();
    const text = flat(container.textContent);
    expect(text).toContain('Tools offered — 1');
    expect(text).toContain('bash');
    expect(text).toContain('620 chars');
    expect(text).toContain('310 B schema');
  });

  it('says a schema was NOT MEASURED rather than printing a 0 that reads as empty', async () => {
    const { container } = await withCapture({
      capture: {
        ...CAPTURE.capture,
        tools: [{ name: 'mystery', descriptionChars: 10, schemaBytes: 0, description: 'x' }],
      },
    });
    const text = flat(container.textContent);
    expect(text).toContain('schema not measured');
    expect(text).not.toContain('0 B schema');
  });

  it('names the model and the estimator, and never prints a bare token count', async () => {
    const { container } = await withCapture();
    const text = flat(container.textContent);
    expect(text).toContain('anthropic/claude-opus-4-6');
    expect(text).toContain('chars/4');
    expect(text).toContain('~3,500 tokens');
    expect(text).not.toMatch(/(^|[^~\d])3,500 tokens/);
  });
});

describe('the capture section — an unsent session is not a failure', () => {
  it('tells the user to send a message first, instead of showing an error', async () => {
    const { container } = await withCapture({ capture: null });
    const empty = flat(container.querySelector('.pc-empty')!.textContent);
    expect(empty).toContain('Send a message in this session first');
    expect(container.querySelector('.pc-error')).toBeNull();
    expect(container.querySelector('.pc-row')).toBeNull();
  });

  it('a real failure DOES show the engine error, not the send-a-message hint', async () => {
    const { container } = await withCapture({ capture: null, error: 'Open a chat first' });
    expect(flat(container.querySelector('.pc-error')!.textContent)).toContain('Open a chat first');
    expect(container.querySelector('.pc-empty')).toBeNull();
  });

  it('before any reply it says it is reading, rather than claiming nothing was sent', () => {
    const { container } = render(InstructionsPane);
    const empty = flat(container.querySelector('.pc-empty')!.textContent);
    expect(empty).toContain('Reading the last prepared request');
  });
});

// --- The cache-hit-ratio card (t-kgtw47), mounted below the capture section.
// Same reason PromptCaptureSection lives here rather than its own test file:
// it is a self-contained widget rendered as part of this pane.

const CACHE_STATS = {
  type: 'cacheStatsData',
  current: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
  lifetime: { input: 900, output: 400, cacheRead: 80, cacheWrite: 20 },
  sessionCount: 7,
};

async function withCacheStats(over: Record<string, unknown> = {}) {
  const rendered = render(InstructionsPane);
  window.dispatchEvent(new MessageEvent('message', { data: { ...CACHE_STATS, ...over } }));
  await tick();
  return rendered;
}

describe('InstructionsPane — asks for cache stats too (t-kgtw47)', () => {
  it('posts cacheStats alongside listInstructions and promptCapture', () => {
    render(InstructionsPane);
    expect(posts()).toContainEqual({ type: 'cacheStats' });
  });
});

describe('CacheStatsCard — three numbers plus the read ratio, for this session and lifetime', () => {
  it('renders fresh/read/write and the ratio for both rows', async () => {
    const { container } = await withCacheStats();
    const text = flat(container.textContent);

    expect(text).toContain('100 fresh');
    expect(text).toContain('10 read');
    expect(text).toContain('5 write');
    // 10 / (100 + 10 + 5) = 8.7% -> rounds to 9%.
    expect(text).toContain('9% read');

    expect(text).toContain('900 fresh');
    expect(text).toContain('80 read');
    expect(text).toContain('20 write');
    // 80 / (900 + 80 + 20) = 8%.
    expect(text).toContain('8% read');
    expect(text).toContain('Lifetime (7)');
  });

  it('a provider reporting no cache fields shows zero honestly, with the note explaining why', async () => {
    const zero = { input: 500, output: 200, cacheRead: 0, cacheWrite: 0 };
    const { container } = await withCacheStats({ current: zero, lifetime: zero });
    const text = flat(container.textContent);

    expect(text).toContain('0 read');
    expect(text).toContain('0% read');
    expect(text.toLowerCase()).toContain('unmeasured');
  });

  it('before any reply it says it is reading', () => {
    const { container } = render(InstructionsPane);
    expect(flat(container.textContent)).toContain('Reading cache stats');
  });

  it('a failed cache_stats call shows the engine error, not a blank card', async () => {
    const { container } = await withCacheStats({ current: null, lifetime: null, error: 'Open a chat first' });
    expect(flat(container.textContent)).toContain('Open a chat first');
  });
});
