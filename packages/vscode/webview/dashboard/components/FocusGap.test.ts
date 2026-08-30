// FocusGap.test.ts — the divider focus view leaves behind, rendered.
//
// Structure and text only. `vitest.config.mts` does not set `css: true`, so no
// <style> element reaches this DOM and getComputedStyle answers '' for
// everything: whether the rule is a hairline, whether the count is centred and
// whether the whole thing is quiet enough to sit between two answers all need
// a human eye. What IS checkable here is the part a screenshot would not
// catch — that it says exactly what focusGaps.ts wrote, that it points at the
// control which brings the rows back, and that it offers nothing to click.

import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import FocusGap from './FocusGap.svelte';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, 'FocusGap.svelte'), 'utf8');

const LABEL = '38 tools · 16 file reads · 2 thoughts';

describe('FocusGap — what the divider says', () => {
  it('renders the label verbatim and adds no prose of its own', () => {
    // Exact, not "contains": the wording is focusGaps.ts's, asserted there. A
    // component that appended its own "hidden" or "…" would put text on screen
    // that no test of the wording covers.
    const { container } = render(FocusGap, { label: LABEL });
    expect(container.textContent?.trim()).toBe(LABEL);
  });

  it('is ONE top-level .focus-gap element — the transcript renders it as a row', () => {
    // ChatTranscript's {#each} takes the component's root as the row: a second
    // top-level element here would shift every signature after it.
    const { container } = render(FocusGap, { label: '1 thought' });
    expect(container.children).toHaveLength(1);
    expect((container.children[0] as HTMLElement).classList.contains('focus-gap')).toBe(true);
  });

  it('points at the eye, which is the only thing that brings the rows back', () => {
    const el = render(FocusGap, { label: LABEL }).container.querySelector('.focus-gap');
    expect(el?.getAttribute('title')).toBe('Hidden by focus — click the eye to show everything');
  });
});

describe('FocusGap — it promises nothing it cannot do', () => {
  it('offers no button, link, role or tab stop: there is no expand here', () => {
    // The rows come back from the composer's eye, one place, always in the same
    // spot. Anything clickable-looking on the divider would promise a
    // disclosure that does not exist.
    const { container } = render(FocusGap, { label: LABEL });
    expect(container.querySelector('button, a, [role], [tabindex]')).toBeNull();
  });

  it('has no event handler in its markup', () => {
    // The DOM check above cannot see a handler bound to a plain <div>, and a
    // div with an onclick is exactly the shape a later "make it expandable"
    // edit would take without touching the assertions above.
    expect(/\son[a-z]+=/.test(src.split('<style>')[0])).toBe(false);
  });

  it('leaves the hairlines out of the accessible name', () => {
    // The two rules are decoration; a screen reader announcing them as empty
    // spans around the count is noise on a row that is already secondary.
    const { container } = render(FocusGap, { label: LABEL });
    const rules = container.querySelectorAll('.focus-gap-rule');
    expect(rules).toHaveLength(2);
    rules.forEach((r) => expect(r.getAttribute('aria-hidden')).toBe('true'));
  });
});

describe('FocusGap — theme discipline', () => {
  it('names only tokens that theme.css actually defines', () => {
    // The --og-green trap: `var(--og-green, #4caf50)` renders fine and ignores
    // the user's theme in all five palettes. architecture.test.ts proves this
    // file holds no literal colour; this proves the vars it does name exist.
    const theme = readFileSync(path.resolve(here, '..', '..', 'shared', 'theme.css'), 'utf8');
    const used = [...new Set([...src.matchAll(/var\((--og-[a-z0-9-]+)/g)].map((m) => m[1]))];
    expect(used.length, 'the divider should name its colours as tokens').toBeGreaterThanOrEqual(2);
    for (const token of used) {
      expect(theme.includes(`${token}:`), `${token} is not defined in theme.css`).toBe(true);
    }
  });
});
