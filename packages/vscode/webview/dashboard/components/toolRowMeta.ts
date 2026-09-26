// toolRowMeta.ts — t-yyz5yk (Round 8): the short facts a tool ROW shows, read
// off data the card already has. Pure, so each rule is testable without a DOM.

/** A browser URL as host + muted path (Round 8 G). The full URL goes in the
 *  tooltip. A value that does not parse (a local HTML path) is shown whole. */
export function siteParts(url: string | undefined): { host: string; path: string } | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!u.host) return { host: '', path: url };
    const path = u.pathname === '/' ? '' : u.pathname;
    return { host: u.host, path };
  } catch {
    return { host: '', path: url };
  }
}

/** What an `artifact_get` result says about the version it read (Round 8 L).
 *  Read off the tool's own output lines (engine/src/tool/artifact.ts
 *  ArtifactGetTool: "version N of M.", "Opens at:", "- path (N bytes, type)").
 *  Any line that is missing leaves its fact out; no match at all = undefined,
 *  and the row shows what it showed before. */
export interface ArtifactFacts { version: number; latest: number; entry?: string; files: number; bytes: number; }
export function artifactFacts(result: string | undefined): ArtifactFacts | undefined {
  if (!result) return undefined;
  const head = /^Artifact \S+ ".*", version (\d+) of (\d+)\.$/m.exec(result);
  if (!head) return undefined;
  const entry = /^Opens at: (.+)$/m.exec(result)?.[1];
  // Only the "Files:" block (up to its blank line): the file BODIES follow it,
  // and a body line of the same shape must not count as a file.
  const lines = result.split('\n');
  const start = lines.indexOf('Files:');
  const files: RegExpExecArray[] = [];
  for (let i = start + 1; start >= 0 && i < lines.length && lines[i] !== ''; i++) {
    const m = /^- .+ \((\d+) bytes, [^)]+\)$/.exec(lines[i]);
    if (m) files.push(m);
  }
  return {
    version: Number(head[1]),
    latest: Number(head[2]),
    ...(entry ? { entry } : {}),
    files: files.length,
    bytes: files.reduce((sum, m) => sum + Number(m[1]), 0),
  };
}

/** Bytes as the row reads them: `240 KB`, `1.2 MB`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 100 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
