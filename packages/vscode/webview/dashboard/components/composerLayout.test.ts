// The approved composer layout (Mock-Redesign CHANGES.md round 3 changes 43,
// 44, 55 and round 2 changes 25, 27, 28), ported into the product.
//
// These are DOM-ORDER and BEHAVIOUR assertions, not pixel ones: jsdom has no
// layout, so anything that can only be seen (the 12px right-edge alignment,
// the fill animation) is asserted against the CSS source instead and shot in
// the mock. What is asserted here is what the product must actually do.

import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import InputBar from './InputBar.svelte';
import { HOLD_MS } from './holdToStop';

afterEach(cleanup);
beforeEach(() => { globalThis.__vscodeApiMock.postMessage.mockClear(); });

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.join(here, file), 'utf8');

const CHANGES = { fileCount: 1, adds: 1, dels: 1, files: [{ path: 'a.ts', adds: 1, dels: 1 }] };

function mount(props: Record<string, unknown> = {}) {
  return render(InputBar, {
    props: {
      inFlight: false, agentName: 'Tsuru', modelName: 'qwen3-8b', modelOnline: true,
      sessionId: 'sess-1', onSend: () => {}, onCancel: () => {},
      changes: CHANGES, onToggleFocus: () => {}, onExport: () => {}, canExport: true,
      ...props,
    },
  });
}

/** A real usage frame — the gauge only draws once tokens are in play. */
async function withUsage(container: HTMLElement, used = 8800, size = 10000) {
  await fireEvent(window, new MessageEvent('message', {
    data: { type: 'usageUpdate', sessionId: 'sess-1', used, size },
  }));
  await waitFor(() => expect(container.querySelector('.ctx-gauge')).toBeTruthy());
}

