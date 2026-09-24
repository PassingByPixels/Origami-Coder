// t-qn0wj5, proposal 25 (port of Mock-Redesign CHANGES.md #40's SpringCheck).
// jsdom has no layout or transitions (WORKING_ON_ORIGAMI_CODER.md Part 6), so
// the visual spring is proven from source; behaviour (real checkbox, real
// onchange) is proven by render.
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import SpringCheckbox from './SpringCheckbox.svelte';

afterEach(cleanup);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, 'SpringCheckbox.svelte'), 'utf8');

describe('SpringCheckbox — behaviour', () => {
  it('renders a real checkbox reflecting `checked`', () => {
    const { container } = render(SpringCheckbox, { props: { checked: true, onchange: () => {} } });
    const input = container.querySelector<HTMLInputElement>('.og-spring-check')!;
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(true);
  });

  it('calls onchange with the new boolean value, not the DOM event', async () => {
    const onchange = vi.fn();
    const { container } = render(SpringCheckbox, { props: { checked: false, onchange } });
    const input = container.querySelector<HTMLInputElement>('.og-spring-check')!;
    input.checked = true;
    await fireEvent.change(input);
    expect(onchange).toHaveBeenCalledWith(true);
  });

  it('applies aria-label only when the `label` prop is given', () => {
    const bare = render(SpringCheckbox, { props: { checked: false, onchange: () => {} } });
    expect(bare.container.querySelector('.og-spring-check')?.hasAttribute('aria-label')).toBe(false);
    bare.unmount();
    const labelled = render(SpringCheckbox, { props: { checked: false, onchange: () => {}, label: 'Persistent' } });
    expect(labelled.container.querySelector('.og-spring-check')?.getAttribute('aria-label')).toBe('Persistent');
  });
});

describe('SpringCheckbox — the spring CSS (source-level)', () => {
  it('uses an overshoot ("back") easing curve for the check scaling in, not a linear one', () => {
    expect(src).toMatch(/\.og-spring-check:checked\s*\{[^}]*transform:\s*scale\(1\.08\)/);
    expect(src).toContain('cubic-bezier(0.34, 1.56, 0.64, 1)');
  });

  it('carries a reduced-motion branch that removes the overshoot', () => {
    expect(src).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^]*?\.og-spring-check:checked\s*\{\s*transform:\s*none;/,
    );
  });

  it('every colour on the control is an --og-* token', () => {
    const block = src.slice(src.indexOf('<style>'), src.indexOf('</style>'));
    const literals = [...block.matchAll(/#[0-9a-fA-F]{3,8}\b/g), ...block.matchAll(/\brgba?\(/g)];
    expect(literals.map((m) => m[0])).toEqual([]);
  });
});
