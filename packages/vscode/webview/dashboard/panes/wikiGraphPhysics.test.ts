// Force clamping, alpha annealing, rebuild merge and seed spread — the
// memory-graph mind map's physics, tested as pure functions with no
// canvas/DOM. Each case targets a specific instability the graph used to
// show at high node counts: explosive repulsion, an unbounded Euler step, a
// layout that never truly rests, and a rebuild re-randomizing everything.

import { describe, expect, it } from 'vitest';
import {
  repulsionForce,
  clampVelocity,
  clampToBounds,
  annealAlpha,
  mergeNodePositions,
  hasNewNodes,
  spiralSeed,
  MIN_DIST,
  MAX_PAIR_FORCE,
  MAX_SPEED,
  ALPHA_HOT,
  ALPHA_DRAG,
  ALPHA_MIN,
  type PriorPhysicsState,
} from './wikiGraphPhysics';

describe('repulsionForce — distance floor + magnitude cap', () => {
  it('never exceeds MAX_PAIR_FORCE * alpha, however close the pair is', () => {
    // A near-coincident pair (the exact spawn collision the bug report named)
    // — without a floor, repulsion / dist^2 diverges towards infinity here.
    const { fx, fy } = repulsionForce(0.001, 0.001, 2200, 1);
    const mag = Math.sqrt(fx * fx + fy * fy);
    expect(mag).toBeLessThanOrEqual(MAX_PAIR_FORCE + 1e-9);
  });

  it('treats any separation at or under MIN_DIST identically (the floor, not a cliff)', () => {
    const atFloor = repulsionForce(MIN_DIST, 0, 2200, 1);
    const underFloor = repulsionForce(1, 0, 2200, 1);
    expect(underFloor.fx).toBeCloseTo(atFloor.fx, 9);
  });

  it('pushes b away from a along the true (dx, dy) direction once past the floor', () => {
    const { fx, fy } = repulsionForce(30, 40, 2200, 1); // 3-4-5 triangle, dist=50
    // Unit direction (0.6, 0.8) — the force must point the same way.
    expect(fx / fy).toBeCloseTo(30 / 40, 6);
    expect(fx).toBeGreaterThan(0);
  });

  it('exact coincidence (dist === 0) still returns a non-zero force, not (0,0)', () => {
    const { fx, fy } = repulsionForce(0, 0, 2200, 1);
    expect(fx * fx + fy * fy).toBeGreaterThan(0);
  });

  it('scales linearly with alpha', () => {
    const hot = repulsionForce(30, 40, 2200, 0.4);
    const cool = repulsionForce(30, 40, 2200, 0.02);
    expect(hot.fx / cool.fx).toBeCloseTo(0.4 / 0.02, 6);
  });
});

describe('clampVelocity — per-tick speed ceiling', () => {
  it('leaves a velocity under the cap untouched', () => {
    expect(clampVelocity(3, 4)).toEqual({ vx: 3, vy: 4 }); // speed 5, well under MAX_SPEED
  });

  it('scales an over-cap velocity down to exactly MAX_SPEED, preserving direction', () => {
    const { vx, vy } = clampVelocity(300, 400); // speed 500, direction (0.6, 0.8)
    expect(Math.sqrt(vx * vx + vy * vy)).toBeCloseTo(MAX_SPEED, 6);
    expect(vx / vy).toBeCloseTo(300 / 400, 6);
  });

  it('leaves a zero velocity as zero (no NaN from a zero-length scale)', () => {
    expect(clampVelocity(0, 0)).toEqual({ vx: 0, vy: 0 });
  });
});

describe('clampToBounds — world-bounds clamp', () => {
  it('leaves a point inside the radius untouched', () => {
    expect(clampToBounds(105, 100, 100, 100, 50)).toEqual({ x: 105, y: 100 });
  });

  it('pulls a runaway point back onto the boundary, same direction from centre', () => {
    const { x, y } = clampToBounds(1100, 0, 100, 0, 500); // 1000 away on +x, y = centre y
    expect(x).toBeCloseTo(600, 6); // centre(100) + radius(500)
    expect(y).toBeCloseTo(0, 6);
  });

  it('a point exactly at the centre is untouched (no zero-length scale)', () => {
    expect(clampToBounds(100, 100, 100, 100, 50)).toEqual({ x: 100, y: 100 });
  });
});

