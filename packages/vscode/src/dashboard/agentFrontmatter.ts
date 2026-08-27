// agentFrontmatter.ts - the frontmatter READER an agent-def file needs, split
// out of collabAgentDef.ts when the vision-profile work (t-kgtr6c) took that
// file past its cap.
//
// It is three primitives about `---` blocks and nothing about defs: no field
// names, no presets, no vision. That is what makes it the right seam - the
// caller decides what a key MEANS, this decides only what the file SAYS.
//
// Pure - no `fs`, no `vscode` - so every branch is exercised on strings.

/** The `---` … `---` block at the head of a def file, capture 1 = its body. */
export const FRONT_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Read one scalar key out of a frontmatter block.
 *
 * DELIBERATELY not a YAML parser. The only keys read back are the handful the
 * def serializer writes, all of them single-line scalars, and the permission
 * block below them is nested - a naive line scan would happily return `allow`
 * for a top-level `read:` that is really `permission.read`. So the match is
 * anchored to column 0 (`^key:` with no leading space), which the nested keys
 * never are.
 */
export function frontValue(front: string, key: string): string {
  const m = front.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return '';
  const raw = m[1].trim();
  // Quoted values are unwrapped; a description legitimately contains `:` and is
  // therefore always written quoted (see serializeAgentDef).
  const q = raw.match(/^"([\s\S]*)"$/) ?? raw.match(/^'([\s\S]*)'$/);
  return (q ? q[1] : raw).replace(/\\"/g, '"');
}

// There is no LIST reader here, and there is none in botContract.ts either any
// more: `skills:` and `model_prefer:` were the only list keys a def carried, and
// W6 stripped both. The remaining contract keys are single-line scalars.

/**
 * The `permission:` block: the top-level `permission:` line plus every INDENTED
 * line under it. It stops at the next column-0 key, so a def that lists
 * `permission:` before `model:` is read as correctly as one that lists it last.
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
