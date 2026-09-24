// Exporting the map: the SVG on screen turned into markup that still renders
// outside the webview. Lossless (already vector), but a raw `outerHTML` dump
// silently loses two things: every paint rule lives in a component-scoped
// stylesheet, so a serialized <svg> carries class names and no styles; and
// colours in the markup are `var(--og-*)` references, which only exist on
// the webview document's :root.
//
// Two passes: first copy each element's computed presentation properties
// onto the clone, collapsing the scoped cascade into inline style. Then
// resolve any `var(--og-*)` still standing against the live root palette —
// not redundant, since a browser resolves vars inside getComputedStyle but
// leaves an attribute-borne one untouched.
//
// No literal colour appears here by construction: every value came from the
// running document. This is the one Labyrinth module the theme-discipline
// guard doesn't cover, since a theme var legitimately becomes concrete here.

/** The presentation properties a standalone SVG picture needs. Deliberately
 *  not `display`/`visibility`: every <title> computes to `display: none`,
 *  and copying that would stamp it across every tooltip for no gain. */
const PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'color',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-numeric',
  'letter-spacing', 'text-anchor', 'dominant-baseline',
];

/** One element's resolved styles — `getComputedStyle` in a live webview. */
export type StyleReader = (el: Element) => { getPropertyValue(prop: string): string };
/** One `--og-*` custom property off the document root. */
export type VarReader = (name: string) => string;

/** `var(--name)` / `var(--name, fallback)`, fallback allowed one nesting level. */
const VAR_G = /var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;
const MAX_PASSES = 8;

/** Every `var(--x)` in the markup replaced by a concrete value. Looped,
 *  since a fallback may itself be a var. A name the document can't resolve
 *  and has no fallback collapses to the empty string, the honest outcome —
 *  it must never leave `var(` in the file, which renders as nothing outside
 *  the webview. */
export function resolveThemeVars(markup: string, lookup: VarReader): string {
  let out = markup;
  for (let pass = 0; pass < MAX_PASSES && out.includes('var('); pass++) {
    out = out.replace(VAR_G, (_all, name: string, fallback?: string) =>
      (lookup(name) || '').trim() || (fallback || '').trim());
  }
  return out;
}

/** The displayed map as standalone SVG markup, self-sufficient but a
 *  fragment (no XML prologue), since it's embedded in the exported HTML
 *  page rather than written as a lone .svg file. `read` and `vars` are
 *  injected so the whole thing is exercisable without a live webview host. */
export function labyrinthSvg(svg: SVGSVGElement, read: StyleReader, vars: VarReader): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const source = [svg as Element, ...Array.from(svg.querySelectorAll('*'))];
  const copy = [clone as Element, ...Array.from(clone.querySelectorAll('*'))];

  copy.forEach((el, i) => {
    const from = source[i];
    if (!from) return;
    const style = read(from);
    const decls = PROPS
      .map((prop) => `${prop}:${(style.getPropertyValue(prop) || '').trim()}`)
      .filter((decl) => !decl.endsWith(':'));
    // Class names mean nothing once the stylesheet is gone; keeping them would
    // only imply the file still responds to a theme it can no longer see.
    el.removeAttribute('class');
    if (decls.length) el.setAttribute('style', decls.join(';'));
    else el.removeAttribute('style');
  });

  // The on-screen svg carries the PANEL's layout (min-width / a stretched
  // height). A file needs the picture's own size, which is the viewBox's.
  const [, , width, height] = (clone.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
  }
  // No manual xmlns: the clone is already in the SVG namespace, so the
  // serializer emits the declaration itself; setting it by hand too produced
  // a duplicate attribute, a fatal XML parse error.
  const markup = new XMLSerializer().serializeToString(clone);
  return resolveThemeVars(markup, vars);
}
