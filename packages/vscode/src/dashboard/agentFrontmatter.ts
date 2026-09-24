// agentFrontmatter.ts - reads the frontmatter of an agent-def file: the
// `---` block primitives only, no field names, no presets.
//
// Pure - no fs, no vscode.

/** The `---` … `---` block at the head of a def file, capture 1 = its body. */
export const FRONT_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Read one scalar key out of a frontmatter block.
 *
 * DELIBERATELY not a YAML parser: matches are anchored to column 0 so a
 * nested key is never mistaken for a top-level one.
 */
export function frontValue(front: string, key: string): string {
  const m = front.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return '';
  const raw = m[1].trim();
    // Quoted values are unwrapped; a description legitimately contains `:`.
  const q = raw.match(/^"([\s\S]*)"$/) ?? raw.match(/^'([\s\S]*)'$/);
  return (q ? q[1] : raw).replace(/\\"/g, '"');
}

/**
 * The `permission:` block: the `permission:` line plus every indented line
 * under it, stopping at the next column-0 key.
 */
export function permissionBlockIn(front: string): string {
  const lines = front.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^permission:/.test(line));
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++;
  // Trailing blank lines belong to the frontmatter, not to the block.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}
