// t-qi0qrh — ModelPickerTab draws a real vendor SVG mark for one of the
// twelve big providers, and keeps the coloured monogram badge for every
// other 'source' tab. Two claims, both about what actually paints, not a
// restatement of vendorMarks.ts's own logic.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ModelPickerTab from './ModelPickerTab.svelte';
import { VENDOR_MARK_PATHS } from '../../shared/vendorMarks';

afterEach(() => cleanup());

const noop = () => {};

describe('ModelPickerTab — vendor SVG marks', () => {
  it('draws the vendor SVG (not the monogram) for a named big provider', () => {
    const { container } = render(ModelPickerTab, {
      props: {
        label: 'Anthropic',
        active: false,
        live: true,
        tip: 'Anthropic — Live',
        mark: { kind: 'source', mark: { monogram: 'AN', color: '#d97757' } },
        onClick: noop,
      },
    });

    const svg = container.querySelector('svg.mp-vendor-icon') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24');
    // Tinted with the SAME colour the monogram badge would have used — compared
    // via a normalized probe, since jsdom serializes an inline hex colour to rgb().
    const probe = document.createElement('div');
    probe.style.color = '#d97757';
    expect(svg.style.color).toBe(probe.style.color);
    expect(svg!.querySelector('path')?.getAttribute('d')).toBe(VENDOR_MARK_PATHS.anthropic.path);
    // The monogram badge must not also be drawn.
    expect(container.querySelector('.mp-source-badge')).toBeNull();
  });

  it('matches on a multi-word display name (LM Studio) that the picker\'s own vendorKey mis-keys', () => {
    const { container } = render(ModelPickerTab, {
      props: {
        label: 'LM Studio',
        active: false,
        live: true,
        tip: 'LM Studio — Live',
        mark: { kind: 'source', mark: { monogram: 'LM', color: '#7c5cff' } },
        onClick: noop,
      },
    });

    const svg = container.querySelector('svg.mp-vendor-icon');
    expect(svg).not.toBeNull();
    expect(svg!.querySelector('path')?.getAttribute('d')).toBe(VENDOR_MARK_PATHS.lmstudio.path);
  });

  it('falls back to the coloured monogram badge for a source with no named mark', () => {
    const { container } = render(ModelPickerTab, {
      props: {
        label: 'OpenCode Zen',
        active: false,
        live: true,
        tip: 'OpenCode Zen — Live',
        mark: { kind: 'source', mark: { monogram: 'OZ', color: 'hsl(120 45% 42%)' } },
        onClick: noop,
      },
    });

    const badge = container.querySelector('.mp-source-badge') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('OZ');
    const probe = document.createElement('div');
    probe.style.background = 'hsl(120 45% 42%)';
    expect(badge.style.background).toBe(probe.style.background);
    expect(container.querySelector('svg.mp-vendor-icon')).toBeNull();
  });

  it('sets no fill-rule attribute on any vendor path (OpenAI and a Simple Icons mark alike)', () => {
    const { container: openaiC } = render(ModelPickerTab, {
      props: {
        label: 'OpenAI', active: false, live: true, tip: 'OpenAI — Live',
        mark: { kind: 'source', mark: { monogram: 'OA', color: '#10a37f' } }, onClick: noop,
      },
    });
    expect(openaiC.querySelector('svg.mp-vendor-icon path')?.getAttribute('fill-rule')).toBeNull();
    cleanup();

    const { container: ollamaC } = render(ModelPickerTab, {
      props: {
        label: 'Ollama', active: false, live: true, tip: 'Ollama — Live',
        mark: { kind: 'source', mark: { monogram: 'OL', color: '#8b8b8b' } }, onClick: noop,
      },
    });
    expect(ollamaC.querySelector('svg.mp-vendor-icon path')?.getAttribute('fill-rule')).toBeNull();
  });

  it('a type-kind tab is unaffected — still draws the stroke glyph, never a vendor mark', () => {
    const { container } = render(ModelPickerTab, {
      props: {
        label: 'Local',
        active: true,
        live: true,
        tip: 'Local — Live',
        mark: { kind: 'type', glyph: { paths: ['M1 1h2v2h-2z'] } },
        onClick: noop,
      },
    });

    expect(container.querySelector('svg.mp-type-icon')).not.toBeNull();
    expect(container.querySelector('svg.mp-vendor-icon')).toBeNull();
    expect(container.querySelector('.mp-source-badge')).toBeNull();
  });
});
