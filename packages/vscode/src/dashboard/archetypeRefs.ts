// archetypeRefs.ts — Folds Board: reference cards for archetypes
// (architect/ask/debug/orchestrator/scout/cartographer), which share the
// collab agent directory.
//
// The directory holds two different things: collab-capable defs (owned by
// collabAgentCrud.ts) and archetypes (engine-shipped). This module never
// creates, edits or deletes an archetype file wholesale — its one write is a
// byte-surgical `model:` edit.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globalAgentDir } from './agentManager/archetypes';

// Mirrors collabAgentCrud.ts's SLUG_RE (a filename has the same path-segment
// rule) as a local copy, not an import — the dependency runs one way.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ArchetypeDefRef {
  slug: string;
  description: string;
  /** `provider/model`, absent when the file pins none. */
  model?: string;
  mode: string;
  /** scout only: archetypes.ts reconciles a foreign file once per marker
   *  generation, so a pin here survives until the next upgrade. */
  managed: boolean;
  /** Absolute path to the .md — all "Open file" needs. */
  path: string;
}

const fileFor = (dir: string, slug: string): string => path.join(dir, `${slug}.md`);
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** The same column-0-anchored scalar read as frontValue, duplicated rather
 *  than imported since an archetype ref is never routed through parseAgentDef. */
function scanFront(front: string, key: string): string {
  const m = front.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return '';
  const raw = m[1].trim();
  const q = raw.match(/^"([\s\S]*)"$/) ?? raw.match(/^'([\s\S]*)'$/);
  return (q ? q[1] : raw).replace(/\\"/g, '"');
}

/** A *.md WITHOUT `collab: true` but WITH `mode:` is an archetype ref; a file
 *  with neither marker is junk and returns null, same as listCollabAgentDefs. */
export function parseArchetypeRef(slug: string, text: string): Omit<ArchetypeDefRef, 'path'> | null {
  const front = text.match(FRONT_RE)?.[1];
  // `vision-profile` joins `collab` on the same rule: both are defs this board
  // owns an editor for, or a def would list twice under the wrong tab.
  if (!front || scanFront(front, 'collab') === 'true' || scanFront(front, 'vision-profile') === 'true') return null;
  const mode = scanFront(front, 'mode');
  if (!mode) return null;
  const model = scanFront(front, 'model');
  return { slug, description: scanFront(front, 'description'), ...(model ? { model } : {}), mode, managed: slug === 'scout' };
}

/** Archetype ref cards, slug-sorted — same missing-dir-is-empty and
 *  one-bad-file-does-not-fail-the-listing rules as listCollabAgentDefs. */
export function listArchetypeRefs(dir = globalAgentDir()): ArchetypeDefRef[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ArchetypeDefRef[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const slug = name.slice(0, -3);
    try {
      const ref = parseArchetypeRef(slug, fs.readFileSync(path.join(dir, name), 'utf8'));
      if (ref) out.push({ ...ref, path: fileFor(dir, slug) });
    } catch {
      /* unreadable file - skip it, never fail the whole listing */
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Set (or clear) an archetype's `model:` — a byte-surgical edit confined to
 * the frontmatter span. Scout is not refused: its security-load-bearing
 * permission block is untouched by a `model:` edit; an upgrade may still
 * reset the file.
 */
export function setArchetypeModel(slug: string, model: string, dir = globalAgentDir()): string | null {
  if (!SLUG_RE.test(slug)) return `"${slug}" is not a valid agent name.`;
  const file = fileFor(dir, slug);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const m = text.match(FRONT_RE);
  const front = m?.[1] ?? '';
  if (!m || scanFront(front, 'collab') === 'true' || !scanFront(front, 'mode')) {
    return `No archetype named "${slug}".`;
  }
  const openLen = /^---\r?\n/.exec(m[0])![0].length;
  const start = (m.index ?? 0) + openLen;
  const modelLine = /^model:[^\r\n]*(\r?\n|$)/m;
  const descLine = /^(description:[^\r\n]*)(\r?\n|$)/m;
  let newFront: string;
  if (modelLine.test(front)) {
    newFront = model ? front.replace(modelLine, (_s, eol) => `model: ${model}${eol}`) : front.replace(modelLine, '');
  } else if (model) {
    newFront = front.replace(descLine, (_s, line, eol) => `${line}${eol}model: ${model}${eol}`);
  } else {
    return null; // nothing pinned, nothing to clear
  }
  if (newFront === front) return null;
  const out = text.slice(0, start) + newFront + text.slice(start + front.length);
  try {
    fs.writeFileSync(file, out, 'utf8');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
