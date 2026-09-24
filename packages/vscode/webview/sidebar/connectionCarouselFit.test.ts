// The connections carousel's arithmetic. This is where "no clipped tile"
// is actually decided — jsdom has no layout, so the carousel's own rendering
// proves nothing and these numbers prove everything.
import { describe, expect, it } from 'vitest';
import {
  CONN_GAP, CONN_IDEAL_W, fitTiles, maxTileStart, nameLines, pageTarget, settleTarget,
} from './connectionCarouselFit';

describe('connectionCarouselFit — a whole number of tiles spans the track', () => {
  it('fills the track EXACTLY, with the fraction kept', () => {
    for (const w of [180, 213, 260, 287, 340, 512]) {
      const fit = fitTiles(w);
      const spanned = fit.count * fit.width + (fit.count - 1) * CONN_GAP;
      expect(spanned, `track ${w}px`).toBeCloseTo(w, 6);
    }
  });

  it('never rounds the width, because a rounded tile is what leaves a sliver', () => {
    // 287 does not divide cleanly; a whole-pixel width would leave the last
    // tile short and show a slice of the next one at the end of the scroll.
    const fit = fitTiles(287);
    expect(Number.isInteger(fit.width)).toBe(false);
  });

  it('takes as many ideal-width tiles as fit and no more', () => {
    expect(fitTiles(CONN_IDEAL_W).count).toBe(1);
    expect(fitTiles(CONN_IDEAL_W * 2 + CONN_GAP).count).toBe(2);
    expect(fitTiles(CONN_IDEAL_W * 2 + CONN_GAP - 1).count).toBe(1);
  });

  it('survives an unmeasured track (0 width) instead of dividing by zero', () => {
    expect(fitTiles(0)).toEqual({ count: 1, width: CONN_IDEAL_W });
  });
});

describe('connectionCarouselFit — the scroll always rests on a tile start', () => {
  it('clamps the end of the scroll to the last WHOLE tile start', () => {
    // Fractional tile borders make scrollWidth round differently from the
    // arithmetic, so the raw maximum (937-260 = 677) rests mid-tile.
    const step = 50;
    expect(maxTileStart(937, 260, step)).toBe(650);
    expect(maxTileStart(937, 260, step) % step).toBe(0);
  });

  it('a track that does not overflow cannot scroll anywhere', () => {
    expect(maxTileStart(260, 260, 50)).toBe(0);
    expect(maxTileStart(100, 260, 50)).toBe(0);
  });

  it('an arrow pages by whole tiles and stops at the clamped end', () => {
    const fit = { count: 4, width: 50 };
    expect(pageTarget(0, 1, fit, 2000, 224)).toBe(224);
    expect(pageTarget(0, -1, fit, 2000, 224)).toBe(0);
    expect(pageTarget(9999, 1, fit, 2000, 224)).toBe(maxTileStart(2000, 224, 56));
  });

  it('a released drag settles on the nearest tile start, never mid-tile', () => {
    const fit = { count: 4, width: 50 };
    // The reference's verified case in spirit: a drag to an arbitrary offset
    // lands back on a multiple of the step.
    expect(settleTarget(90, fit, 2000, 224) % 56).toBe(0);
    expect(settleTarget(90, fit, 2000, 224)).toBe(112);
  });
});

describe('connectionCarouselFit — two-line tile names', () => {
  it('splits at the first space', () => {
    expect(nameLines('LM Studio')).toEqual(['LM', 'Studio']);
  });

  it('splits before an inner capital when there is no space', () => {
    expect(nameLines('OpenRouter')).toEqual(['Open', 'Router']);
    expect(nameLines('DeepSeek')).toEqual(['Deep', 'Seek']);
  });

  it('leaves a short all-caps name whole rather than splitting mid-acronym', () => {
    expect(nameLines('xAI')).toEqual(['xAI']);
    expect(nameLines('Groq')).toEqual(['Groq']);
  });

  it('drops the status clause the tile title carries', () => {
    // gridLabel() builds "<name> — <status>"; the tile must show the name only.
    expect(nameLines('LM Studio — Live')).toEqual(['LM', 'Studio']);
    expect(nameLines('Claude Code 2.1 - passthrough')).toEqual(['Claude', 'Code']);
  });

  it('drops a trailing version', () => {
    expect(nameLines('Ollama v0.3.1')).toEqual(['Ollama']);
  });

  it('returns nothing for an empty title, so the tile keeps its initials', () => {
    expect(nameLines('')).toEqual([]);
    expect(nameLines('   ')).toEqual([]);
  });
});

// t-qn09vr: the Folds repo carousel (RepoCarousel.svelte) reuses fitTiles for
// its arrow-paging column count instead of a second fit function — this is
// what "one fit definition" means in the ticket. Its cards are FIXED at
// 156x52 (unlike the connections tile, which stretches to fill), so only
// `.count` is read; `.width`'s fill-to-track answer is deliberately ignored.
describe('connectionCarouselFit — reused by the repo carousel (fixed 156px cards)', () => {
  const REPO_CARD_W = 156;
  const REPO_GAP = 4;

  it('one column fits at exactly one card width', () => {
    expect(fitTiles(REPO_CARD_W, REPO_CARD_W, REPO_GAP).count).toBe(1);
  });

  it('two columns fit once the track spans two cards plus the gap between them', () => {
    expect(fitTiles(REPO_CARD_W * 2 + REPO_GAP, REPO_CARD_W, REPO_GAP).count).toBe(2);
    expect(fitTiles(REPO_CARD_W * 2 + REPO_GAP - 1, REPO_CARD_W, REPO_GAP).count).toBe(1);
  });

  it('three columns fit in a wider strip', () => {
    expect(fitTiles(REPO_CARD_W * 3 + REPO_GAP * 2, REPO_CARD_W, REPO_GAP).count).toBe(3);
  });
});
