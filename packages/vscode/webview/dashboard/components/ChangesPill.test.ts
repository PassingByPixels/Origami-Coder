// The composer's changes row, rendered.
//
// Structure and text only. `vitest.config.mts` does not set `css: true`, so no
// <style> element ever reaches this DOM and getComputedStyle answers '' for
// everything — an assertion about the pill's size, the popover's position or
// the list's scroll cap would look rigorous and check nothing. Those need a
// human eye. What IS checkable here: whether the row appears at all, what the
// numbers say, and whether the list opens, closes and opens a file.

import { render, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ChangesPill from './ChangesPill.svelte';
import type { SessionChanges } from '../panes/sessionChanges';

const post = () => globalThis.__vscodeApiMock.postMessage;

// Fixtures are written by hand rather than produced by aggregateSessionChanges,
// so a break in the aggregator fails ITS suite and not this one.
const TWO_FILES: SessionChanges = {
  fileCount: 2,
  adds: 312,
  dels: 40,
  files: [
    { path: '/w/packages/vscode/src/acpClient.ts', adds: 300, dels: 40, created: false },
    { path: 'C:\\w\\webview\\dashboard\\panes\\brandNew.ts', adds: 12, dels: 0, created: true },
  ],
};

describe('ChangesPill — the row itself', () => {
  beforeEach(() => post().mockReset());

  it('renders NOTHING with no changes AND no focus toggle (the bare collab composer)', () => {
    const { container } = render(ChangesPill, {});
    expect(container.querySelector('.changes-pill')).toBeNull();
    expect(container.querySelector('.changes-row')).toBeNull();
    expect(container.querySelector('.focus-eye')).toBeNull();
  });

  it('renders NO PILL at fileCount 0 — the footer line is not spent saying "0 files"', () => {
    const { container } = render(ChangesPill, {
      changes: { fileCount: 0, adds: 0, dels: 0, files: [] } satisfies SessionChanges,
    });
    expect(container.querySelector('.changes-pill')).toBeNull();
  });

  it('shows the file count and both totals', () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    const pill = container.querySelector('.changes-pill') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.querySelector('.cp-files')!.textContent).toBe('2 files');
    expect(pill.querySelector('.cp-add')!.textContent).toBe('+312');
    expect(pill.querySelector('.cp-del')!.textContent).toBe('−40');
  });

  it('says "file", not "files", at one', () => {
    const { container } = render(ChangesPill, {
      changes: {
        fileCount: 1, adds: 4, dels: 1,
        files: [{ path: '/w/a.ts', adds: 4, dels: 1, created: false }],
      } satisfies SessionChanges,
    });
    expect(container.querySelector('.cp-files')!.textContent).toBe('1 file');
  });
});

