// Isometric projection for the repo map: camera maths only, no placement logic (kept apart
// from isoLayout.ts so an axis-sign flip is assertable against hand-computed numbers, since a
// mirrored diagram still looks like one on a screenshot). Points are snapped to two decimals
// since the flow-spine layout places boxes on fractional cells; the layout serializes into
// two artifacts (map.html + webview payload), both smaller for it.

/** Half-width and half-height of one grid cell in screen px — a 2:1 iso cell. */
export const HX = 26;
export const HY = 13;
/** Screen px per unit of box height. */
export const ZH = 14;

export interface Pt {
  x: number;
  y: number;
}

/** Grid (x,y,z) -> screen point. x runs down-right, y runs down-left, z lifts up; screen y
 *  grows downward, so z is subtracted to make a tall box stand up rather than sink. */
export function project(x: number, y: number, z = 0): Pt {
  return { x: snap((x - y) * HX), y: snap((x + y) * HY - z * ZH) };
}

/** Two decimals; rounding is applied identically to every point so the picture is
 *  quantised, never skewed. */
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

/** The three visible faces of a grid-aligned box. Only three of six are emitted — the other
 *  three are always behind the solid on an isometric camera, so drawing them would double the
 *  polygon count (and the static artifact's byte size) for pixels that are always covered. */
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

/** Screen bounding box of a point set, padded. An empty set is a real case (a map with no
 *  nodes validates) and must yield a usable viewBox, not NaN. */
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
