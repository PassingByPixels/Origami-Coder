// archetypeRefs.ts — Folds Board (lane D): reference cards for the
// archetypes (architect/ask/debug/orchestrator/scout/cartographer) that
// share the collab agent directory. Extracted straight out of
// collabAgentCrud.ts, which was AT its 200-line cap when this landed — the
// ratchet's remedy is a module, never a raised number (the same move
// collabAgentDef.ts made when the preset work hit that file's cap).
//
// The SAME directory holds two different things: collab-capable defs
// (`collab: true`, owned by collabAgentCrud.ts) and archetypes (`mode:` set,
// no `collab: true`, engine-shipped by agentManager/archetypes.ts). Nothing
// here creates, edits or deletes an archetype file wholesale —
// parseAgentDef/serializeAgentDef stay collab-only and are never called on
// one of these; the one write this module makes is a byte-surgical
// `model:` edit.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { globalAgentDir } from './agentManager/archetypes';

// Mirrors collabAgentCrud.ts's SLUG_RE exactly (a filename has the same
// survives-a-path-segment rule either side of the collab/archetype split) —
// a local copy rather than an import, so this module has no edge back into
// the one that already re-exports it (collabAgentCrud.ts -> archetypeRefs.ts
// only, never the reverse).
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ArchetypeDefRef {
  slug: string;
  description: string;
  /** `provider/model`, absent when the file pins none. */
  model?: string;
  mode: string;
  /** scout only: archetypes.ts SHIPS this file and reconciles a foreign one,
   *  but only once per marker generation (`if (opts.marker.get()) return`), so
   *  a pin here survives until the next upgrade — the card says exactly that
   *  and offers Set model like any other archetype. */
  managed: boolean;
  /** Absolute path to the .md — all "Open file" needs. */
  path: string;
}

const fileFor = (dir: string, slug: string): string => path.join(dir, `${slug}.md`);
const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * The same column-0-anchored scalar read collabAgentDef.ts's frontValue
 * takes, duplicated rather than imported (frontValue is private to that
 * module) — an archetype ref is deliberately never routed through
 * parseAgentDef, which refuses every file here for lacking `collab: true`.
 */
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
  // `vision-profile` joins `collab` on the same rule (t-kgtr6c): both are defs
  // this board OWNS an editor for, under their own tab. Without this line a
  // vision profile would list a second time as a read-only "reference agent"
  // and again in the sub-agent roster — one file, three places, two of them
  // wrong about what it is for.
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
 * the frontmatter span: replace an existing top-level `model:` line, or
 * insert one right after `description:` when absent. Everything before and
 * after that span (the `---` fences, the whole persona body) is untouched.
 *
 * UAT round 2 item 3: scout is NOT refused here any more. What makes scout
 * security-load-bearing is its PERMISSION block (ask/architect delegate to it
 * by name for the S12 laundering fix), and that block is not what this edit
 * touches — a `model:` line cannot re-grant a tool. The card carries the one
 * honest caveat instead: an upgrade may reset the file.
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
