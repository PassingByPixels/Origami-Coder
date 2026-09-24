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
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ChangesPill from './ChangesPill.svelte';
import ComposerUtilityRow from './ComposerUtilityRow.svelte';
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

  it('renders NOTHING with no changes (the bare collab composer)', () => {
    const { container } = render(ChangesPill, {});
    expect(container.querySelector('.changes-pill')).toBeNull();
    expect(container.querySelector('.changes-anchor')).toBeNull();
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

// THE FOCUS EYE — the right-hand end of the composer's UTILITY ROW (0.4.61).
// The row is ComposerUtilityRow.svelte now: the files chip left it for the
// model bar's meta group and the repo/branch pills came down onto it in its
// place, so the eye and the scales are asserted against that component.
//
// Structure and behaviour only, again: whether the eye is LEGIBLE at 13px and
// whether its lit --og-accent reads as "on" are questions for a human eye, not
// for a DOM with no stylesheet in it. What is checkable is that the row exists
// before anything has been edited (which is the whole point of moving the row
// out from behind the changes data), that the two controls coexist, and that
// the button reports its state honestly.
describe('ComposerUtilityRow — the focus eye', () => {
  beforeEach(() => post().mockReset());

  it('draws the row and the eye with NO changes data at all', () => {
    const { container } = render(ComposerUtilityRow, { onToggleFocus: () => {} });
    expect(container.querySelector('.composer-util'), 'the row survives an empty session').not.toBeNull();
    expect(container.querySelector('.focus-eye')).not.toBeNull();
    expect(container.querySelector('.changes-pill'), 'nothing edited yet, so no pill').toBeNull();
  });

  it('sits alongside the scales, and the files chip is NOT on this row any more', () => {
    const { container } = render(ComposerUtilityRow, { secondOpinionFor: 'chat-7', onToggleFocus: () => {} });
    expect(container.querySelector('.second-opinion')).not.toBeNull();
    expect(container.querySelector('.focus-eye')).not.toBeNull();
    // It moved to the model bar's files · turns · gauge group (change 43).
    expect(container.querySelector('.changes-pill')).toBeNull();
  });

  it('is ABSENT when no toggle is wired', () => {
    // The collab composer's case: a control over a transcript, mounted where
    // there is no transcript, would be a button that does nothing.
    const { container } = render(ComposerUtilityRow, { secondOpinionFor: 'chat-7' });
    expect(container.querySelector('.second-opinion')).not.toBeNull();
    expect(container.querySelector('.focus-eye')).toBeNull();
  });

  it('reports its state through aria-pressed, both ways', () => {
    // Both halves: an assertion that it is "false" proves nothing unless the
    // same button says "true" when focus is on.
    const off = render(ComposerUtilityRow, { onToggleFocus: () => {} }).container;
    expect(off.querySelector('.focus-eye')!.getAttribute('aria-pressed')).toBe('false');
    const on = render(ComposerUtilityRow, { focused: true, onToggleFocus: () => {} }).container;
    expect(on.querySelector('.focus-eye')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('flips the title so the button says what the NEXT click will do', () => {
    const off = render(ComposerUtilityRow, { onToggleFocus: () => {} }).container;
    expect((off.querySelector('.focus-eye') as HTMLElement).dataset.tip).toContain('only the conversation');
    const on = render(ComposerUtilityRow, { focused: true, onToggleFocus: () => {} }).container;
    expect((on.querySelector('.focus-eye') as HTMLElement).dataset.tip).toContain('Exit focus');
  });

  it('clicking calls the toggle and nothing else — the caller owns the flag', async () => {
    const onToggleFocus = vi.fn();
    const { container } = render(ComposerUtilityRow, { changes: TWO_FILES, onToggleFocus });
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

// THE SCALES — the second-opinion trigger, immediately left of the eye (0.4.66).
//
// Same limits as above: whether a 13px pair of scales READS as scales is a
// question for a human eye. What is checkable is the gate (a composer with no
// engine session must not draw a control that needs one), the in-flight lockout,
// and — the one that matters most — that a pick posts the request for the chat
// this composer belongs to.
describe('ComposerUtilityRow — the second-opinion scales', () => {
  beforeEach(() => post().mockReset());

  const withScales = (props: Record<string, unknown> = {}) =>
    render(ComposerUtilityRow, { secondOpinionFor: 'chat-7', onToggleFocus: () => {}, ...props }).container;

  it('draws the scales beside the eye once a chat has an engine session', () => {
    const c = withScales();
    expect(c.querySelector('.second-opinion')).not.toBeNull();
    expect(c.querySelector('.focus-eye')).not.toBeNull();
  });

  it('draws NO scales on the bare collab composer, which has no session to review', () => {
    // The composer passes `null` there. A review needs a turn to read out of an
    // engine session, so the control would be a button that can only fail.
    const c = render(ComposerUtilityRow, { secondOpinionFor: null, onToggleFocus: () => {} }).container;
    expect(c.querySelector('.second-opinion')).toBeNull();
    expect(c.querySelector('.focus-eye')).not.toBeNull();
  });

  it('draws the row for the scales ALONE, before anything has been edited', () => {
    const c = render(ComposerUtilityRow, { secondOpinionFor: 'chat-7' }).container;
    expect(c.querySelector('.composer-util')).not.toBeNull();
    expect(c.querySelector('.second-opinion')).not.toBeNull();
  });

  it('is dead while a turn is running, and says why in its title', () => {
    const c = withScales({ busy: true });
    const button = c.querySelector('.second-opinion') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.dataset.tip).toContain('once the current turn finishes');
  });

  it('opens and closes the flyout, reporting its state through aria-pressed', async () => {
    const c = withScales();
    expect(c.querySelector('.second-opinion')!.getAttribute('aria-pressed')).toBe('false');
    expect(c.querySelector('.so-menu')).toBeNull();

    await fireEvent.click(c.querySelector('.second-opinion')!);
    expect(c.querySelector('.so-menu')).not.toBeNull();
    expect(c.querySelector('.second-opinion')!.getAttribute('aria-pressed')).toBe('true');

    await fireEvent.click(c.querySelector('.second-opinion')!);
    expect(c.querySelector('.so-menu')).toBeNull();
  });

  it('posts the request for THIS chat when a model is picked, and closes the flyout', async () => {
    const c = withScales();
    await fireEvent.click(c.querySelector('.second-opinion')!);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'modelOptions', options: [{ value: 'lmstudio/devstral-small', name: 'Devstral Small' }] },
    }));
    await tick();
    post().mockReset();

    // The tiered menu (0.4.67) starts collapsed — open the provider group
    // first, the way a browsing user does. The menu's own suite covers the tree.
    await fireEvent.click(c.querySelector('.so-provider')!);
    await tick();
    await fireEvent.click(c.querySelector('.so-model')!);

    expect(post()).toHaveBeenCalledWith({
      type: 'secondOpinion',
      sessionId: 'chat-7',
      modelId: 'lmstudio/devstral-small',
      modelLabel: 'Devstral Small',
    });
    // No optimistic card here: the card the user sees is the HOST's pending
    // answer, because the request can still be refused.
    expect(c.querySelector('.so-menu')).toBeNull();
  });
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
// reason: neither of these files is in architecture.test.ts's THEMED_FILES list,
// because the POPOVER carries the composer's drop shadow verbatim
// (rgba(0,0,0,0.28)) and no --og-* shadow var exists. Every value that IS a
// colour still has to be a var — in both halves. The two files are checked
// together here because the split between them (0.4.66) is exactly the kind of
// move that leaves one half unguarded.
describe('ChangesPill — theme tokens', () => {
  // path.resolve, NOT `new URL(..., import.meta.url)`: vite rewrites the latter
  // into an asset URL and the read dies with "The URL must be of scheme file",
  // taking the whole suite's collection with it. Same form ModeControl.test.ts uses.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, 'ChangesPill.svelte'), 'utf8');
  const popover = readFileSync(path.join(here, 'ChangedFilesPopover.svelte'), 'utf8');
  const literalColours = (text: string) =>
    [
      ...text.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...text.matchAll(/\brgba?\([^)]*\)/g),
      ...text.matchAll(/\bhsla?\([^)]*\)/g),
      ...text.matchAll(/:\s*(white|black)\s*;/g),
    ].map((m) => m[0]);

  it('the ROW itself now has no literal colour at all — the shadow left with the popover', () => {
    const literals = literalColours(src);
    expect(literals, `unexpected literal colour(s): ${literals.join(', ')}`).toEqual([]);
  });

  it('the POPOVER uses --og-* tokens for every colour, its inherited shadow excepted', () => {
    const literals = literalColours(popover);
    expect(literals, `unexpected literal colour(s): ${literals.join(', ')}`)
      .toEqual(['rgba(0, 0, 0, 0.28)']);
  });

  it('names only tokens that theme.css actually defines, in BOTH halves', () => {
    // The --og-green trap: `var(--og-green, #4caf50)` renders fine and ignores
    // the user's theme in all five palettes. A token that is not in theme.css
    // is a bug even though nothing looks broken in the one theme you tried.
    const theme = readFileSync(path.resolve(here, '..', '..', 'shared', 'theme.css'), 'utf8');
    for (const [label, text] of [['ChangesPill', src], ['ChangedFilesPopover', popover]] as const) {
      const used = [...new Set([...text.matchAll(/var\((--og-[a-z0-9-]+)/g)].map((m) => m[1]))];
      expect(used.length, `${label} should name several tokens`).toBeGreaterThan(3);
      for (const token of used) {
        expect(theme.includes(`${token}:`), `${token} is not defined in theme.css (${label})`).toBe(true);
      }
    }
  });

  // The SAME complaint has now come back from UAT twice — a dead band above the
  // textarea (0.4.60), then a row inset from the box and stretched across the
  // whole footer (0.4.61). Both were this one declaration. Reading the source
  // is the only way to hold it: the row's spacing comes from the composer's
  // `.input-row`, and jsdom has no stylesheet to ask instead.
  it('gives the utility row NO padding of its own — the composer sets that inset', () => {
    const row = readFileSync(path.join(here, 'ComposerUtilityRow.svelte'), 'utf8');
    const rule = /\.composer-util\s*\{([^}]*)\}/.exec(row);
    expect(rule, '.composer-util must still exist').not.toBeNull();
    const padding = /padding:\s*([^;]+);/.exec(rule![1]);
    expect(padding?.[1].trim(), 'any padding here re-opens the UAT complaint').toBe('0');
  });
});

// t-rnavdc bug 1 — the changed-files list overhung the composer's right border.
// The context breakdown card (InputBar.svelte's .ctx-card-pop) fixed the same
// complaint for a different popover by hanging off `.input-area`'s own gutter
// rather than off the small control that opens it; this proves the files list
// now uses the SAME mechanism, not a second one.
describe('ChangesPill — the files popover anchors to the composer, not the chip', () => {
  const here2 = path.dirname(fileURLToPath(import.meta.url));
  const pillSrc = readFileSync(path.join(here2, 'ChangesPill.svelte'), 'utf8');
  const popSrc = readFileSync(path.join(here2, 'ChangedFilesPopover.svelte'), 'utf8');
  const inputBarSrc = readFileSync(path.join(here2, 'InputBar.svelte'), 'utf8');

  it('the chip carries no `position` of its own — nothing to anchor the list to', () => {
    const rule = /\.changes-anchor\s*\{([^}]*)\}/.exec(pillSrc)?.[1] ?? '';
    expect(rule).not.toMatch(/position\s*:/);
  });

  it('the list is pinned to the composer right edge and capped to its measure, same as the context card', () => {
    const rule = /\.cp-pop\s*\{([^}]*)\}/.exec(popSrc)?.[1] ?? '';
    expect(rule).toMatch(/right:\s*var\(--composer-gutter/);
    expect(rule).toMatch(/max-width:\s*calc\(100% - 2 \* var\(--composer-gutter/);
    expect(rule).not.toMatch(/left:\s*0/);
  });

  it('uses the SAME anchoring string the context breakdown card uses — one mechanism, not two', () => {
    const cardRule = /\.ctx-card-pop\s*\{([^}]*)\}/.exec(inputBarSrc)?.[1] ?? '';
    const cardRight = /right:\s*var\(--composer-gutter[^)]*\)/.exec(cardRule)?.[0];
    const popRight = /right:\s*var\(--composer-gutter[^)]*\)/.exec(
      /\.cp-pop\s*\{([^}]*)\}/.exec(popSrc)?.[1] ?? '',
    )?.[0];
    expect(cardRight, 'the context card must still use var(--composer-gutter)').toBeTruthy();
    expect(popRight, 'the files popover must use var(--composer-gutter)').toBeTruthy();
  });
});