describe('acceptance 1 — the composer rows match composer-zoom.png', () => {
  it('the model bar is the picker on the left and files · turns · gauge in one right-hand group', async () => {
    const { container } = mount();
    await withUsage(container);
    const bar = container.querySelector('.model-bar') as HTMLElement;
    const meta = bar.querySelector('.ctx-meta') as HTMLElement;
    expect(meta).toBeTruthy();
    // The picker is NOT in the group — it stays alone on the left.
    expect(meta.querySelector('.mp-trigger')).toBeNull();
    const at = (sel: string) => {
      const el = meta.querySelector(sel) as HTMLElement;
      expect(el, sel).toBeTruthy();
      return el;
    };
    const chip = at('.changes-pill');
    const turns = at('.ctx-turns');
    const gauge = at('.ctx-gauge-wrap');
    const follows = (a: HTMLElement, b: HTMLElement) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(chip, turns)).toBe(true);
    expect(follows(turns, gauge)).toBe(true);
  });

  it('the files chip left the utility row for the model bar', async () => {
    const { container } = mount();
    await withUsage(container);
    expect(container.querySelector('.composer-util .changes-pill')).toBeNull();
    expect(container.querySelector('.model-bar .changes-pill')).toBeTruthy();
  });

  it('the utility row is repo pill, branch pill, then the second-opinion and focus icons', async () => {
    const { container } = mount();
    const row = container.querySelector('.composer-util') as HTMLElement;
    expect(row).toBeTruthy();
    const kids = [...row.children];
    expect(kids.at(-1)?.className).toContain('row-end');
    expect(row.querySelector('[data-testid="repo-pill"]')).toBeTruthy();
    expect(row.querySelector('[data-testid="branch-pill"]')).toBeTruthy();
    // Repo before branch before the right-hand group.
    const repo = row.querySelector('[data-testid="repo-pill"]') as HTMLElement;
    const branch = row.querySelector('[data-testid="branch-pill"]') as HTMLElement;
    const end = row.querySelector('.row-end') as HTMLElement;
    expect(repo.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(branch.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The eye and the scales are still in it.
    expect(end.querySelector('[data-testid="focus-eye"], .focus-eye')).toBeTruthy();
  });

  it('the mode row is / Plan Approve Vision on the left and Export on the right', () => {
    const { container } = mount();
    const row = container.querySelector('.mode-row') as HTMLElement;
    const labels = [...row.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
    expect(labels[0]).toBe('/');
    expect(labels.at(-1)).toContain('Export');
    // Plan (the mode trigger), Approve and Vision stay SEPARATE buttons —
    // proposal 7's segmented control was rejected.
    expect(container.querySelector('.mode-row .rd-seg, .mode-row .segmented')).toBeNull();
    expect(row.querySelector('.mode-wrap')).toBeTruthy();
    expect(row.querySelector('.approve-wrap')).toBeTruthy();
    const exportBtn = row.querySelector('.export-md-btn') as HTMLElement;
    expect(exportBtn.parentElement === row || exportBtn.parentElement?.className.includes('export')).toBe(true);
  });

  it('the row shares one height and one radius (CSS source)', () => {
    const css = source('ComposerModeRow.svelte');
    expect(css).toMatch(/:global\(\.mode-btn\)\s*\{[^}]*height:\s*22px/);
    expect(css).toMatch(/:global\(\.mode-btn\)\s*\{[^}]*border-radius:\s*6px/);
  });
});

describe('acceptance 2 — send and stop are one control, and stop is a hold', () => {
  it('at rest there is one action button and no Cancel', () => {
    const { container } = mount();
    expect(container.querySelector('.btn.cancel')).toBeNull();
    const btn = container.querySelector('.action-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('Send');
  });

  it('at rest a click sends', async () => {
    const onSend = vi.fn();
    const { container } = mount({ onSend });
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: 'hello' } });
    await fireEvent.click(container.querySelector('.action-btn') as HTMLElement);
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('while a turn runs the button becomes Stop and a CLICK does not stop it', async () => {
    const onCancel = vi.fn();
    const { container } = mount({ inFlight: true, onCancel });
    const btn = container.querySelector('.action-btn') as HTMLButtonElement;
    expect(btn.getAttribute('aria-label')).toMatch(/stop/i);
    expect(btn.dataset.busy).toBe('');
    await fireEvent.click(btn);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a short press does not stop the turn; a 600ms hold does', async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn();
      const { container } = mount({ inFlight: true, onCancel });
      const btn = container.querySelector('.action-btn') as HTMLButtonElement;

      await fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
      vi.advanceTimersByTime(200);
      await fireEvent.pointerUp(btn, { pointerId: 1 });
      vi.advanceTimersByTime(HOLD_MS * 2);
      expect(onCancel).not.toHaveBeenCalled();

      await fireEvent.pointerDown(btn, { button: 0, pointerId: 2 });
      vi.advanceTimersByTime(HOLD_MS);
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a drag off the button releases the hold — the turn is not stopped a second later', async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn();
      const { container } = mount({ inFlight: true, onCancel });
      const btn = container.querySelector('.action-btn') as HTMLButtonElement;
      await fireEvent.pointerDown(btn, { button: 0, pointerId: 1 });
      vi.advanceTimersByTime(100);
      await fireEvent.pointerLeave(btn, { pointerId: 1 });
      vi.advanceTimersByTime(HOLD_MS * 2);
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('acceptance 3 — the gauge percentage animates on change', () => {
  it('the percentage is a digit counter, one column per place, and the fuse button is untouched', async () => {
    const { container } = mount();
    await withUsage(container, 8800, 10000);
    const pct = container.querySelector('.ctx-pct') as HTMLElement;
    expect(pct.textContent).toContain('88');
    expect(pct.querySelectorAll('.counter-digit')).toHaveLength(2);
    expect(pct.querySelectorAll('.counter-digit:first-child .counter-num')).toHaveLength(10);
    // The gauge is still the fuse button: same class, same role.
    const gauge = container.querySelector('.ctx-gauge') as HTMLElement;
    expect(gauge.classList.contains('fuse-button')).toBe(true);
    expect(gauge.getAttribute('role')).toBe('button');
  });

  it('a new reading moves the columns rather than redrawing a different number of them', async () => {
    const { container } = mount();
    await withUsage(container, 8800, 10000);
    const digit = () => container.querySelector('.counter-digit:last-child') as HTMLElement;
    const before = (digit().querySelector('.counter-num:nth-child(9)') as HTMLElement).style.transform;
    await fireEvent(window, new MessageEvent('message', {
      data: { type: 'usageUpdate', sessionId: 'sess-1', used: 8600, size: 10000 },
    }));
    await waitFor(() => {
      const after = (digit().querySelector('.counter-num:nth-child(9)') as HTMLElement).style.transform;
      expect(after).not.toBe(before);
    });
    expect(container.querySelectorAll('.counter-digit')).toHaveLength(2);
  });
});

describe('acceptance 4 — the composer says where a file lands', () => {
  it('dragging over the composer shows the dashed drop state and its label', async () => {
    const { container } = mount();
    const area = container.querySelector('.input-area') as HTMLElement;
    expect(area.classList.contains('dropping')).toBe(false);
    await fireEvent.dragEnter(area, { dataTransfer: { types: ['Files'] } });
    expect(area.classList.contains('dropping')).toBe(true);
    expect(area.textContent).toContain('Drop to attach');
  });

  it('crossing onto the textarea does not flicker the state off', async () => {
    const { container } = mount();
    const area = container.querySelector('.input-area') as HTMLElement;
    const box = container.querySelector('textarea.input') as HTMLElement;
    await fireEvent.dragEnter(area, { dataTransfer: { types: ['Files'] } });
    await fireEvent.dragEnter(box, { dataTransfer: { types: ['Files'] } });
    await fireEvent.dragLeave(area, { dataTransfer: { types: ['Files'] } });
    expect(area.classList.contains('dropping')).toBe(true);
  });

  it('the drop clears the state and still attaches the file', async () => {
    const { container } = mount();
    const area = container.querySelector('.input-area') as HTMLElement;
    const box = container.querySelector('textarea.input') as HTMLTextAreaElement;
    await fireEvent.dragEnter(area, { dataTransfer: { types: ['Files'] } });
    await fireEvent.drop(box, {
      dataTransfer: { getData: (k: string) => (k === 'text/uri-list' ? 'file:///C:/a/b.ts' : ''), files: [] },
    });
    expect(area.classList.contains('dropping')).toBe(false);
    expect(box.value).toContain('C:\\a\\b.ts');
  });

  it('the drop state is a dashed inset border in the chat token (CSS source)', () => {
    const css = source('InputBar.svelte');
    expect(css).toMatch(/\.drop-hint\s*\{[^}]*dashed var\(--og-chat\)/);
    expect(css).toMatch(/Drop to attach/);
  });
});

describe('acceptance 5 — a composer-anchored warm card lines up with the composer', () => {
  it('the breakdown card hangs off the composer, not the gauge', async () => {
    const { container } = mount();
    await fireEvent(window, new MessageEvent('message', {
      data: {
        type: 'usageUpdate', sessionId: 'sess-1', used: 8800, size: 10000,
        composition: { systemPrompt: 100, tools: 200, conversation: 8500 },
      },
    }));
    await waitFor(() => expect(container.querySelector('.ctx-gauge-wrap')).toBeTruthy());
    const wrap = container.querySelector('.ctx-gauge-wrap') as HTMLElement;
    await fireEvent.mouseEnter(wrap);
    const pop = await waitFor(() => {
      const el = container.querySelector('.ctx-card-pop');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // Its parent is the composer itself — that is what makes the right edge
    // land on the composer's border rather than centred on a 20px gauge.
    expect(pop.parentElement?.classList.contains('input-area')).toBe(true);
  });

  it('the card is pinned to the composer right edge and capped to its measure (CSS source)', () => {
    const css = source('InputBar.svelte');
    const rule = /\.ctx-card-pop\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/right:\s*var\(--composer-gutter\)/);
    expect(rule).toMatch(/max-width:\s*calc\(100% - 2 \* var\(--composer-gutter\)\)/);
    expect(rule).not.toMatch(/left:\s*50%/);
  });

  it('a warm tip on a composer control asks for the same anchoring', () => {
    const css = source('InputBar.svelte');
    // The gauge's own tip opts in; the anchoring itself is warmTip's.
    expect(css).toMatch(/anchor:\s*'composer'/);
  });
});