// THE FOCUS EYE — the right-hand end of the same row (0.4.61).
//
// Structure and behaviour only, again: whether the eye is LEGIBLE at 13px and
// whether its lit --og-accent reads as "on" are questions for a human eye, not
// for a DOM with no stylesheet in it. What is checkable is that the row exists
// before anything has been edited (which is the whole point of moving the row
// out from behind the changes data), that the two controls coexist, and that
// the button reports its state honestly.
describe('ChangesPill — the focus eye', () => {
  beforeEach(() => post().mockReset());

  it('draws the row and the eye with NO changes data at all', () => {
    const { container } = render(ChangesPill, { onToggleFocus: () => {} });
    expect(container.querySelector('.changes-row'), 'the row survives an empty session').not.toBeNull();
    expect(container.querySelector('.focus-eye')).not.toBeNull();
    expect(container.querySelector('.changes-pill'), 'nothing edited yet, so no pill').toBeNull();
  });

  it('sits alongside the pill once files have changed', () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES, onToggleFocus: () => {} });
    expect(container.querySelector('.changes-pill')).not.toBeNull();
    expect(container.querySelector('.focus-eye')).not.toBeNull();
  });

  it('is ABSENT when no toggle is wired, even with changes to show', () => {
    // The collab composer's case: a control over a transcript, mounted where
    // there is no transcript, would be a button that does nothing.
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    expect(container.querySelector('.changes-pill')).not.toBeNull();
    expect(container.querySelector('.focus-eye')).toBeNull();
  });

  it('reports its state through aria-pressed, both ways', () => {
    // Both halves: an assertion that it is "false" proves nothing unless the
    // same button says "true" when focus is on.
    const off = render(ChangesPill, { onToggleFocus: () => {} }).container;
    expect(off.querySelector('.focus-eye')!.getAttribute('aria-pressed')).toBe('false');
    const on = render(ChangesPill, { focused: true, onToggleFocus: () => {} }).container;
    expect(on.querySelector('.focus-eye')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('flips the title so the button says what the NEXT click will do', () => {
    const off = render(ChangesPill, { onToggleFocus: () => {} }).container;
    expect((off.querySelector('.focus-eye') as HTMLElement).title).toContain('only the conversation');
    const on = render(ChangesPill, { focused: true, onToggleFocus: () => {} }).container;
    expect((on.querySelector('.focus-eye') as HTMLElement).title).toContain('Exit focus');
  });

  it('clicking calls the toggle and nothing else — the caller owns the flag', async () => {
    const onToggleFocus = vi.fn();
    const { container } = render(ChangesPill, { changes: TWO_FILES, onToggleFocus });
    await fireEvent.click(container.querySelector('.focus-eye')!);
    expect(onToggleFocus).toHaveBeenCalledTimes(1);
    // No optimistic self-update: the state is per-chat and lives on the session.
    expect(container.querySelector('.focus-eye')!.getAttribute('aria-pressed')).toBe('false');
    // And it is not a host action — nothing goes over the wire.
    expect(post()).not.toHaveBeenCalled();
  });

  // DELIBERATELY NOT TESTED HERE: what a click on the eye does while the changes
  // popover is open. In a real window the popover's `.cp-backdrop` is a fixed,
  // full-screen catcher above it, so that click closes the list and never
  // reaches the eye — and jsdom, which has no layout, would happily let the
  // click through and "prove" the opposite. That is the exact shape of a test
  // that looks rigorous and asserts nothing.
});

describe('ChangesPill — the per-file list', () => {
  beforeEach(() => post().mockReset());

  it('is closed until the pill is clicked, and lists one row per file when open', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    expect(container.querySelector('.cp-pop')).toBeNull();

    await fireEvent.click(container.querySelector('.changes-pill')!);
    const rows = container.querySelectorAll('.cp-file');
    expect(rows.length).toBe(2);
    expect(container.querySelector('.changes-pill')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the basename prominently and keeps the FULL path on the row title', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.click(container.querySelector('.changes-pill')!);
    const rows = [...container.querySelectorAll('.cp-file')] as HTMLElement[];

    expect(rows[0].querySelector('.cp-name')!.textContent).toBe('acpClient.ts');
    expect(rows[0].title).toBe('/w/packages/vscode/src/acpClient.ts');
    // A Windows path splits on the backslash too — otherwise the whole path
    // would render as the "basename" and the column would blow out.
    expect(rows[1].querySelector('.cp-name')!.textContent).toBe('brandNew.ts');
    expect(rows[1].title).toBe('C:\\w\\webview\\dashboard\\panes\\brandNew.ts');
  });

  it('carries per-file counts on each row', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.click(container.querySelector('.changes-pill')!);
    const rows = [...container.querySelectorAll('.cp-file')] as HTMLElement[];
    expect(rows[0].querySelector('.cp-add')!.textContent).toBe('+300');
    expect(rows[0].querySelector('.cp-del')!.textContent).toBe('−40');
    expect(rows[1].querySelector('.cp-add')!.textContent).toBe('+12');
    expect(rows[1].querySelector('.cp-del')!.textContent).toBe('−0');
  });

  it('marks a CREATED file and only that one', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.click(container.querySelector('.changes-pill')!);
    const rows = [...container.querySelectorAll('.cp-file')] as HTMLElement[];
    expect(rows[0].querySelector('.cp-new')).toBeNull();
    expect(rows[1].querySelector('.cp-new')).not.toBeNull();
    expect(rows[1].querySelector('.cp-new')!.textContent).toBe('new');
  });

  it('clicking a row opens that file at its full path', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.click(container.querySelector('.changes-pill')!);
    await fireEvent.click(container.querySelectorAll('.cp-file')[0]);
    expect(post()).toHaveBeenCalledWith({
      type: 'openAbsoluteFile',
      path: '/w/packages/vscode/src/acpClient.ts',
    });
  });
});

