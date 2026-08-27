// THE ORIGAMI MENAGERIE, enumerated (W9).
//
// A glyph is ART, and a test cannot say whether a drawing looks like a badger.
// What it CAN say is everything that makes a drawing fail without anyone
// noticing, and every claim below is one of those:
//
//  1. IT RENDERS AT ALL. A polygon with an odd coordinate count, a stray letter,
//     or a NaN produces an <svg> the browser silently drops — an empty 16px box
//     in a picker, which reads as "this bot has no glyph" rather than as a bug.
//  2. IT IS IN FRAME. A point outside 0..64 is clipped by the viewBox, so half a
//     creature draws and nothing warns. Screenshots do not catch this either:
//     the glyph still looks like *something*.
//  3. IT IS OFFERED. A drawing the picker does not list is a drawing that does
//     not exist. The literal list this replaced had already lost `scout`.
//  4. IT INHERITS COLOUR. currentColor is the whole theme story for a glyph; a
//     fill or a stroke smuggled into a polygon would pin one creature to one
//     colour in five themes. There is no place to put one in this shape — which
//     is the point, and asserting it is how the shape stays that way.
//  5. IT IS A DISTINCT ANIMAL. Two keys sharing a polygon list is a menagerie
//     that lies about its size; an alias is how a second NAME is done.
//
// It also asserts the count, because "expand the library" was the request and a
// silent revert to nine would otherwise pass everything above.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import ArchetypeGlyph from '../components/ArchetypeGlyph.svelte';
import { archetypeGlyph, glyphKeys } from '../components/archetypeGlyphs';
import { MENAGERIE } from '../components/menagerieGlyphs';
import { glyphKey, offeredGlyphKeys } from '../components/glyphNames';

const KEYS = glyphKeys();

