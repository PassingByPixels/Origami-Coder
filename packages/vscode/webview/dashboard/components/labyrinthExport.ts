// EXPORTING the map — the SVG on screen turned into markup that still renders
// once it is outside the webview. The map is already vector, so this is lossless
// and needs no rasterisation; what it DOES need is the two things a raw
// `outerHTML` dump silently loses:
//
//  1. every rule that paints this map lives in a component-SCOPED stylesheet in
//     the webview document, so a serialized <svg> arrives carrying class names
//     and no styles whatsoever — it renders as flat black shapes on nothing;
//  2. the colour that IS in the markup is a `var(--og-*)` reference. The markers
//     write `fill="var(--og-surface)"` as a real ATTRIBUTE, and those custom
//     properties only exist on the webview document's :root.
//
// So there are two passes. First copy each element's COMPUTED presentation
// properties onto the clone, which collapses the whole scoped cascade into
// inline style. Then resolve any `var(--og-*)` still standing against the live
// root palette — and that second pass is NOT redundant, because a browser
// resolves vars inside getComputedStyle but leaves an attribute-borne one
// completely untouched.
//
// No literal colour appears here by construction: every value written out came
// from the running document. This is the file where a theme var legitimately
// becomes a concrete value, which is why it is the one Labyrinth module the
// theme-discipline guard does not cover.

/**
 * The presentation properties a standalone SVG picture actually needs.
 *
 * Deliberately NOT `display` / `visibility`: nothing on this map is hidden by
 * CSS (it hides things by not rendering them), while every <title> computes to
 * `display: none` — copying that onto the clone would stamp it across every
 * tooltip in the file for no gain.
 */
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

/**
 * Every `var(--x)` in the markup replaced by a concrete value.
 *
 * Looped, because a fallback may itself be a var. A name the document cannot
 * resolve AND has no fallback for collapses to the empty string: the property
 * then reads as unset and the element falls back to the SVG default, which is
 * the honest outcome — inventing a colour for it would put a mark on the
 * picture in a hue the run never had. What it must NEVER do is leave `var(` in
 * the file, because that renders as nothing at all outside the webview.
 */
export function resolveThemeVars(markup: string, lookup: VarReader): string {
  let out = markup;
  for (let pass = 0; pass < MAX_PASSES && out.includes('var('); pass++) {
    out = out.replace(VAR_G, (_all, name: string, fallback?: string) =>
      (lookup(name) || '').trim() || (fallback || '').trim());
  }
  return out;
}

/**
 * The displayed map as standalone SVG markup — self-sufficient, but a FRAGMENT:
 * it carries no XML prologue, because it is embedded in the exported HTML page
 * (labyrinthHtml.ts) rather than written out as a lone .svg file.
 *
 * `read` and `vars` are injected rather than reached for, so the whole thing is
 * exercisable without a live webview host.
 */
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
  // NO manual xmlns. The clone is already in the SVG namespace, so the
  // serializer emits the declaration itself — setting it by hand as well
  // produced a DUPLICATE attribute, which is a FATAL XML parse error. It is
  // still asserted against strict XML parsing in the tests, because a
  // duplicate attribute reads perfectly reasonable as a string and nothing
  // short of parsing catches it.
  const markup = new XMLSerializer().serializeToString(clone);
  return resolveThemeVars(markup, vars);
}
