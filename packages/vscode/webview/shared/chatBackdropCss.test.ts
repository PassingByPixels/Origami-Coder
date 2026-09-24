// t-qn0wj5, proposal 24: the dot-grid CSS itself — a static gradient, no
// literal colour, and a reduced-motion kill switch. The on/off LOGIC (setting
// AND reduced-motion) is covered separately in
// webview/dashboard/panes/chatBackdropClass.test.ts, which is DOM-free; this
// file only proves the CSS side of the contract exists and is token-only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const themeCss = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'theme.css'),
  'utf8',
);

describe('chat-pane dot-grid backdrop CSS (t-qn0wj5, proposal 24)', () => {
  it('draws the lattice as a token-based radial-gradient, not a literal colour', () => {
    const match = themeCss.match(/\.chat-pane\.chat-backdrop\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const body = match![1];
    expect(body).toContain('var(--og-text)');
    const literals = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
    expect(literals.map((m) => m[0])).toEqual([]);
  });

  it('is switched off under prefers-reduced-motion', () => {
    expect(themeCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.chat-pane\.chat-backdrop\s*\{\s*background-image:\s*none;/,
    );
  });
});
