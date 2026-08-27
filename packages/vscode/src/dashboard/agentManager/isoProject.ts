// Isometric PROJECTION for the repo map — the camera maths, and nothing else.
// It knows tiles, not nodes: hand it integer grid cells and it returns the
// screen polygons a 2:1 isometric view actually shows.
//
// Kept apart from isoLayout.ts deliberately. Placement (which node goes where)
// changes every time the map gains a grouping rule; the camera never does. The
// split is also what makes the maths assertable against hand-computed numbers,
// which is the only way an axis sign flip gets caught — a mirrored diagram
// still looks like a diagram, so no screenshot would ever show it.
//
// Every constant here is an INTEGER, but the floor plan no longer works in whole
// cells: the flow-spine streets and the packed districts place boxes on
// fractional ones (0.6 gaps, an 8.5-cell street pitch), so a raw projection
// produces values like 221.00000000000003. Points are therefore SNAPPED to two
// decimals — enough to be sub-pixel at any zoom, and it keeps a whole cell
// exactly on its integer. That matters more than tidiness: one layout is
// serialized into TWO artifacts (the static map.html and the webview payload),
// and both are far smaller for it.

/** Half-width and half-height of one grid cell in screen px — a 2:1 iso cell. */
export const HX = 26;
export const HY = 13;
/** Screen px per unit of box height. */
export const ZH = 14;

export interface Pt {
  x: number;
  y: number;
}

/**
 * Grid (x, y, z) -> screen point. Increasing `x` runs down-RIGHT, increasing
 * `y` runs down-LEFT, and `z` lifts straight UP the screen. Screen y grows
 * downward (SVG's own convention), which is why the z term is subtracted: it
 * is what makes a tall box stand up instead of sinking into the floor.
 */
export function project(x: number, y: number, z = 0): Pt {
  return { x: snap((x - y) * HX), y: snap((x + y) * HY - z * ZH) };
}

/** Two decimals. `Math.round` on a negative half rounds toward +Infinity, which
 *  is fine here — it is applied identically to every point, so the picture is
 *  never skewed, only quantised. */
function snap(v: number): number {
  return Math.round(v * 100) / 100;
}

/** The three faces a front-facing iso camera sees of one grid-aligned box. */
export interface IsoFaces {
  /** Top face, wound back -> right -> front -> left. */
  top: Pt[];
  /** The x = gx+w face, down-RIGHT of the top. */
  right: Pt[];
  /** The y = gy+d face, down-LEFT of the top. */
  left: Pt[];
  /** Centre of the top face: the label anchor and a connector's endpoint. */
  centre: Pt;
}

/**
 * The visible faces of the box filling cells [gx, gx+w) x [gy, gy+d), rising
 * from `z0` to `z0 + h`.
 *
 * Only THREE of the six faces are emitted. The other three are behind the
 * solid at every point of an isometric camera, so drawing them would double
 * the polygon count of the whole picture for pixels that are always covered —
 * and in the static artifact that count is bytes on disk.
 */
export function boxFaces(gx: number, gy: number, w: number, d: number, h: number, z0 = 0): IsoFaces {
  const x1 = gx + w;
  const y1 = gy + d;
  const z1 = z0 + h;
  const back = project(gx, gy, z1);
  const right = project(x1, gy, z1);
  const front = project(x1, y1, z1);
  const left = project(gx, y1, z1);
  const rightBase = project(x1, gy, z0);
  const frontBase = project(x1, y1, z0);
  const leftBase = project(gx, y1, z0);
  return {
    top: [back, right, front, left],
    right: [right, front, frontBase, rightBase],
    left: [left, front, frontBase, leftBase],
    centre: project(gx + w / 2, gy + d / 2, z1),
  };
}

/** The flat outline of a grid rectangle at z = 0 — the dashed zone regions. */
export function tileOutline(gx: number, gy: number, w: number, d: number): Pt[] {
  return [project(gx, gy), project(gx + w, gy), project(gx + w, gy + d), project(gx, gy + d)];
}

/** Screen bounding box of a set of points, grown by `pad` on every side.
 *  An EMPTY set is a real case (a map with no nodes validates), and it must
 *  yield a usable viewBox rather than NaN or an inverted rect. */
export function boundsOf(points: readonly Pt[], pad = 0): { x: number; y: number; w: number; h: number } {
  if (points.length === 0) return { x: -pad, y: -pad, w: pad * 2, h: pad * 2 };
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** Points as an SVG `points` attribute. Shared so the two renderers cannot
 *  format the same polygon two different ways. */
export function polyPoints(pts: readonly Pt[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(' ');
}
