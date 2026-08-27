// The map stage's CAMERA. These assert the one property a screenshot can never
// show: that zooming keeps the thing under the pointer under the pointer.
//
// Get the divisor or the direction wrong and a still image of the map looks
// perfect — the diagram simply slides away from you as you scroll, and every
// wheel notch has to be undone by a drag. The same goes for the zero-size case:
// an unmounted pane, a hidden editor tab and jsdom itself all report a 0x0 box,
// and dividing by that sends the camera to Infinity, which renders as a blank
// stage with no error in any log.

import { describe, expect, it } from 'vitest';
import {
  camAttr, dragBy, fitOf, flowNodeIds, HOME, pointsAttr, toUser, viewBoxAttr, zoomAt, ZOOM_MAX, ZOOM_MIN,
} from '../components/isoView';

const VIEW = { x: -100, y: -50, w: 800, h: 400 };
const RECT = { left: 20, top: 10, width: 1600, height: 900 };

describe('fitting the viewBox into the element', () => {
  it('scales by the TIGHTER axis and letterboxes the slack, like xMidYMid meet', () => {
    // 1600/800 = 2 across, 900/400 = 2.25 down; meet takes the smaller, so the
    // spare 100px of height is split above and below.
    const f = fitOf(RECT, VIEW)!;
    expect(f.s).toBe(2);
    expect(f.ox).toBe(0);
    expect(f.oy).toBe(50);
  });

  it('returns NULL rather than a fit when the element has no size', () => {
    expect(fitOf({ width: 0, height: 0 }, VIEW)).toBeNull();
    expect(fitOf(null, VIEW)).toBeNull();
    expect(fitOf(undefined, VIEW)).toBeNull();
  });

  it('returns NULL for a map with no extent, instead of dividing by zero', () => {
    expect(fitOf(RECT, { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
  });
});

describe('client point to user point', () => {
  it('inverts the fit exactly — round-tripping a user point returns it', () => {
    const f = fitOf(RECT, VIEW)!;
    const want = { x: 123, y: -7 };
    const clientX = (want.x - VIEW.x) * f.s + f.ox + RECT.left;
    const clientY = (want.y - VIEW.y) * f.s + f.oy + RECT.top;
    expect(toUser(RECT, VIEW, clientX, clientY)).toEqual(want);
  });

  it('is null wherever the fit is null, so every caller can no-op on one check', () => {
    expect(toUser({ left: 0, top: 0, width: 0, height: 0 }, VIEW, 5, 5)).toBeNull();
  });
});

describe('zooming about the pointer', () => {
  /** The LAYOUT point currently sitting under the user-space point `u`. */
  const under = (cam: { tx: number; ty: number; k: number }, ux: number, uy: number) =>
    ({ x: (ux - cam.tx) / cam.k, y: (uy - cam.ty) / cam.k });

  it('keeps the layout point under the pointer FIXED, in and out', () => {
    // This is the whole contract. Break the translate line in zoomAt (drop the
    // ratio, or use k instead of next) and this goes red while the map still
    // renders perfectly in any screenshot.
    let cam = { ...HOME };
    const ux = 210;
    const uy = -35;
    const before = under(cam, ux, uy);
    for (const dir of [1, 1, -1, 1, -1, -1]) {
      cam = zoomAt(cam, ux, uy, dir);
      const now = under(cam, ux, uy);
      expect(now.x).toBeCloseTo(before.x, 9);
      expect(now.y).toBeCloseTo(before.y, 9);
    }
  });

  it('actually changes the scale, in the direction asked', () => {
    expect(zoomAt(HOME, 0, 0, 1).k).toBeGreaterThan(HOME.k);
    expect(zoomAt(HOME, 0, 0, -1).k).toBeLessThan(HOME.k);
  });

  it('clamps, so a fast scroll cannot leave the map at 400x or as a speck', () => {
    let inward = { ...HOME };
    let outward = { ...HOME };
    for (let i = 0; i < 60; i++) {
      inward = zoomAt(inward, 0, 0, 1);
      outward = zoomAt(outward, 0, 0, -1);
    }
    expect(inward.k).toBe(ZOOM_MAX);
    expect(outward.k).toBe(ZOOM_MIN);
  });

  it('is a no-op at the clamp, returning the same camera rather than drifting the pan', () => {
    // At the limit the scale cannot change, but a translate recomputed anyway
    // would still shift the picture on every further notch — a map that slides
    // sideways when you keep scrolling at full zoom.
    const at = { tx: 11, ty: 22, k: ZOOM_MAX };
    expect(zoomAt(at, 500, 500, 1)).toBe(at);
  });
});

describe('dragging', () => {
  it('moves the picture with the pointer, at any zoom', () => {
    // Client px are user units divided by the fit scale; forgetting the divisor
    // makes the map lag or race the cursor as soon as you zoom.
    expect(dragBy({ tx: 5, ty: 5, k: 2 }, 100, -40, 2)).toEqual({ tx: 55, ty: -15, k: 2 });
  });

  it('refuses a zero scale rather than producing Infinity', () => {
    const start = { tx: 1, ty: 2, k: 1 };
    expect(dragBy(start, 10, 10, 0)).toBe(start);
  });
});

describe('attribute builders and the flow set', () => {
  it('formats the attributes the stage binds', () => {
    expect(viewBoxAttr(VIEW)).toBe('-100 -50 800 400');
    expect(camAttr({ tx: 1, ty: -2, k: 0.5 })).toBe('translate(1,-2) scale(0.5)');
    expect(pointsAttr([{ x: 0, y: 1 }, { x: 2, y: 3 }])).toBe('0,1 2,3');
  });

  it('gives an EMPTY set for no flow, so nothing is dimmed when nothing is traced', () => {
    expect(flowNodeIds(undefined).size).toBe(0);
    expect([...flowNodeIds([{ node: 'a' }, { node: 'b' }, { node: 'a' }])].sort()).toEqual(['a', 'b']);
  });
});
