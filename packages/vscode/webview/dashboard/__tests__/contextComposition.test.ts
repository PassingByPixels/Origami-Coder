// The gauge's breakdown data, and the mirror it depends on.
//
// Two classes of bug here. The first is a card whose parts do not add up to the
// gauge beside it — the numbers are the whole feature, so a row that lies is
// worse than no card. The second is drift: the shape is declared in
// `src/acpClient.ts` (the host parses it) and again in the webview leaf, because
// tsconfig.webview.json pins rootDir to `webview/` and a webview `.ts` file trips
// TS6059 on ANY import from `src/`, `import type` included. Nothing but a test
// that reads BOTH files can notice when one gains a field and the other does not.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { asComposition, breakdownRows, fmtTokens, usedOf, type ContextComposition } from '../components/contextComposition';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const composition = (over: Partial<ContextComposition> = {}): ContextComposition => ({
  systemPrompt: 1800,
  tools: 4200,
  conversation: 106900,
  estimated: true,
  method: 'chars/4',
  ...over,
});

/** The field list of a `ContextComposition = { ... }` type literal in a file. */
function fields(rel: string): string[] {
  const src = readFileSync(path.join(pkgRoot, rel), 'utf8');
  const match = /export type ContextComposition = \{([\s\S]*?)\n\};/.exec(src);
  if (!match) throw new Error(`no ContextComposition type literal found in ${rel}`);
  return [...match[1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
}

describe('ContextComposition mirror — the host type and the webview type agree', () => {
  it('finds a real type in both files (guards the regex itself)', () => {
    expect(fields('src/acpClient.ts').length).toBeGreaterThan(3);
  });

  it('both declare exactly the same fields', () => {
    expect(fields('webview/dashboard/components/contextComposition.ts')).toEqual(fields('src/acpClient.ts'));
  });
});

describe('breakdownRows', () => {
  it('the parts add up to the header total, and with the headroom to the window', () => {
    const rows = breakdownRows(composition(), 128000);
    const parts = rows.filter((r) => r.kind !== 'headroom').reduce((sum, r) => sum + r.tokens, 0);

    expect(parts).toBe(usedOf(composition()));
    expect(rows.reduce((sum, r) => sum + r.tokens, 0)).toBe(128000);
  });

  it('every segment is a share of the WINDOW, so the widths sum to 100', () => {
    const rows = breakdownRows(composition(), 128000);

    expect(rows.reduce((sum, r) => sum + r.pct, 0)).toBeCloseTo(100, 6);
    // 1800 of 128000 = 1.40625%, the same arithmetic the mock's reference used.
    expect(rows[0].pct).toBeCloseTo((1800 / 128000) * 100, 6);
  });

  it('an unknown window shows NO headroom row rather than a made-up remainder', () => {
    const rows = breakdownRows(composition(), 0);

    expect(rows.map((r) => r.id)).toEqual(['systemPrompt', 'tools', 'conversation']);
    expect(rows.reduce((sum, r) => sum + r.pct, 0)).toBeCloseTo(100, 6);
  });

  it('a window already overrun shows no headroom either — a negative part is never drawn', () => {
    const rows = breakdownRows(composition({ conversation: 200000 }), 128000);

    expect(rows.some((r) => r.kind === 'headroom')).toBe(false);
    expect(rows.every((r) => r.tokens >= 0)).toBe(true);
  });

  it('the conversation row says it carries the attached files, because nothing can split them', () => {
    expect(breakdownRows(composition(), 128000)[2].label).toBe('Conversation + files');
  });
});

describe('asComposition', () => {
  it('accepts the engine frame', () => {
    expect(asComposition(composition())).toEqual(composition());
  });

  it('rejects a half-read frame rather than drawing a bar with a hole in it', () => {
    expect(asComposition({ systemPrompt: 10, tools: 20 })).toBeUndefined();
    expect(asComposition({ systemPrompt: 10, tools: 20, conversation: -5 })).toBeUndefined();
    expect(asComposition({ systemPrompt: 10, tools: 20, conversation: 'lots' })).toBeUndefined();
    expect(asComposition(undefined)).toBeUndefined();
  });
});

describe('fmtTokens', () => {
  it('groups thousands — the card reads as counts, not as the gauge 38k', () => {
    expect(fmtTokens(112900)).toBe('112,900');
    expect(fmtTokens(900)).toBe('900');
  });
});
