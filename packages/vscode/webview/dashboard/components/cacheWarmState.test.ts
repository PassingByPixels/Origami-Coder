import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cacheWarmView } from './cacheWarmState';

const NOW = 1_700_000_000_000;

describe('cacheWarmState — the three states the engine can report', () => {
  it('warm with a published window names the window AND what is left of it', () => {
    const view = cacheWarmView({ state: 'warm', ttlSeconds: 300, until: NOW + 240_000, now: NOW });
    expect(view.state).toBe('warm');
    expect(view.icon).toBe('●');
    expect(view.title).toContain('Cache warm');
    expect(view.title).toContain("This provider's window is 5 min");
    expect(view.title).toContain('about 4 min left');
  });

  // The whole point of the `until`-is-absent rule: a countdown the provider
  // never promised must not appear.
  it('warm with NO window says so, and shows no countdown', () => {
    const view = cacheWarmView({ state: 'warm', now: NOW });
    expect(view.state).toBe('warm');
    expect(view.title).toContain('publishes no cache window');
    expect(view.title).not.toContain('min left');
  });

  it('cold says the next request pays for the whole prompt', () => {
    const view = cacheWarmView({ state: 'cold', now: NOW });
    expect(view.state).toBe('cold');
    expect(view.icon).toBe('○');
    expect(view.title).toContain('Cache cold');
    expect(view.title).toContain('pays for the whole prompt');
  });

  // "Nothing was reported" is not "the prefix is gone".
  it('unmeasured is its own answer, not a quiet cold', () => {
    const view = cacheWarmView({ state: 'unmeasured', now: NOW });
    expect(view.state).toBe('unmeasured');
    expect(view.icon).toBe('–');
    expect(view.title).toContain('reports no cache tokens');
  });

  it('a state this build does not know falls to unmeasured, never to warm', () => {
    expect(cacheWarmView({ state: '', now: NOW }).state).toBe('unmeasured');
    expect(cacheWarmView({ state: 'lukewarm', now: NOW }).state).toBe('unmeasured');
  });

  it('the three states carry three different glyphs and three different titles', () => {
    const views = ['warm', 'cold', 'unmeasured'].map((state) => cacheWarmView({ state, now: NOW }));
    expect(new Set(views.map((v) => v.icon)).size).toBe(3);
    expect(new Set(views.map((v) => v.title)).size).toBe(3);
  });

  // The engine's expiry push can land a moment late. "-1 min left" would be a
  // lie about a fact the badge does not own.
  it('an already-elapsed window reads 0 min left, never a negative one', () => {
    const view = cacheWarmView({ state: 'warm', ttlSeconds: 300, until: NOW - 90_000, now: NOW });
    expect(view.title).toContain('about 0 min left');
  });

  // `ttlSeconds` without `until` (or the reverse) is a half-answer; treated as
  // no window rather than as a countdown from an unknown start.
  it('a half-reported window is treated as no window', () => {
    expect(cacheWarmView({ state: 'warm', ttlSeconds: 300, now: NOW }).title).toContain('publishes no cache window');
    expect(cacheWarmView({ state: 'warm', until: NOW + 60_000, now: NOW }).title).toContain(
      'publishes no cache window',
    );
  });
});

// jsdom has no layout and no cascade worth trusting, so the colours are checked
// where they are actually written: in the file. Five themes ship, two of them
// dark, and a literal colour is invisible in at least one of them.
describe('CacheWarmDot — theme tokens only', () => {
  const src = readFileSync(path.join(__dirname, 'CacheWarmDot.svelte'), 'utf8');
  const style = src.slice(src.indexOf('<style>'));

  it('every colour and background in the leaf is an --og-* var', () => {
    const values = [...style.matchAll(/(?:^|[\s;{])(?:color|background(?:-color)?)\s*:\s*([^;}]+)/g)].map((m) =>
      m[1].trim(),
    );
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((v) => !/^var\(--og-[a-z0-9-]+\)$/.test(v))).toEqual([]);
  });

  it('it carries no literal colour of any kind', () => {
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(style).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
  });

  // A status glyph. A click has nothing to open, so there is no button to press.
  it('the badge is not a control', () => {
    expect(src).not.toContain('<button');
    expect(src).not.toContain('onclick');
  });
});
