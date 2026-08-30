// Graph-BUILD helpers for the memory-graph mind map: the pure half of
// WikiSearchPane's buildGraph() — the deterministic key->number tables and the
// page<->page link resolution. Extracted when the pane's cap bit, which is the
// extraction that cap's own comment already named.
//
// A LEAF (no canvas, no DOM, no imports). The pane's build path runs inside
// render()'s neighbourhood, and render() needs a 2d context jsdom does not
// have, so anything left in the component is untestable by construction. The
// link rules below have a real defect class behind every branch — an ambiguous
// basename silently resolving to whichever page was parsed last is the one that
// motivated the byBase/byTitle split.

/** Deterministic 0..1 from a string (FNV-1a). The same key always yields the
 *  same number, for any wiki, with no hardcoded map. Seeds both the hue tables
 *  below and each node's per-node jitter. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** Evenly spaced hues per distinct key, in sorted order. Evenly spaced and NOT
 *  hashed: hashed hues collided, so two folders could paint the same colour.
 *  A single key gets 200 rather than 0 — one lone red folder read as an error. */
export function evenHues(keys: string[]): Map<string, number> {
  const sorted = [...new Set(keys)].sort();
  const m = new Map<string, number>();
  sorted.forEach((k, i) => m.set(k, sorted.length === 1 ? 200 : (i / sorted.length) * 360));
  return m;
}

/** The folder a page belongs to — its namespace with the trailing slash and a
 *  bare '.' normalised away. A page with no namespace lands in '(root)', which
 *  is also the key of the graph's pinned root hub. */
export function folderOf(p: { namespace?: string }): string {
  const ns = (p.namespace || '').replace(/\/$/, '').replace(/^\.$/, '');
  return ns || '(root)';
}

/** The page fields link resolution reads. Declared structurally so the pane's
 *  richer WikiPage satisfies it without this leaf importing anything. */
export interface LinkablePage {
  id: string;
  title: string;
  /** Raw outbound targets ([[wikilinks]] + md links), unresolved. */
  links?: string[];
}

/** A page<->page edge in the pane's GraphEdge shape. */
export interface LinkEdge {
  source: string;
  target: string;
  kind: 'link';
}

/** Resolve each page's raw link targets to `page:<id>` edges.
 *
 *  Priority: exact id -> path resolved relative to the SOURCE page's folder (md
 *  links are written source-relative, e.g. ../guide/setup.md) -> UNAMBIGUOUS
 *  basename -> UNAMBIGUOUS title. Separate maps, so a title cannot clobber
 *  another page's basename; a key shared across folders (index.md, _overview.md,
 *  a repeated H1) is SKIPPED rather than silently resolving to the last page
 *  parsed. Self-links are dropped, and a reciprocal pair yields one edge. */
export function resolveLinkEdges(pages: LinkablePage[]): LinkEdge[] {
  const norm = (s: string) => s.toLowerCase().trim();
  const base = (s: string) => norm(s.split(/[\\/]/).pop()!.replace(/\.md$/i, ''));
  const dirOf = (id: string) => { const i = id.lastIndexOf('/'); return i >= 0 ? id.slice(0, i) : ''; };
  // Resolve a source-relative path (handling ./ and ../) into a normalised id key.
  const joinNorm = (dir: string, rel: string) => {
    const parts = dir ? dir.split('/') : [];
    for (const seg of rel.split(/[\\/]/)) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return norm(parts.join('/'));
  };
  const byId = new Map<string, string>();
  const byBase = new Map<string, string | null>();
  const byTitle = new Map<string, string | null>();
  // First writer wins; a second writer marks the key ambiguous (null -> skip).
  const claim = (m: Map<string, string | null>, k: string, v: string) => {
    if (k) m.set(k, m.has(k) ? null : v);
  };
  for (const p of pages) {
    const nid = `page:${p.id}`;
    byId.set(norm(p.id), nid);
    claim(byBase, base(p.id), nid);
    claim(byTitle, norm(p.title), nid);
  }
  const edges: LinkEdge[] = [];
  const seenLink = new Set<string>();
  for (const p of pages) {
    const src = `page:${p.id}`;
    const srcDir = dirOf(p.id);
    for (const raw of p.links ?? []) {
      const n = norm(raw);
      let tgt = byId.get(n);
      if (!tgt && /[\\/]|\.md$/i.test(raw)) tgt = byId.get(joinNorm(srcDir, raw));
      if (!tgt) tgt = byBase.get(base(raw)) ?? undefined;
      if (!tgt) tgt = byTitle.get(n) ?? undefined;
      if (!tgt || tgt === src) continue;
      const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
      if (seenLink.has(key)) continue;
      seenLink.add(key);
      edges.push({ source: src, target: tgt, kind: 'link' });
    }
  }
  return edges;
}