describe('ChangesPill — closing the list', () => {
  beforeEach(() => post().mockReset());

  it('a second click on the pill closes it', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.click(container.querySelector('.changes-pill')!);
    expect(container.querySelector('.cp-pop')).not.toBeNull();
    await fireEvent.click(container.querySelector('.changes-pill')!);
    expect(container.querySelector('.cp-pop')).toBeNull();
  });

  it('Escape closes it', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.click(container.querySelector('.changes-pill')!);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.cp-pop')).toBeNull();
  });

  it('a click OUTSIDE (the backdrop) closes it', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.click(container.querySelector('.changes-pill')!);
    const backdrop = container.querySelector('.cp-backdrop');
    expect(backdrop, 'the full-screen click catcher must exist while open').not.toBeNull();
    await fireEvent.click(backdrop!);
    expect(container.querySelector('.cp-pop')).toBeNull();
  });

  it('Escape while CLOSED does nothing (no crash, still hidden)', async () => {
    const { container } = render(ChangesPill, { changes: TWO_FILES });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.cp-pop')).toBeNull();
    expect(container.querySelector('.changes-pill')).not.toBeNull();
  });
});

// The theme-discipline proof ModeControl.test.ts established, for the same
// reason: this file is NOT in architecture.test.ts's THEMED_FILES list because
// it carries the composer's drop shadow verbatim (rgba(0,0,0,0.28)), and no
// --og-* shadow var exists. Every value that IS a colour still has to be a var.
describe('ChangesPill — theme tokens', () => {
  // path.resolve, NOT `new URL(..., import.meta.url)`: vite rewrites the latter
  // into an asset URL and the read dies with "The URL must be of scheme file",
  // taking the whole suite's collection with it. Same form ModeControl.test.ts uses.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'ChangesPill.svelte'), 'utf8');

  it('uses --og-* tokens for every colour, the shadow alone excepted', () => {
    const literals = [
      ...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...src.matchAll(/\brgba?\([^)]*\)/g),
      ...src.matchAll(/\bhsla?\([^)]*\)/g),
      ...src.matchAll(/:\s*(white|black)\s*;/g),
    ].map((m) => m[0]);
    expect(literals, `unexpected literal colour(s): ${literals.join(', ')}`)
      .toEqual(['rgba(0, 0, 0, 0.28)']);
  });

  it('names only tokens that theme.css actually defines', () => {
    // The --og-green trap: `var(--og-green, #4caf50)` renders fine and ignores
    // the user's theme in all five palettes. A token that is not in theme.css
    // is a bug even though nothing looks broken in the one theme you tried.
    const theme = readFileSync(path.resolve(here, '..', '..', 'shared', 'theme.css'), 'utf8');
    const used = [...new Set([...src.matchAll(/var\((--og-[a-z0-9-]+)/g)].map((m) => m[1]))];
    expect(used.length, 'the component should name several tokens').toBeGreaterThan(3);
    for (const token of used) {
      expect(theme.includes(`${token}:`), `${token} is not defined in theme.css`).toBe(true);
    }
  });

  // The SAME complaint has now come back from UAT twice — a dead band above the
  // textarea (0.4.60), then a row inset from the box and stretched across the
  // whole footer (0.4.61). Both were this one declaration. Reading the source
  // is the only way to hold it: the row's spacing comes from the composer's
  // `.input-row`, and jsdom has no stylesheet to ask instead.
  it('gives the row NO padding of its own — the composer sets that inset', () => {
    const rule = /\.changes-row\s*\{([^}]*)\}/.exec(src);
    expect(rule, '.changes-row must still exist').not.toBeNull();
    const padding = /padding:\s*([^;]+);/.exec(rule![1]);
    expect(padding?.[1].trim(), 'any padding here re-opens the UAT complaint').toBe('0');
  });
});
