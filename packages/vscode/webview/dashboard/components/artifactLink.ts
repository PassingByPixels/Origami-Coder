// artifactLink.ts — the chat's reading of `origami://artifact/<id>?v=<n>`.
//
// The engine writes this link into every artifact_publish and artifact_get
// result (packages/engine/src/tool/artifact.ts, `artifactLink`), and the
// model is told to paste it into its reply as `[title](link)`. The link is an
// ADDRESS, not a url: the page's loopback url has a per-version token and this
// engine run's port in it, so it is asked for at click time (`artifactOpen`,
// the same message the Artifacts pane's Open posts).
//
// Pure, so the parse can be tested without a DOM. MessageRow and ToolCard
// both read links through here and draw them with ArtifactCard.svelte.

export interface ArtifactLink {
  artifactId: string;
  version: number;
  /** The Markdown label, when the link had one. */
  title?: string;
}

/** Ids are `art_` + hex (store.ts `mintId`); the class is a little wider so an
 *  id from a later format still parses, but never wide enough to swallow a
 *  `)` or a space that ends the link. */
const HREF = /^origami:\/\/artifact\/([A-Za-z0-9_-]+)\?v=(\d+)$/;
const IN_TEXT = /(?:\[([^\]\n]*)\]\()?origami:\/\/artifact\/([A-Za-z0-9_-]+)\?v=(\d+)(?!\d)\)?/g;

/** One href, or undefined when it is not an artifact link. */
export function parseArtifactHref(href: string): ArtifactLink | undefined {
  const m = HREF.exec(href.trim());
  if (!m) return undefined;
  const version = Number(m[2]);
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  return { artifactId: m[1], version };
}

/** Every artifact link in a text, in order, one per id+version. The first
 *  label seen for a version is its title. */
export function findArtifactLinks(text: string): ArtifactLink[] {
  const out: ArtifactLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(IN_TEXT)) {
    const version = Number(m[3]);
    if (!Number.isSafeInteger(version) || version < 1) continue;
    const key = `${m[2]}?v=${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = m[1]?.trim();
    out.push({ artifactId: m[2], version, ...(title ? { title } : {}) });
  }
  return out;
}

/** The message the card's Open posts. Identical to the pane's, so the host
 *  opens it through the one path (artifactsPane.ts `open`). */
export function artifactOpenMessage(link: ArtifactLink): { type: 'artifactOpen'; artifactId: string; version: number } {
  return { type: 'artifactOpen', artifactId: link.artifactId, version: link.version };
}