describe('the picker offers a real menagerie', () => {
  it('offers at least thirty distinct creatures', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  it('offers every one of them under a lowercase animal name', () => {
    for (const key of KEYS) expect(key, `${key} is not a plain lowercase name`).toMatch(/^[a-z]+$/);
  });

  // The seven harvested sets are stored under an AGENT TYPE id. They must still
  // RESOLVE (an agent-type card asks for `debug`), and they must be OFFERED
  // under the creature's name — but never both, or the grid shows one drawing
  // twice under two names.
  it.each([
    ['crane', 'tsuru'],
    ['elephant', 'architect'],
    ['cat', 'ask'],
    ['fox', 'debug'],
    ['wolf', 'orchestrator'],
    ['dragon', 'plan'],
    ['deer', 'cartographer'],
  ])('offers %s, still resolves %s, and lists neither twice', (animal, archetype) => {
    expect(KEYS).toContain(animal);
    expect(KEYS).not.toContain(archetype);
    expect(archetypeGlyph(archetype)).toBe(archetypeGlyph(animal));
    expect(archetypeGlyph(animal)).not.toBeNull();
    // ...and the collab filing prefix still falls off on the way in.
    expect(archetypeGlyph(`collab-${animal}`)).toBe(archetypeGlyph(animal));
  });

  it('resolves every offered key to a glyph', () => {
    for (const key of KEYS) expect(archetypeGlyph(key), key).not.toBeNull();
  });

  // An unknown id must still answer null: ArchetypeGlyph.svelte draws the
  // initial-letter tile on that, and a menagerie that guessed would put a
  // random animal on a bot nobody gave one to.
  it('still answers null for an id it has never heard of', () => {
    expect(archetypeGlyph('nonesuch')).toBeNull();
    expect(archetypeGlyph('')).toBeNull();
  });
});

describe('every glyph is drawable geometry', () => {
  it.each(KEYS)('%s parses as in-frame polygons', (key) => {
    const glyph = archetypeGlyph(key)!;
    expect(glyph.length, `${key} has too few facets to read as folded paper`).toBeGreaterThanOrEqual(5);
    for (const poly of glyph) {
      const nums = poly.pts.split(/[\s,]+/).filter(Boolean);
      // A polygon needs at least three POINTS, so an even count of numbers.
      expect(nums.length % 2, `${key}: "${poly.pts}" has an odd coordinate count`).toBe(0);
      expect(nums.length / 2, `${key}: "${poly.pts}" is not a polygon`).toBeGreaterThanOrEqual(3);
      for (const n of nums) {
        expect(n, `${key}: "${n}" is not a number`).toMatch(/^-?\d+(\.\d+)?$/);
        expect(Number(n), `${key}: ${n} falls outside the 0..64 viewBox`).toBeGreaterThanOrEqual(0);
        expect(Number(n), `${key}: ${n} falls outside the 0..64 viewBox`).toBeLessThanOrEqual(64);
      }
      // Opacity carries the faceted-fold look; 0 would be an invisible polygon
      // and >1 is not a value SVG has.
      expect(poly.op, `${key}: opacity ${poly.op}`).toBeGreaterThan(0);
      expect(poly.op, `${key}: opacity ${poly.op}`).toBeLessThanOrEqual(1);
    }
  });

  // The tell for a copy-paste that was never redrawn.
  it.each(KEYS)('%s is not a duplicate of another creature', (key) => {
    const mine = JSON.stringify(archetypeGlyph(key));
    const twins = KEYS.filter((other) => other !== key && JSON.stringify(archetypeGlyph(other)) === mine);
    // An ALIAS is allowed to be the same drawing; a second creature is not.
    for (const twin of twins) expect(glyphKey(twin), `${key} and ${twin} are the same drawing`).toBe(glyphKey(key));
  });
});

describe('every glyph renders, inheriting the surrounding colour', () => {
  it.each(KEYS)('%s draws its polygons at 16px in currentColor', (key) => {
    const { container } = render(ArchetypeGlyph, { props: { id: key, size: 16 } });
    const svg = container.querySelector('svg')!;
    expect(svg, `${key} fell through to the letter tile`).toBeTruthy();
    expect(svg.getAttribute('viewBox')).toBe('0 0 64 64');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('style')).toContain('width: 16px');

    const polys = Array.from(svg.querySelectorAll('polygon'));
    expect(polys.length, `${key} rendered no polygons`).toBe(archetypeGlyph(key)!.length);
    for (const p of polys) {
      expect(p.getAttribute('points')).toBeTruthy();
      // No per-polygon colour anywhere: the <svg>'s currentColor is the only
      // paint instruction in the whole glyph, in all five themes.
      expect(p.getAttribute('fill'), `${key} pins a colour on a polygon`).toBeNull();
      expect(p.getAttribute('stroke'), `${key} pins a stroke on a polygon`).toBeNull();
    }
  });
});

describe('the name layer', () => {
  // Driven with three keys rather than thirty-five: the rule is about aliases,
  // and a rule fed its own real input can only ever restate the table.
  it('offers an alias by its animal name and withholds the key it points at', () => {
    expect(offeredGlyphKeys(['tsuru', 'heron'])).toEqual(
      ['cat', 'crane', 'deer', 'dragon', 'elephant', 'fox', 'heron', 'wolf'],
    );
  });

  it('passes an id it knows nothing about straight through', () => {
    expect(glyphKey('badger')).toBe('badger');
    expect(glyphKey('collab-badger')).toBe('badger');
  });

  // Only a LEADING prefix goes, so a def called `collab-precollab-thing` keeps
  // its second one — the anchoring the original rule was written with.
  it('strips only the leading filing prefix', () => {
    expect(glyphKey('collab-collab-crane')).toBe('collab-crane');
  });
});

describe('the twenty-six new creatures', () => {
  it('are all in the table and all offered', () => {
    expect(Object.keys(MENAGERIE).length).toBe(26);
    for (const key of Object.keys(MENAGERIE)) {
      expect(KEYS, `${key} is drawn but not offered`).toContain(key);
    }
  });

  // They joined the SEVEN type-named sets plus the two board birds, and none of
  // them may quietly overwrite one: `...MENAGERIE` is spread FIRST in the table
  // precisely so a collision would be caught here rather than silently winning.
  it('collide with none of the nine that were already there', () => {
    for (const older of ['tsuru', 'plan', 'architect', 'ask', 'debug', 'orchestrator', 'cartographer', 'heron', 'scout']) {
      expect(Object.keys(MENAGERIE), `${older} was redefined by the menagerie`).not.toContain(older);
    }
  });
});
