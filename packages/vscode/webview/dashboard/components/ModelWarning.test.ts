// The connectivity strip, as its own component (0.4.61 extraction).
//
// The copy rules are modelBanner.ts's and are proven there; what moved INTO
// this file when it left InputBar.svelte is the GATE — InputBar used to hold
// `{#if !bare && !modelOnline}` and now holds only `{#if !bare}` — and the
// TOOLTIP, which the composer-level tests never looked at. Those two are what
// this suite is for; the copy is asserted only where it proves the wiring
// between the rule and the markup is the right way round.
//
// Structure and text only: vitest.config.mts does not set `css: true`, so no
// <style> reaches this DOM. Whether the amber wash reads as an alarm is a
// question for a human eye.

import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ModelWarning from './ModelWarning.svelte';
import { PROVIDER_PROBING } from './modelBanner';

const strip = (c: HTMLElement) => c.querySelector('.model-warning') as HTMLElement | null;

describe('ModelWarning — the gate that came with the extraction', () => {
  it('draws NOTHING once a model has answered', () => {
    // InputBar no longer tests `!modelOnline` at the mount, so if this gate is
    // wrong the strip stands over every healthy chat forever.
    const { container } = render(ModelWarning, { online: true, reason: PROVIDER_PROBING, providerLabel: 'Spark' });
    expect(strip(container)).toBeNull();
  });

  it('draws the strip with NO props at all — an unmounted-yet provider is not "fine"', () => {
    const { container } = render(ModelWarning, {});
    expect(strip(container)).not.toBeNull();
  });
});

describe('ModelWarning — which of the three, and what the tooltip says', () => {
  it('probing: neutral copy, the neutral class, and a tooltip that asks for nothing', () => {
    const { container } = render(ModelWarning, {
      reason: PROVIDER_PROBING, providerIsLocal: false, providerLabel: 'Spark',
    });
    const el = strip(container)!;
    expect(el.textContent).toContain('Checking Spark…');
    expect(el.classList.contains('probing')).toBe(true);
    expect(el.title).toContain('settles on its own');
  });

  it('offline-remote: the tooltip is the harness\'s OWN words, not a paraphrase', () => {
    const { container } = render(ModelWarning, {
      reason: 'ECONNREFUSED 100.64.1.20:8000', providerIsLocal: false, providerLabel: 'Spark',
    });
    const el = strip(container)!;
    expect(el.textContent).toContain('Spark unreachable');
    expect(el.classList.contains('probing')).toBe(false);
    expect(el.title).toBe('ECONNREFUSED 100.64.1.20:8000');
  });

  it('offline-local names LM Studio and nothing remote', () => {
    const { container } = render(ModelWarning, { reason: 'no model loaded', providerIsLocal: true });
    const el = strip(container)!;
    expect(el.textContent).toContain('start LM Studio');
    expect(el.textContent).not.toMatch(/unreachable/i);
  });

  it('offline with NO reason still says something true in the tooltip', () => {
    // A hover that shows an empty box reads as a broken UI, so the fallback is
    // load-bearing rather than decoration.
    const { container } = render(ModelWarning, { providerIsLocal: false, providerLabel: 'Spark' });
    expect(strip(container)!.title).toBe('No model reported by the harness yet.');
  });
});
