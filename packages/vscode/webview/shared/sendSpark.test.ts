// t-qn0wj5, proposal 25: sendSpark's DOM-free pieces. The canvas draw loop
// itself needs a real 2D context and layout, neither of which jsdom provides
// (WORKING_ON_ORIGAMI_CODER.md Part 6) — see sendSpark.ts's own note. This
// file proves the part that decides WHETHER and WHERE to draw.
import { describe, expect, it, afterEach } from 'vitest';
import { sparkEase, sparkSegment, sendSparkTarget, mountSendSpark, resetSendSparkForTest } from './sendSpark';

afterEach(() => {
  resetSendSparkForTest();
  document.body.innerHTML = '';
});

describe('sparkEase', () => {
  it('is the reference curve t*(2-t): 0 at start, 1 at end, overshoots nothing in between', () => {
    expect(sparkEase(0)).toBe(0);
    expect(sparkEase(1)).toBe(1);
    expect(sparkEase(0.5)).toBeCloseTo(0.75, 5);
  });
});

describe('sparkSegment', () => {
  it('places 8 sparks radially and each grows from radius 15 toward 25 as k -> 0', () => {
    const seg0 = sparkSegment(0, 0); // angle 0 -> along +x
    expect(seg0.x1).toBeCloseTo(0, 5); // ease(0) = 0, so r0 = 0
    expect(seg0.x2).toBeCloseTo(10, 5); // tip = 0 + 10*(1-0)
  });
  it('collapses to a point at k=1 (the burst\'s end)', () => {
    const seg = sparkSegment(2, 1);
    expect(seg.x1).toBeCloseTo(seg.x2, 5);
    expect(seg.y1).toBeCloseTo(seg.y2, 5);
  });
});

describe('sendSparkTarget', () => {
  it('finds the button + its composer ancestor when the click lands on Send', () => {
    document.body.innerHTML = '<div class="input-area"><button class="action-btn">Send</button></div>';
    const btn = document.querySelector('.action-btn')!;
    const found = sendSparkTarget(btn);
    expect(found).not.toBeNull();
    expect(found!.btn).toBe(btn);
    expect(found!.area.className).toBe('input-area');
  });

  it('finds it from a child of Send too (an icon/text node click bubbles to a child element)', () => {
    document.body.innerHTML = '<div class="input-area"><button class="action-btn"><span>Send</span></button></div>';
    const span = document.querySelector('span')!;
    expect(sendSparkTarget(span)).not.toBeNull();
  });

  it('is null for a click anywhere else, including a lookalike button with no .input-area ancestor', () => {
    document.body.innerHTML = '<button class="action-btn">Send</button>'; // no .input-area
    expect(sendSparkTarget(document.querySelector('button'))).toBeNull();
    expect(sendSparkTarget(null)).toBeNull();
  });

  it('is null for a different composer control (Cancel), not just Send by coincidence', () => {
    document.body.innerHTML = '<div class="input-area"><button class="btn cancel">Cancel</button></div>';
    expect(sendSparkTarget(document.querySelector('button'))).toBeNull();
  });
});

describe('mountSendSpark', () => {
  it('is idempotent — a second mount does not attach a second listener', () => {
    const calls: number[] = [];
    const doc = { addEventListener: () => calls.push(1) } as unknown as Document;
    mountSendSpark(doc);
    mountSendSpark(doc);
    expect(calls.length).toBe(1);
  });
});

describe('sendSpark — the morphing control', () => {
  it('does not spark while the same control is the hold-to-stop (data-busy)', () => {
    document.body.innerHTML = '<div class="input-area"><button class="action-btn" data-busy="">Stop</button></div>';
    expect(sendSparkTarget(document.querySelector('.action-btn'))).toBeNull();
  });
});

