// The map screen's CAMERA — pure viewport arithmetic for the isometric stage,
// with no DOM in it. The picture's geometry is NOT here: it arrives already
// computed in the tab payload (src/dashboard/agentManager/isoLayout.ts), which
// is why this file only imports that module's TYPES. One layout, two renderers,
// nothing mirrored.
//
// What is here is the part a screenshot can never check: that zooming keeps the
// thing under the pointer under the pointer. Get the sign or the divisor wrong
// and the diagram slides away as you scroll — which still looks like a working
// zoom in a still image, and is maddening to use. So it lives in a pure
// function with that invariant asserted directly.

/** A screen point. Declared here rather than imported from isoProject.ts, and
 *  the reason is worth writing down because the house rule is stated too
 *  broadly elsewhere: a TYPE-ONLY import out of `src/` is fine in a `.svelte`
 *  file only because tsc never puts .svelte files in the program at all. A
 *  `.ts` file under `webview/` IS in the program, so the same import fails the
 *  webview typecheck with TS6059 ("not under rootDir") even though the import
 *  is erased. Two numbers, structurally identical, is the honest cost. */
export interface Pt {
  x: number;
  y: number;
}

/** `translate(tx,ty) scale(k)` on the stage's camera group, in viewBox units. */
export interface Camera {
  tx: number;
  ty: number;
  k: number;
}

export const HOME: Camera = { tx: 0, ty: 0, k: 1 };
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
const ZOOM_STEP = 1.12;

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** SVG `points` attribute. Kept beside the other attribute builders so a
 *  polygon is formatted one way on this side of the seam. */
export function pointsAttr(list: readonly Pt[]): string {
  return list.map((p) => `${p.x},${p.y}`).join(' ');
}

export function viewBoxAttr(v: ViewBox): string {
  return `${v.x} ${v.y} ${v.w} ${v.h}`;
}

export function camAttr(c: Camera): string {
  return `translate(${c.tx},${c.ty}) scale(${c.k})`;
}

/** How the viewBox is fitted into the element for preserveAspectRatio
 *  ="xMidYMid meet": `s` px per user unit, plus the letterbox offsets.
 *
 *  NULL when the element has no size or the map has no extent. That is a real
 *  state, not a defensive shrug — an unmounted pane, a hidden editor tab and
 *  jsdom (which has no layout engine at all) all report 0x0, and dividing by it
 *  would send the camera to Infinity on the first scroll. Every caller no-ops. */
export function fitOf(rect: { width: number; height: number } | null | undefined, v: ViewBox):
  { s: number; ox: number; oy: number } | null {
  if (!rect || !(rect.width > 0 && rect.height > 0) || !(v.w > 0 && v.h > 0)) return null;
  const s = Math.min(rect.width / v.w, rect.height / v.h);
  return { s, ox: (rect.width - v.w * s) / 2, oy: (rect.height - v.h * s) / 2 };
}

/** A client point in viewBox user coordinates, or null when there is no fit. */
export function toUser(
  rect: { left: number; top: number; width: number; height: number } | null | undefined,
  v: ViewBox, clientX: number, clientY: number,
): Pt | null {
  const f = fitOf(rect, v);
  if (!f || !rect) return null;
  return { x: (clientX - rect.left - f.ox) / f.s + v.x, y: (clientY - rect.top - f.oy) / f.s + v.y };
}

/** Zoom one notch about the user-space point (ux, uy): `dir` > 0 zooms in.
 *
 *  The translate is chosen so the LAYOUT point currently under (ux, uy) is
 *  still under it afterwards — solve p*k' + t' = ux for t' where p = (ux-t)/k.
 *  Clamped, so a fast scroll cannot leave the map at 400x or a speck. */
export function zoomAt(cam: Camera, ux: number, uy: number, dir: number): Camera {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.k * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
  if (next === cam.k) return cam;
  const ratio = next / cam.k;
  return { tx: ux - (ux - cam.tx) * ratio, ty: uy - (uy - cam.ty) * ratio, k: next };
}

/** Drag the camera by a client-pixel delta. Client px are converted to user
 *  units by `s`, so the picture tracks the pointer exactly at any zoom. */
export function dragBy(start: Camera, dxPx: number, dyPx: number, s: number): Camera {
  if (!(s > 0)) return start;
  return { tx: start.tx + dxPx / s, ty: start.ty + dyPx / s, k: start.k };
}

/** The node ids a flow visits, for the highlight/dim pass. An EMPTY set means
 *  "no flow selected" to the caller, so nothing is dimmed — a flow whose steps
 *  were all dropped must not blank the whole map. */
export function flowNodeIds(steps: ReadonlyArray<{ node: string }> | undefined): Set<string> {
  return new Set((steps ?? []).map((s) => s.node));
}