describe('annealAlpha — cools toward rest, re-heats on interaction', () => {
  it('starts at ALPHA_HOT when progress is 0', () => {
    expect(annealAlpha(0, false)).toBeCloseTo(ALPHA_HOT, 6);
  });

  it('reaches ALPHA_MIN once progress hits 1 (the settle window is spent)', () => {
    expect(annealAlpha(1, false)).toBeCloseTo(ALPHA_MIN, 6);
  });

  it('decreases monotonically as progress advances — the layout actually cools', () => {
    const samples = [0, 0.25, 0.5, 0.75, 1].map((p) => annealAlpha(p, false));
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThan(samples[i - 1]);
    }
  });

  it('dragging always re-heats to ALPHA_DRAG, regardless of how cool progress is', () => {
    expect(annealAlpha(1, true)).toBe(ALPHA_DRAG);
    expect(annealAlpha(0, true)).toBe(ALPHA_DRAG);
  });

  it('clamps out-of-range progress instead of extrapolating past the floor/ceiling', () => {
    expect(annealAlpha(-5, false)).toBeCloseTo(ALPHA_HOT, 6);
    expect(annealAlpha(5, false)).toBeCloseTo(ALPHA_MIN, 6);
  });
});

describe('mergeNodePositions — a rebuild keeps existing physics state', () => {
  it('overwrites an existing id\'s x/y/vx/vy/fixed back to its prior state', () => {
    const fresh = [{ id: 'page:a', x: 999, y: 999, vx: 999, vy: 999, fixed: undefined as boolean | undefined }];
    const prior = new Map<string, PriorPhysicsState>([['page:a', { x: 10, y: 20, vx: 1, vy: -1, fixed: true }]]);
    mergeNodePositions(fresh, prior);
    expect(fresh[0]).toMatchObject({ x: 10, y: 20, vx: 1, vy: -1, fixed: true });
  });

  it('leaves a genuinely new id exactly as the caller seeded it', () => {
    const fresh = [{ id: 'page:new', x: 42, y: 43, vx: 0, vy: 0 }];
    mergeNodePositions(fresh, new Map());
    expect(fresh[0]).toMatchObject({ x: 42, y: 43, vx: 0, vy: 0 });
  });

  it('mutates in place AND returns the same array (matches the plain-array house style)', () => {
    const fresh = [{ id: 'a', x: 0, y: 0, vx: 0, vy: 0 }];
    const result = mergeNodePositions(fresh, new Map());
    expect(result).toBe(fresh);
  });
});

describe('hasNewNodes — the re-heat signal', () => {
  it('is true when at least one fresh id is absent from prior', () => {
    const fresh = [{ id: 'a' }, { id: 'b' }];
    expect(hasNewNodes(fresh, new Map([['a', {}]]))).toBe(true);
  });

  it('is false when every fresh id already existed (an unrelated rebuild)', () => {
    const fresh = [{ id: 'a' }, { id: 'b' }];
    expect(hasNewNodes(fresh, new Map([['a', {}], ['b', {}]]))).toBe(false);
  });

  it('is true on the very first build (an empty prior map)', () => {
    expect(hasNewNodes([{ id: 'a' }], new Map())).toBe(true);
  });
});

describe('spiralSeed — deterministic, collision-resistant seed spread', () => {
  it('is deterministic — the same index/total always lands on the same point', () => {
    const a = spiralSeed(5, 50, 0, 0, 10, 100);
    const b = spiralSeed(5, 50, 0, 0, 10, 100);
    expect(a).toEqual(b);
  });

  it('never places two of a large batch on (near-)coincident points', () => {
    const total = 200;
    const pts = Array.from({ length: total }, (_, i) => spiralSeed(i, total, 0, 0, 40, 400));
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(0.5);
      }
    }
  });

  it('stays within [minR, maxR] of the centre', () => {
    const total = 30;
    for (let i = 0; i < total; i++) {
      const { x, y } = spiralSeed(i, total, 0, 0, 20, 80);
      const r = Math.sqrt(x * x + y * y);
      expect(r).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(r).toBeLessThanOrEqual(80 + 1e-9);
    }
  });

  it('a single node (total=1) seeds at minR, not NaN from a 0/0 division', () => {
    const { x, y } = spiralSeed(0, 1, 50, 50, 10, 90);
    expect(Number.isNaN(x)).toBe(false);
    expect(Number.isNaN(y)).toBe(false);
    expect(Math.sqrt((x - 50) ** 2 + (y - 50) ** 2)).toBeCloseTo(10, 6);
  });
});
